import {
  RainfallApiResponse,
  StationProbabilities,
  KalshiApiResponse,
} from "./types";

// --- Snapshot types ---

export interface StationSnapshot {
  mtd: number | null;
  gefsMedian: number | null;
  ecmwfMedian: number | null;
  gefsP25: number | null;
  gefsP75: number | null;
  ecmwfP25: number | null;
  ecmwfP75: number | null;
  // Combined ensemble distribution (all 82 members)
  combinedMedian: number | null;
  combinedIQR: number | null; // p75 - p25
  combinedP10: number | null;
  combinedP90: number | null;
  thresholds: Record<
    string,
    { gefsProb: number | null; ecmwfProb: number | null; combinedProb: number }
  >;
  // Kalshi mid-prices in cents (0-100); absent if Kalshi data unavailable
  kalshiPrices?: Record<string, number>;
}

export interface ForecastSnapshot {
  timestamp: string; // ISO 8601
  stations: Record<string, StationSnapshot>;
}

// --- Convergence metric types ---

export type ConvergenceSignal = "converging" | "diverging" | "stable";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface StationConvergence {
  qpfDivergence: number; // |GEFS_median - ECMWF_median| in inches (for display)
  maxThresholdDivergence: number; // max |gefsProb - ecmwfProb| across Kalshi thresholds (0-1)
  emaTrend: number | null; // 24h EMA of maxThresholdDivergence; null if < 2 snapshots
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
  kalshi?: KalshiApiResponse | null,
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
      combinedMedian: ens?.stats.median ?? null,
      combinedIQR: ens ? (ens.stats.p75 - ens.stats.p25) : null,
      combinedP10: ens?.stats.p10 ?? null,
      combinedP90: ens?.stats.p90 ?? null,
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

    // Store Kalshi mid-prices in cents
    const kalshiStation = kalshi?.stations[code];
    if (kalshiStation) {
      const prices: Record<string, number> = {};
      for (const [thresh, mkt] of Object.entries(kalshiStation.thresholds)) {
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
        stationSnap.kalshiPrices = prices;
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
 * Compute max |gefsProb - ecmwfProb| across thresholds for a station snapshot.
 * When kalshiKeys is provided, only considers those thresholds (where markets exist).
 * When null, considers all thresholds that have both model probabilities.
 */
function getMaxThresholdDiv(
  station: StationSnapshot,
  kalshiKeys: Set<string> | null,
): number {
  let maxDiv = 0;
  for (const [key, t] of Object.entries(station.thresholds)) {
    if (kalshiKeys !== null && !kalshiKeys.has(key)) continue;
    if (t.gefsProb !== null && t.ecmwfProb !== null) {
      maxDiv = Math.max(maxDiv, Math.abs(t.gefsProb - t.ecmwfProb));
    }
  }
  return maxDiv;
}

/**
 * Compute convergence metrics for a station from snapshot history.
 *
 * Confidence and convergence signal are driven by per-threshold probability
 * divergence (not QPF inches), because a 1" model disagreement above all
 * thresholds has zero probability impact, while a 0.2" disagreement at a
 * critical threshold can swing probabilities dramatically.
 *
 * @param kalshiKeys - threshold keys with Kalshi markets (e.g. {"1.0","2.0"}).
 *   When null, uses all thresholds with both model probs.
 * Returns null if the station has no model breakdown data in the latest snapshot.
 */
export function computeConvergence(
  stationCode: string,
  snapshots: ForecastSnapshot[],
  kalshiKeys: Set<string> | null = null,
): StationConvergence | null {
  if (snapshots.length === 0) return null;

  const latest = snapshots[snapshots.length - 1].stations[stationCode];
  if (!latest || latest.gefsMedian === null || latest.ecmwfMedian === null) {
    return null;
  }

  const qpfDivergence = Math.abs(latest.gefsMedian - latest.ecmwfMedian);
  const maxThresholdDivergence = getMaxThresholdDiv(latest, kalshiKeys);

  // Build threshold-probability divergence time series from all snapshots
  const series: { t: number; div: number }[] = [];
  for (const snap of snapshots) {
    const st = snap.stations[stationCode];
    if (!st || st.gefsMedian === null || st.ecmwfMedian === null) continue;
    const div = getMaxThresholdDiv(st, kalshiKeys);
    series.push({ t: new Date(snap.timestamp).getTime(), div });
  }

  // Compute 24-hour EMA of threshold divergence
  let emaTrend: number | null = null;
  let convergenceSignal: ConvergenceSignal = "stable";

  if (series.length >= 2) {
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
    // 0.05 = 5 percentage points
    if (emaDelta < -0.05) {
      convergenceSignal = "converging";
    } else if (emaDelta > 0.05) {
      convergenceSignal = "diverging";
    }
  }

  // Confidence from max threshold probability divergence
  let confidenceLevel: ConfidenceLevel;
  if (maxThresholdDivergence < 0.15) {
    confidenceLevel = "high";
  } else if (maxThresholdDivergence > 0.35) {
    confidenceLevel = "low";
  } else {
    confidenceLevel = "medium";
  }

  return {
    qpfDivergence: Math.round(qpfDivergence * 100) / 100,
    maxThresholdDivergence: Math.round(maxThresholdDivergence * 10000) / 10000,
    emaTrend: emaTrend !== null ? Math.round(emaTrend * 10000) / 10000 : null,
    convergenceSignal,
    confidenceLevel,
  };
}

/**
 * Extract the threshold probability divergence time series for a station
 * (for sparkline rendering). Returns array of { t: ISO string, div: max
 * |gefsProb - ecmwfProb| as 0-1 }.
 */
export function getDivergenceHistory(
  stationCode: string,
  snapshots: ForecastSnapshot[],
  kalshiKeys: Set<string> | null = null,
): { t: string; div: number }[] {
  const result: { t: string; div: number }[] = [];
  for (const snap of snapshots) {
    const st = snap.stations[stationCode];
    if (!st || st.gefsMedian === null || st.ecmwfMedian === null) continue;
    result.push({
      t: snap.timestamp,
      div: getMaxThresholdDiv(st, kalshiKeys),
    });
  }
  return result;
}

// --- Kalshi price delta types ---

export type PriceTrend = "rising" | "falling" | "stable";

export interface ThresholdPriceDelta {
  current: number; // current price in cents
  change3h: number | null;
  change6h: number | null;
  change24h: number | null;
  trend: PriceTrend; // based on change6h
}

export type KalshiDelta = Record<string, ThresholdPriceDelta>;

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_TOLERANCE_MS = 1 * HOUR_MS; // ±1 hour tolerance for finding snapshots

/**
 * Find the snapshot closest to `targetMs` that's within ±tolerance.
 * Returns the station snapshot or null.
 */
function findSnapshotNear(
  stationCode: string,
  snapshots: ForecastSnapshot[],
  targetMs: number,
): StationSnapshot | null {
  let best: StationSnapshot | null = null;
  let bestDist = Infinity;
  for (const snap of snapshots) {
    const t = new Date(snap.timestamp).getTime();
    const dist = Math.abs(t - targetMs);
    if (dist < WINDOW_TOLERANCE_MS && dist < bestDist) {
      const st = snap.stations[stationCode];
      if (st?.kalshiPrices) {
        best = st;
        bestDist = dist;
      }
    }
  }
  return best;
}

/**
 * Compute Kalshi price deltas for a station from snapshot history.
 * Returns null if no current Kalshi prices are available.
 */
export function computeKalshiDeltas(
  stationCode: string,
  snapshots: ForecastSnapshot[],
): KalshiDelta | null {
  if (snapshots.length === 0) return null;

  const latest = snapshots[snapshots.length - 1].stations[stationCode];
  if (!latest?.kalshiPrices || Object.keys(latest.kalshiPrices).length === 0) {
    return null;
  }

  const nowMs = new Date(snapshots[snapshots.length - 1].timestamp).getTime();
  const snap3h = findSnapshotNear(stationCode, snapshots, nowMs - 3 * HOUR_MS);
  const snap6h = findSnapshotNear(stationCode, snapshots, nowMs - 6 * HOUR_MS);
  const snap24h = findSnapshotNear(stationCode, snapshots, nowMs - 24 * HOUR_MS);

  const result: KalshiDelta = {};

  for (const [thresh, currentPrice] of Object.entries(latest.kalshiPrices)) {
    const change3h = snap3h?.kalshiPrices?.[thresh] != null
      ? currentPrice - snap3h.kalshiPrices[thresh] : null;
    const change6h = snap6h?.kalshiPrices?.[thresh] != null
      ? currentPrice - snap6h.kalshiPrices[thresh] : null;
    const change24h = snap24h?.kalshiPrices?.[thresh] != null
      ? currentPrice - snap24h.kalshiPrices[thresh] : null;

    let trend: PriceTrend = "stable";
    if (change6h !== null) {
      if (change6h > 2) trend = "rising";
      else if (change6h < -2) trend = "falling";
    }

    result[thresh] = {
      current: currentPrice,
      change3h: change3h !== null ? Math.round(change3h * 100) / 100 : null,
      change6h: change6h !== null ? Math.round(change6h * 100) / 100 : null,
      change24h: change24h !== null ? Math.round(change24h * 100) / 100 : null,
      trend,
    };
  }

  return result;
}

/**
 * Compute Kalshi deltas for all stations.
 */
export function computeAllKalshiDeltas(
  snapshots: ForecastSnapshot[],
): Record<string, KalshiDelta> {
  if (snapshots.length === 0) return {};

  const latest = snapshots[snapshots.length - 1];
  const result: Record<string, KalshiDelta> = {};

  for (const code of Object.keys(latest.stations)) {
    const deltas = computeKalshiDeltas(code, snapshots);
    if (deltas) {
      result[code] = deltas;
    }
  }

  return result;
}

/**
 * Compute convergence metrics for all stations.
 * @param kalshiKeysPerStation - map of station code → threshold keys with Kalshi markets
 */
export function computeAllConvergence(
  snapshots: ForecastSnapshot[],
  kalshiKeysPerStation: Record<string, string[]> = {},
): Record<string, StationConvergence> {
  if (snapshots.length === 0) return {};

  const latest = snapshots[snapshots.length - 1];
  const result: Record<string, StationConvergence> = {};

  for (const code of Object.keys(latest.stations)) {
    const keys = kalshiKeysPerStation[code];
    const keySet = keys && keys.length > 0 ? new Set(keys) : null;
    const metrics = computeConvergence(code, snapshots, keySet);
    if (metrics) {
      result[code] = metrics;
    }
  }

  return result;
}
