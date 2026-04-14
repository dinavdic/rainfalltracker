import { NextRequest, NextResponse } from "next/server";
import { put, get } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/cron/probe
 *
 * Lightweight every-20-minutes check for a fresh GEFS model run. Makes
 * a single small Open-Meteo request for Denver with forecast_days=1,
 * detects the run initialization time by finding the first hour where
 * ensemble members diverge (members are identical in the hindcast tail
 * and begin to differ at the first forecast step), and compares that
 * timestamp against the last known run stored in Blob.
 *
 * If the run has changed, calls /api/cron/update internally to refresh
 * all stations and persist a new snapshot. If unchanged, exits quickly.
 *
 * Secured with the same CRON_SECRET bearer token as /api/cron/update.
 */

const PROBE_URL =
  "https://ensemble-api.open-meteo.com/v1/ensemble" +
  "?latitude=39.86&longitude=-104.67" +
  "&hourly=precipitation&models=gfs_seamless&forecast_days=1";

const STATE_BLOB_PATH = "snapshots/last-model-run.json";

interface LastRunState {
  gefs: string | null; // ISO timestamp of detected run init
  lastChecked: string;
}

function hasBlobToken(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function loadLastRun(): Promise<LastRunState | null> {
  if (!hasBlobToken()) return null;
  try {
    const result = await get(STATE_BLOB_PATH, {
      access: "private",
      useCache: false,
    });
    if (!result || !result.stream) return null;
    return (await new Response(result.stream).json()) as LastRunState;
  } catch (e) {
    // Not-found on first run is expected — don't spam warnings
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not\s*found/i.test(msg)) {
      console.warn(`[probe] load state failed: ${msg}`);
    }
    return null;
  }
}

async function saveLastRun(state: LastRunState): Promise<void> {
  if (!hasBlobToken()) return;
  try {
    await put(STATE_BLOB_PATH, JSON.stringify(state), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (e) {
    console.warn(
      `[probe] save state failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
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

async function fetchProbe(): Promise<{
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

  let probe: { runTime: string | null; runLabel: string };
  try {
    probe = await fetchProbe();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[probe] ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const lastState = await loadLastRun();
  const lastGefs = lastState?.gefs ?? null;
  const lastLabel = toRunLabel(lastGefs);
  const currentGefs = probe.runTime;
  const now = new Date().toISOString();

  // Always refresh lastChecked so we can see the probe is alive in Blob
  await saveLastRun({ gefs: currentGefs, lastChecked: now });

  // No divergence detected — can't reliably tell if run is new, skip
  if (!currentGefs) {
    const line = `[probe] Could not detect run time from probe response, skipping`;
    console.log(line);
    log.push(line);
    return NextResponse.json({
      ok: true,
      changed: false,
      current: null,
      last: lastGefs,
      log,
      elapsedMs: Date.now() - startMs,
    });
  }

  if (currentGefs === lastGefs) {
    const line = `[probe] No new run (still ${probe.runLabel}), skipping`;
    console.log(line);
    log.push(line);
    return NextResponse.json({
      ok: true,
      changed: false,
      current: currentGefs,
      last: lastGefs,
      log,
      elapsedMs: Date.now() - startMs,
    });
  }

  const line = `[probe] New model run detected: ${lastLabel} -> ${probe.runLabel}, triggering full update`;
  console.log(line);
  log.push(line);

  // Trigger the full update internally, carrying the cron secret
  try {
    const origin = request.nextUrl.origin;
    const updateResp = await fetch(`${origin}/api/cron/update`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(120000),
    });
    log.push(`[probe] /api/cron/update returned ${updateResp.status}`);
    return NextResponse.json({
      ok: updateResp.ok,
      changed: true,
      current: currentGefs,
      last: lastGefs,
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
        changed: true,
        current: currentGefs,
        last: lastGefs,
        updateTriggered: false,
        error: msg,
        log,
        elapsedMs: Date.now() - startMs,
      },
      { status: 500 },
    );
  }
}
