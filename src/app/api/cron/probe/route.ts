import { NextRequest, NextResponse } from "next/server";
import { put, get } from "@vercel/blob";
import { STATIONS } from "@/lib/stations";
import { fetchNWSCLI, formatShortDate } from "@/lib/nws-cli";
import { KalshiApiResponse } from "@/lib/types";
import {
  ForecastSnapshot,
  StationSnapshot,
} from "@/lib/convergence";
import {
  loadServerSnapshots,
  saveServerSnapshot,
} from "@/lib/snapshot-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/probe
 *
 * Lightweight every-20-minutes probe for fresh data. Two checks:
 *
 * 1) New GEFS model run — makes a single small Open-Meteo request for
 *    Denver with forecast_days=1 and detects the run initialization
 *    time by finding the first hour where ensemble members diverge
 *    (members are identical in the hindcast tail and begin to differ
 *    at the first forecast step).
 *
 * 2) New NWS CLI publication — fetches the CLI for all stations on
 *    every probe run and compares the parsed data date against
 *    last-mtd.json in Blob.
 *
 * If EITHER check finds new data, fires a single internal call to
 * /api/cron/update so the dashboard picks it up within 20 minutes of
 * publication. Secured with the same CRON_SECRET bearer token.
 */

const PROBE_URL =
  "https://ensemble-api.open-meteo.com/v1/ensemble" +
  "?latitude=39.86&longitude=-104.67" +
  "&hourly=precipitation&models=gfs_seamless&forecast_days=1";

const RUN_STATE_BLOB_PATH = "snapshots/last-model-run.json";
const MTD_STATE_BLOB_PATH = "snapshots/last-mtd.json";
const NTFY_TOPIC_URL = "https://ntfy.sh/rainfall-din-updates";

function hasBlobToken(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function loadBlobJson<T>(path: string): Promise<T | null> {
  if (!hasBlobToken()) return null;
  try {
    const result = await get(path, { access: "private", useCache: false });
    if (!result || !result.stream) return null;
    return (await new Response(result.stream).json()) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not\s*found/i.test(msg)) {
      console.warn(`[probe] load ${path} failed: ${msg}`);
    }
    return null;
  }
}

