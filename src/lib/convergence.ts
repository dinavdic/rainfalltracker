import { RainfallApiResponse, StationProbabilities } from "./types";

// --- Snapshot types ---

export interface StationSnapshot {
  mtd: number | null;
  gefsMedian: number | null;
  ecmwfMedian: number | null;
  gefsP25: number | null;
  gefsP75: number | null;
  ecmwfP25: number | null;
  ecmwfP75: number | null;
  thresholds: Record<
    string,
    { gefsProb: number | null; ecmwfProb: number | null; combinedProb: number }
  >;
}

export interface ForecastSnapshot {
  timestamp: string; // ISO 8601
  stations: Record<string, StationSnapshot>;
}

// --- Convergence metric types ---

export type ConvergenceSignal = "converging" | "diverging" | "stable";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface StationConvergence {
  qpfDivergence: number; // |GEFS_median - ECMWF_median| in inches
  emaTrend: number | null; // 24h EMA of divergence; null if < 2 snapshots
  convergenceSignal: ConvergenceSignal;
  confidenceLevel: ConfidenceLevel;
}

const STORAGE_KEY = "rainfall-tracker-snapshots";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEDUP_MS = 4 * 60 * 60 * 1000; // 4 hours
const EMA_TAU_MS = 24 * 60 * 60 * 1000; // 24-hour time constant

// --- localStorage helpers ---

export function loadSnapshots(): ForecastSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ForecastSnapshot[];
  } catch {
    return [];
  }
}

function persistSnapshots(snapshots: ForecastSnapshot[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

// --- Snapshot creation ---

/**
 * Build and save a snapshot from the current fetch results.
 * Deduplicates within 4 hours and prunes entries older than 7 days.
 */
export function saveSnapshot(
  rainfall: RainfallApiResponse,
  stationProbs: Record<string, StationProbabilities>,
): void {
  const now = new Date();
  const snapshot: ForecastSnapshot = {
    timestamp: now.toISOString(),
    stations: {},
  };

  for (const [code, rainData] of Object.entries(rainfall.stations)) {
    const ens = rainData.ensemble;
    const probs = stationProbs[code];

    const stationSnap: StationSnapshot = {
      mtd: rainData.mtd,
      gefsMedian: ens?.modelBreakdown?.gefs.median ?? null,
      ecmwfMedian: ens?.modelBreakdown?.ecmwf.median ?? null,
      gefsP25: ens?.modelBreakdown?.gefs.p25 ?? null,
      gefsP75: ens?.modelBreakdown?.gefs.p75 ?? null,
      ecmwfP25: ens?.modelBreakdown?.ecmwf.p25 ?? null,
      ecmwfP75: ens?.modelBreakdown?.ecmwf.p75 ?? null,
      thresholds: {},
    };

    if (probs) {
      for (const t of probs.thresholds) {
        stationSnap.thresholds[t.threshold.toFixed(1)] = {
          gefsProb: t.gefsProb,
          ecmwfProb: t.ecmwfProb,
          combinedProb: t.ensembleProbability,
        };
      }
    }

    snapshot.stations[code] = stationSnap;
  }

  // Load existing, prune old, deduplicate, append
  let snapshots = loadSnapshots();

  const cutoff = now.getTime() - MAX_AGE_MS;
  snapshots = snapshots.filter((s) => new Date(s.timestamp).getTime() > cutoff);

  // Deduplicate: if the most recent snapshot is within 4 hours, replace it
  if (snapshots.length > 0) {
    const last = new Date(snapshots[snapshots.length - 1].timestamp).getTime();
    if (now.getTime() - last < DEDUP_MS) {
      snapshots[snapshots.length - 1] = snapshot;
    } else {
      snapshots.push(snapshot);
    }
  } else {
    snapshots.push(snapshot);
  }

  persistSnapshots(snapshots);
}

// --- Convergence computation ---

/**
 * Compute convergence metrics for a station from snapshot history.
 * Returns null if the station has no model breakdown data in the latest snapshot.
 */
export function computeConvergence(
  stationCode: string,
  snapshots: ForecastSnapshot[],
): StationConvergence | null {
  if (snapshots.length === 0) return null;

  const latest = snapshots[snapshots.length - 1].stations[stationCode];
  if (!latest || latest.gefsMedian === null || latest.ecmwfMedian === null) {
    return null;
  }

  const qpfDivergence = Math.abs(latest.gefsMedian - latest.ecmwfMedian);

  // Build divergence time series from all snapshots that have both medians
  const series: { t: number; div: number }[] = [];
  for (const snap of snapshots) {
    const st = snap.stations[stationCode];
    if (st?.gefsMedian !== null && st?.ecmwfMedian !== null) {
      series.push({
        t: new Date(snap.timestamp).getTime(),
        div: Math.abs(st.gefsMedian! - st.ecmwfMedian!),
      });
    }
  }

  // Compute 24-hour EMA
  let emaTrend: number | null = null;
  let convergenceSignal: ConvergenceSignal = "stable";

  if (series.length >= 2) {
    // Sort by time (should already be sorted, but be safe)
    series.sort((a, b) => a.t - b.t);

    let ema = series[0].div;
    let prevEma = ema;

    for (let i = 1; i < series.length; i++) {
      const dt = series[i].t - series[i - 1].t;
      const alpha = 1 - Math.exp(-dt / EMA_TAU_MS);
      prevEma = ema;
      ema = alpha * series[i].div + (1 - alpha) * ema;
    }

    emaTrend = ema;

    const emaDelta = ema - prevEma;
    if (emaDelta < -0.05) {
      convergenceSignal = "converging";
    } else if (emaDelta > 0.05) {
      convergenceSignal = "diverging";
    }
  }

  // Confidence level based on normalized divergence
  // Normalize by average of the two medians (min 0.01 to avoid division by zero)
  const avgMedian = Math.max(
    0.01,
    (latest.gefsMedian + latest.ecmwfMedian) / 2,
  );
  const normalizedDiv = qpfDivergence / avgMedian;

  let confidenceLevel: ConfidenceLevel;
  if (normalizedDiv < 0.15) {
    confidenceLevel = "high";
  } else if (normalizedDiv > 0.4) {
    confidenceLevel = "low";
  } else {
    confidenceLevel = "medium";
  }

  return {
    qpfDivergence: Math.round(qpfDivergence * 100) / 100,
    emaTrend: emaTrend !== null ? Math.round(emaTrend * 1000) / 1000 : null,
    convergenceSignal,
    confidenceLevel,
  };
}

/**
 * Compute convergence metrics for all stations.
 */
export function computeAllConvergence(
  snapshots: ForecastSnapshot[],
): Record<string, StationConvergence> {
  if (snapshots.length === 0) return {};

  const latest = snapshots[snapshots.length - 1];
  const result: Record<string, StationConvergence> = {};

  for (const code of Object.keys(latest.stations)) {
    const metrics = computeConvergence(code, snapshots);
    if (metrics) {
      result[code] = metrics;
    }
  }

  return result;
}
