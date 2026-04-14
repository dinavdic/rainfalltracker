import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  RainfallApiResponse,
  KalshiApiResponse,
  HistoricalData,
  StationProbabilities,
  EnsoPhase,
} from "@/lib/types";
import { computeProbabilities } from "@/lib/probability";
import { STATIONS } from "@/lib/stations";
import { buildSnapshot } from "@/lib/convergence";
import { saveServerSnapshot } from "@/lib/snapshot-store";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // seconds — ensemble fetches can be slow

// Must match Dashboard.tsx
const CURRENT_ENSO_PHASE: EnsoPhase = "neutral";

const NTFY_TOPIC_URL = "https://ntfy.sh/rainfall-din-updates";

/**
 * Convert a run label like "12z" into hours-ago-from-now, matching the
 * resolution logic used by the dashboard header's Model age badge.
 */
function modelAgeLabel(runLabels: (string | null | undefined)[]): string {
  const now = new Date();
  let oldestMs: number | null = null;
  for (const label of runLabels) {
    if (!label) continue;
    const m = label.match(/^(\d{1,2})z$/i);
    if (!m) continue;
    const hour = parseInt(m[1], 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
    const candidate = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        hour,
        0,
        0,
      ),
    );
    if (candidate.getTime() > now.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }
    const ageMs = now.getTime() - candidate.getTime();
    if (oldestMs === null || ageMs > oldestMs) oldestMs = ageMs;
  }
  if (oldestMs === null) return "unknown";
  const totalMinutes = Math.max(0, Math.floor(oldestMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Find the station+threshold with the largest |edge| across the snapshot,
 * where edge = ensemble_probability - kalshi_mid_price (both in percent).
 * Returns a formatted label like 'DEN >1" +32', or null if no edges exist.
 */
function computeTopEdge(
  stationProbs: Record<string, StationProbabilities>,
  kalshi: KalshiApiResponse | null,
): string | null {
  if (!kalshi) return null;
  let bestLabel: string | null = null;
  let bestAbs = 0;
  let bestSigned = 0;
  for (const [code, probs] of Object.entries(stationProbs)) {
    const station = kalshi.stations[code];
    if (!station) continue;
    for (const t of probs.thresholds) {
      const price = station.thresholds[t.threshold.toFixed(1)];
      if (!price) continue;
      let marketPct: number | null = null;
      if (price.yesBid !== null && price.yesAsk !== null) {
        marketPct = (price.yesBid + price.yesAsk) / 2;
      } else if (price.lastPrice !== null) {
        marketPct = price.lastPrice;
      }
      if (marketPct === null) continue;
      const edge = t.ensembleProbability * 100 - marketPct;
      const absEdge = Math.abs(edge);
      if (absEdge > bestAbs) {
        bestAbs = absEdge;
        bestSigned = edge;
        const threshLabel = `>${t.threshold.toFixed(t.threshold % 1 === 0 ? 0 : 1)}"`;
        bestLabel = `${code} ${threshLabel}`;
      }
    }
  }
  if (!bestLabel) return null;
  const sign = bestSigned >= 0 ? "+" : "";
  return `${bestLabel} ${sign}${Math.round(bestSigned)}`;
}

async function sendUpdateNotification(body: string): Promise<void> {
  try {
    await fetch(NTFY_TOPIC_URL, {
      method: "POST",
      headers: { Title: "Rainfall Tracker Updated" },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    // Non-fatal — a notification failure must not break the cron
    console.warn(
      `[cron] ntfy notification failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * GET /api/cron/update
 *
 * Fetches fresh rainfall + Kalshi data, computes probabilities, builds a
 * ForecastSnapshot, persists it to Vercel Blob (with /tmp as a warm cache),
 * and returns it in the response body.
 *
 * The snapshot is returned so that:
 *   - The Dashboard can merge it into localStorage on next visit
 *   - External monitoring can verify the cron is producing valid data
 *
 * Secured with a bearer token from CRON_SECRET env var.
 * Called by:
 *   - Vercel Cron (daily at noon UTC)
 *   - cron-job.org (every 6 hours)
 */
export async function GET(request: NextRequest) {
  // --- Auth ---
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startMs = Date.now();
  const log: string[] = [];
  log.push(`[cron] Starting update at ${new Date().toISOString()}`);

  try {
    // --- Fetch rainfall and Kalshi via internal API routes ---
    const origin = request.nextUrl.origin;

    const [rainResult, kalshiResult] = await Promise.allSettled([
      fetch(`${origin}/api/fetch-rainfall`),
      fetch(`${origin}/api/fetch-kalshi`),
    ]);

    let kalshi: KalshiApiResponse | null = null;

    if (rainResult.status !== "fulfilled" || !rainResult.value.ok) {
      const reason =
        rainResult.status === "rejected"
          ? rainResult.reason
          : `HTTP ${rainResult.value.status}`;
      log.push(`[cron] Rainfall fetch failed: ${reason}`);
      return NextResponse.json(
        { error: "Rainfall fetch failed", detail: String(reason), log },
        { status: 502 },
      );
    }

    const rainfall: RainfallApiResponse = await rainResult.value.json();
    log.push(`[cron] Rainfall fetched: ${Object.keys(rainfall.stations).length} stations`);

    if (kalshiResult.status === "fulfilled" && kalshiResult.value.ok) {
      kalshi = await kalshiResult.value.json();
      log.push(`[cron] Kalshi fetched: ${Object.keys(kalshi!.stations).length} stations`);
    } else {
      log.push("[cron] Kalshi fetch failed (non-fatal, continuing without market data)");
    }

    // --- Load historical data for probability computation ---
    const histPath = path.join(
      process.cwd(),
      "public",
      "data",
      "historical-distributions.json",
    );
    const histRaw = await fs.readFile(histPath, "utf-8");
    const historical: HistoricalData = JSON.parse(histRaw);

    // --- Compute probabilities ---
    const now = new Date();
    const month = now.getMonth() + 1;
    const dayOfMonth = now.getDate();

    const stationProbs: Record<string, StationProbabilities> = {};
    for (const station of STATIONS) {
      const rainData = rainfall.stations[station.code];
      if (!rainData) continue;

      stationProbs[station.code] = computeProbabilities(
        station.code,
        month,
        dayOfMonth,
        rainData.mtd ?? 0,
        rainData.ensemble,
        rainData.qpfSum,
        historical,
        CURRENT_ENSO_PHASE,
      );
    }

    log.push(`[cron] Probabilities computed for ${Object.keys(stationProbs).length} stations`);

    // --- Build snapshot, cache to /tmp, return in response ---
    const snapshot = buildSnapshot(rainfall, stationProbs, kalshi);

    await saveServerSnapshot(snapshot);

    const elapsed = Date.now() - startMs;
    log.push(`[cron] Snapshot built and persisted to Blob + /tmp (${elapsed}ms total)`);

    // --- Push notification (non-fatal on failure) ---
    const stationCount = Object.keys(snapshot.stations).length;
    const runLabels: (string | null | undefined)[] = [];
    for (const s of Object.values(rainfall.stations)) {
      runLabels.push(s.ensemble?.modelRuns?.gefs, s.ensemble?.modelRuns?.ecmwf);
    }
    const modelAge = modelAgeLabel(runLabels);
    const topEdge = computeTopEdge(stationProbs, kalshi);
    const topEdgeText = topEdge ?? "n/a";
    const body =
      `${stationCount} stations updated. ` +
      `Model age: ${modelAge}. Top edge: ${topEdgeText}`;
    await sendUpdateNotification(body);
    log.push(`[cron] Notification sent (${body})`);

    for (const line of log) {
      console.log(line);
    }

    return NextResponse.json({
      ok: true,
      timestamp: snapshot.timestamp,
      stations: Object.keys(snapshot.stations).length,
      hasKalshi: kalshi !== null,
      elapsedMs: elapsed,
      snapshot,
      log,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`[cron] Fatal error: ${msg}`);
    for (const line of log) {
      console.error(line);
    }
    return NextResponse.json({ error: msg, log }, { status: 500 });
  }
}