async function saveBlobJson(path: string, value: unknown): Promise<void> {
  if (!hasBlobToken()) return;
  try {
    await put(path, JSON.stringify(value), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (e) {
    console.warn(
      `[probe] save ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- Model run probe ---

interface LastRunState {
  gefs: string | null;
  lastChecked: string;
}

/**
 * Find the first hour index where ensemble members differ from one
 * another by more than numerical noise. Before the run init time, all
 * members are identical (hindcast/analysis); at the first forecast
 * step they begin to diverge. Returns the ISO timestamp of that hour,
 * or null if no divergence was detected in the window.
 */
function detectRunTime(
  times: string[],
  memberSeries: (number | null)[][],
): string | null {
  if (!memberSeries.length) return null;
  const numHours = times.length;
  for (let i = 0; i < numHours; i++) {
    let minV = Infinity;
    let maxV = -Infinity;
    for (const series of memberSeries) {
      const v = series[i];
      if (v == null) continue;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (maxV - minV > 1e-6) {
      return times[i];
    }
  }
  return null;
}

function toRunLabel(ts: string | null): string {
  if (!ts) return "unknown";
  return `${ts.substring(11, 13)}z`;
}

async function fetchRunProbe(): Promise<{
  runTime: string | null;
  runLabel: string;
}> {
  const resp = await fetch(PROBE_URL, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    throw new Error(
      `Open-Meteo probe failed: ${resp.status} ${resp.statusText}`,
    );
  }
  const data = await resp.json();
  const hourly = data.hourly;
  if (!hourly?.time) {
    throw new Error("Probe response missing hourly.time");
  }

  const times: string[] = hourly.time;
  const memberKeys = Object.keys(hourly).filter((k) =>
    k.startsWith("precipitation_member"),
  );
  const memberSeries: (number | null)[][] = memberKeys.map((k) => hourly[k]);

  const runTime = detectRunTime(times, memberSeries);
  return { runTime, runLabel: toRunLabel(runTime) };
}

// --- MTD probe ---

interface StationMtdState {
  mtd: number;
  dataDate: string; // YYYY-MM-DD
  lastChecked: string;
}

type MtdStateMap = Record<string, StationMtdState>;

// --- Notifications ---

async function sendNotification(title: string, body: string): Promise<void> {
  try {
    await fetch(NTFY_TOPIC_URL, {
      method: "POST",
      headers: { Title: title },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn(
      `[probe] ntfy notification failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// --- Handler ---

export async function GET(request: NextRequest) {
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
  const nowDate = new Date();
  const nowIso = nowDate.toISOString();

  // --- 1. Model run probe ---
  let runProbe: { runTime: string | null; runLabel: string };
  try {
    runProbe = await fetchRunProbe();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[probe] ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const lastRunState = await loadBlobJson<LastRunState>(RUN_STATE_BLOB_PATH);
  const lastGefs = lastRunState?.gefs ?? null;
  const lastRunLabel = toRunLabel(lastGefs);
  const currentGefs = runProbe.runTime;

  await saveBlobJson(RUN_STATE_BLOB_PATH, {
    gefs: currentGefs,
    lastChecked: nowIso,
  });

  const runChanged = !!currentGefs && currentGefs !== lastGefs;
  if (runChanged) {
    const line = `[probe] New model run detected: ${lastRunLabel} -> ${runProbe.runLabel}, triggering full update`;
    console.log(line);
    log.push(line);
    await sendNotification(
      "New Model Run Detected",
      `New model run detected: ${lastRunLabel} → ${runProbe.runLabel}, full update triggered`,
    );
  } else if (!currentGefs) {
    const line = `[probe] Could not detect run time from probe response`;
    console.log(line);
    log.push(line);
  } else {
    const line = `[probe] No new run (still ${runProbe.runLabel})`;
    console.log(line);
    log.push(line);
  }

  // --- 2. MTD probe — check all stations every run ---
  const lastMtdState =
    (await loadBlobJson<MtdStateMap>(MTD_STATE_BLOB_PATH)) ?? {};
  const mtdUpdatedState: MtdStateMap = { ...lastMtdState };
  const mtdChanges: string[] = [];

  log.push(`[probe] Checking MTD for all ${STATIONS.length} stations`);
  for (const station of STATIONS) {
    try {
      const nws = await fetchNWSCLI(station.cliParams);
      if (nws.mtd === null || nws.dataDate === null) {
        log.push(
          `[probe] ${station.code}: NWS CLI parsed no MTD/date, skipping`,
        );
        continue;
      }
      const prev = lastMtdState[station.code];
      const prevDate = prev?.dataDate ?? null;
      const isNewer = prevDate === null || nws.dataDate > prevDate;

      if (isNewer) {
        const prevMtd = prev ? `${prev.mtd}` : "?";
        const line = `[probe] New MTD for ${station.code}: ${prevMtd} → ${nws.mtd} (${formatShortDate(nws.dataDate)})`;
        console.log(line);
        log.push(line);
        mtdChanges.push(
          `${station.code}: ${prevMtd} → ${nws.mtd} (${formatShortDate(nws.dataDate)})`,
        );
      }

      mtdUpdatedState[station.code] = {
        mtd: nws.mtd,
        dataDate: nws.dataDate,
        lastChecked: nowIso,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[probe] ${station.code}: NWS CLI fetch failed: ${msg}`);
      log.push(`[probe] ${station.code}: NWS CLI fetch failed: ${msg}`);
    }
  }

  // Persist MTD state (includes refreshed lastChecked for stations we hit)
  await saveBlobJson(MTD_STATE_BLOB_PATH, mtdUpdatedState);

  const mtdChanged = mtdChanges.length > 0;
  if (!mtdChanged) {
    const line = `[probe] No new MTD data`;
    console.log(line);
    log.push(line);
  }

  if (mtdChanged) {
    await sendNotification(
      "New CLI Report Published",
      mtdChanges.join("; "),
    );
  }

  // --- 3. Fire full update if either signal detected new data;
  //        otherwise save a price-only snapshot so we capture Kalshi
  //        price observations at the probe cadence. ---
  if (!runChanged && !mtdChanged) {
    const origin = request.nextUrl.origin;
    let priceSnapshotSaved = false;
    let priceSnapshotError: string | undefined;

    try {
      // Fetch fresh Kalshi prices.
      const kalshiResp = await fetch(`${origin}/api/fetch-kalshi`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!kalshiResp.ok) {
        throw new Error(
          `/api/fetch-kalshi returned ${kalshiResp.status} ${kalshiResp.statusText}`,
        );
      }
      const kalshi = (await kalshiResp.json()) as KalshiApiResponse;

      // Load the most recent full snapshot for ensemble probs to carry forward.
      const history = await loadServerSnapshots();
      const latest = history.length > 0 ? history[history.length - 1] : null;

      if (!latest) {
        const line = `[probe] No prior snapshot to carry forward; skipping price-only snapshot`;
        console.log(line);
        log.push(line);
      } else {
        const stations: Record<string, StationSnapshot> = {};
        for (const [code, prevStation] of Object.entries(latest.stations)) {
          // Carry forward all ensemble fields from the latest snapshot.
          const next: StationSnapshot = {
            ...prevStation,
            thresholds: { ...prevStation.thresholds },
          };

          // Overwrite kalshiPrices with current mid-prices.
          const kalshiStation = kalshi.stations?.[code];
          if (kalshiStation) {
            const prices: Record<string, number> = {};
            for (const [thresh, mkt] of Object.entries(
              kalshiStation.thresholds,
            )) {
              let mid: number | null = null;
              if (mkt.yesBid !== null && mkt.yesAsk !== null) {
                mid = (mkt.yesBid + mkt.yesAsk) / 2;
              } else if (mkt.lastPrice !== null) {
                mid = mkt.lastPrice;
              }
              if (mid !== null) {
                prices[thresh] = Math.round(mid * 100) / 100;
              }
            }
            if (Object.keys(prices).length > 0) {
              next.kalshiPrices = prices;
            } else {
              delete next.kalshiPrices;
            }
          }

          stations[code] = next;
        }

        const snapshot: ForecastSnapshot = {
          timestamp: nowIso,
          stations,
        };
        await saveServerSnapshot(snapshot);
        priceSnapshotSaved = true;
        const line = `[probe] Price snapshot saved (no model/MTD change)`;
        console.log(line);
        log.push(line);
      }
    } catch (e) {
      priceSnapshotError = e instanceof Error ? e.message : String(e);
      const line = `[probe] Price snapshot failed: ${priceSnapshotError}`;
      console.warn(line);
      log.push(line);
    }

    return NextResponse.json({
      ok: true,
      runChanged,
      mtdChanged,
      currentGefs,
      lastGefs,
      priceSnapshotSaved,
      priceSnapshotError,
      log,
      elapsedMs: Date.now() - startMs,
    });
  }

  const fullTriggerLine = `[probe] Full update triggered`;
  console.log(fullTriggerLine);
  log.push(fullTriggerLine);

  try {
    const origin = request.nextUrl.origin;
    const updateResp = await fetch(`${origin}/api/cron/update`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(120000),
    });
    log.push(`[probe] /api/cron/update returned ${updateResp.status}`);
    return NextResponse.json({
      ok: updateResp.ok,
      runChanged,
      mtdChanged,
      mtdChanges,
      currentGefs,
      lastGefs,
      updateTriggered: true,
      updateStatus: updateResp.status,
      log,
      elapsedMs: Date.now() - startMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`[probe] update trigger failed: ${msg}`);
    return NextResponse.json(
      {
        ok: false,
        runChanged,
        mtdChanged,
        mtdChanges,
        currentGefs,
        lastGefs,
        updateTriggered: false,
        error: msg,
        log,
        elapsedMs: Date.now() - startMs,
      },
      { status: 500 },
    );
  }
}
