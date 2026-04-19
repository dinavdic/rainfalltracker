import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  RainfallApiResponse,
  KalshiApiResponse,
  PolymarketApiResponse,
  HistoricalData,
  StationProbabilities,
  EnsoPhase,
} from "@/lib/types";
import { computeProbabilities } from "@/lib/probability";
import { STATIONS } from "@/lib/stations";
import { buildSnapshot } from "@/lib/convergence";
import {
  saveServerSnapshot,
  loadServerSnapshots,
} from "@/lib/snapshot-store";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // seconds — ensemble fetches can be slow

// Must match Dashboard.tsx
const CURRENT_ENSO_PHASE: EnsoPhase = "neutral";

// Reference station for lightweight model-run checks
const REF_STATION = { lat: 47.61, lon: -122.33 }; // SEA
const OPEN_METEO_ENSEMBLE_BASE =
  "https://ensemble-api.open-meteo.com/v1/ensemble";

interface ModelFingerprint {
  gefs: number;
  ecmwf: number;
}

async function fetchModelFingerprint(
  log: string[],
): Promise<ModelFingerprint> {
  const { lat, lon } = REF_STATION;

  const gefsUrl =
    `${OPEN_METEO_ENSEMBLE_BASE}?latitude=${lat}&longitude=${lon}` +
    `&models=gfs_seamless&hourly=precipitation&forecast_days=1`;
  const gefsResp = await fetch(gefsUrl, { signal: AbortSignal.timeout(10000) });
  if (!gefsResp.ok) throw new Error(`GEFS meta fetch: ${gefsResp.status}`);
  const gefsData = await gefsResp.json();
  const gefsMem =
    (gefsData.hourly?.precipitation_member00 as (number | null)[]) ?? [];
  const gefsFp = gefsMem
    .slice(0, 24)
    .reduce((a: number, b: number | null) => a + (b ?? 0), 0);

  await new Promise((r) => setTimeout(r, 1000));

  const ecmwfUrl =
    `${OPEN_METEO_ENSEMBLE_BASE}?latitude=${lat}&longitude=${lon}` +
    `&models=ecmwf_ifs025&hourly=precipitation&forecast_days=1`;
  const ecmwfResp = await fetch(ecmwfUrl, {
    signal: AbortSignal.timeout(10000),
  });
  if (!ecmwfResp.ok) throw new Error(`ECMWF meta fetch: ${ecmwfResp.status}`);
  const ecmwfData = await ecmwfResp.json();
  const ecmwfMem =
    (ecmwfData.hourly?.precipitation_member00 as (number | null)[]) ?? [];
  const ecmwfFp = ecmwfMem
    .slice(0, 24)
    .reduce((a: number, b: number | null) => a + (b ?? 0), 0);

  const fp = {
    gefs: Math.round(gefsFp * 100) / 100,
    ecmwf: Math.round(ecmwfFp * 100) / 100,
  };
  log.push(
    `[update] Model fingerprint: GEFS=${fp.gefs} ECMWF=${fp.ecmwf}`,
  );
  return fp;
}

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
 * Flush the log array to console so Vercel Runtime Logs capture it.
 * Called at EVERY return point to prevent silent failures.
 */
