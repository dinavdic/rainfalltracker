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

/**
 * GET /api/cron/update
 *
 * Fetches fresh rainfall + Kalshi data, computes probabilities, builds a
 * ForecastSnapshot, caches it in /tmp, and returns it in the response body.
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
    log.push(`[cron] Snapshot built and cached (${elapsed}ms total)`);

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