function flushLog(log: string[]): void {
  for (const line of log) console.log(line);
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
 * Called by Vercel Cron during model release windows (16 times/day).
 * Checks for new model data before running the expensive ensemble fetch.
 */
export async function GET(request: NextRequest) {
  // Immediate console.log so Vercel logs show the function was invoked,
  // even if it crashes before the log array is flushed.
  console.log(`[update] === CRON HANDLER INVOKED === ${new Date().toISOString()}`);

  // --- Auth ---
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.log("[update] CRON_SECRET not configured, returning 500");
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("authorization");
  const received = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader ?? null;
  console.log(
    `[update] auth: received=${received?.slice(0, 8) ?? "null"} ` +
      `expected=${process.env.CRON_SECRET?.slice(0, 8) ?? "null"} ` +
      `rawHeaderLen=${authHeader?.length ?? 0} ` +
      `receivedLen=${received?.length ?? 0} ` +
      `expectedLen=${secret.length}`,
  );
  if (received !== secret) {
    console.log(
      `[update] Auth failed: header=${authHeader ? "present but wrong" : "missing"}`,
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startMs = Date.now();
  const log: string[] = [];
  log.push(`[update] Cron fired at ${new Date().toISOString()}`);
  log.push(`[update] Auth passed`);

  try {
    // --- Lightweight model-run check ---
    // Fetch one day of data for a reference station from each model.
    // Compare a data fingerprint to the last snapshot to detect new runs.
    let newFingerprint: ModelFingerprint | null = null;
    try {
      newFingerprint = await fetchModelFingerprint(log);

      const latestSnapshots = await loadServerSnapshots(1);
      const lastSnapshot = latestSnapshots[0] ?? null;
      const prev = lastSnapshot?.dataFingerprint ?? null;

      // Detailed fingerprint comparison logging
      log.push(
        `[update] Fingerprint check: current={gefs:${newFingerprint.gefs}, ecmwf:${newFingerprint.ecmwf}}` +
        `, saved=${prev ? `{gefs:${prev.gefs}, ecmwf:${prev.ecmwf}}` : "null"}` +
        `, lastSnapshotTs=${lastSnapshot?.timestamp ?? "none"}` +
        `, lastSnapshotHasModelRuns=${!!lastSnapshot?.modelRuns}`,
      );

      const willSkip = !!prev && prev.gefs === newFingerprint.gefs && prev.ecmwf === newFingerprint.ecmwf;
      log.push(`[update] Fingerprint check: will_skip=${willSkip}`);

      if (willSkip) {
        const runs = lastSnapshot?.modelRuns;
        const gefsLabel = runs?.gefs ?? "?";
        const ecmwfLabel = runs?.ecmwf ?? "?";
        log.push(
          `[update] No new model run (GEFS=${gefsLabel} ECMWF=${ecmwfLabel}), skipping`,
        );
        flushLog(log);
        return NextResponse.json({
          ok: true,
          skipped: true,
          reason: "no_new_model_run",
          log,
        });
      }

      if (prev) {
        const changes: string[] = [];
        if (prev.gefs !== newFingerprint.gefs) changes.push("GEFS");
        if (prev.ecmwf !== newFingerprint.ecmwf) changes.push("ECMWF");
        log.push(`[update] New model data detected (${changes.join("+")}), proceeding`);
      } else {
        log.push(`[update] No previous fingerprint (saved=null), proceeding with full update`);
      }
    } catch (e) {
      log.push(
        `[update] Fingerprint check failed (${e instanceof Error ? e.message : String(e)}), proceeding anyway`,
      );
    }

    // --- Fetch rainfall and Kalshi via internal API routes ---
    const origin = request.nextUrl.origin;
    log.push(`[update] Internal fetch origin: ${origin}`);

    const [rainResult, kalshiResult, polymarketResult] = await Promise.allSettled([
      fetch(`${origin}/api/fetch-rainfall`),
      fetch(`${origin}/api/fetch-kalshi`),
      fetch(`${origin}/api/fetch-polymarket`),
    ]);

    // Log status of each internal fetch
    log.push(
      `[update] fetch-rainfall: ${rainResult.status === "fulfilled" ? `HTTP ${rainResult.value.status}` : `rejected: ${rainResult.reason}`}`,
    );
    log.push(
      `[update] fetch-kalshi: ${kalshiResult.status === "fulfilled" ? `HTTP ${kalshiResult.value.status}` : `rejected: ${kalshiResult.reason}`}`,
    );
    log.push(
      `[update] fetch-polymarket: ${polymarketResult.status === "fulfilled" ? `HTTP ${polymarketResult.value.status}` : `rejected: ${polymarketResult.reason}`}`,
    );

    let kalshi: KalshiApiResponse | null = null;
    let polymarket: PolymarketApiResponse | null = null;

    if (rainResult.status !== "fulfilled" || !rainResult.value.ok) {
      const reason =
        rainResult.status === "rejected"
          ? rainResult.reason
          : `HTTP ${rainResult.value.status}`;
      log.push(`[cron] Rainfall fetch failed: ${reason}`);
      flushLog(log);
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

    if (polymarketResult.status === "fulfilled" && polymarketResult.value.ok) {
      polymarket = await polymarketResult.value.json();
      log.push(
        `[cron] Polymarket fetched: ${polymarket?.outcomes.length ?? 0} NYC buckets`,
      );
    } else {
      log.push("[cron] Polymarket fetch failed (non-fatal, continuing without NYC buckets)");
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
    log.push(`[cron] Historical data loaded`);

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

    // --- Build snapshot, attach fingerprint, persist ---
    const snapshot = buildSnapshot(rainfall, stationProbs, kalshi, polymarket);
    if (newFingerprint) {
      snapshot.dataFingerprint = newFingerprint;
    }

    log.push(
      `[cron] Snapshot built: modelRuns=${JSON.stringify(snapshot.modelRuns)}` +
      `, fingerprint=${JSON.stringify(snapshot.dataFingerprint)}` +
      `, stations=${Object.keys(snapshot.stations).length}`,
    );

    await saveServerSnapshot(snapshot);

    const elapsed = Date.now() - startMs;
    log.push(`[cron] Snapshot persisted to Blob (${elapsed}ms total)`);

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

    flushLog(log);

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
    flushLog(log);
    return NextResponse.json({ error: msg, log }, { status: 500 });
  }
}
