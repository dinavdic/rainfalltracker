import { ForecastSnapshot } from "./convergence";

export type SpreadSignal = "tightening" | "spreading" | "stable";
export type LevelSignal = "wetting" | "drying" | "stable";
export type Regime =
  | "locking_wet"
  | "locking_dry"
  | "destabilizing"
  | "stable"
  | "insufficient_data";

export interface EnsembleMomentum {
  // Spread momentum — is the ensemble tightening or spreading?
  spreadMomentum: number | null; // change in IQR per hour (negative = tightening)
  spreadMomentumEMA: number | null; // 12-hour EMA of spread momentum
  spreadSignal: SpreadSignal;

  // Level momentum — is the median shifting wet or dry?
  levelMomentum: number | null; // change in median per hour (positive = wetter)
  levelMomentumEMA: number | null; // 12-hour EMA of level momentum
  levelSignal: LevelSignal;

  // Combined regime classification
  regime: Regime;
  regimeDescription: string;

  // Raw history for sparklines
  iqrHistory: { timestamp: string; value: number }[];
  medianHistory: { timestamp: string; value: number }[];

  // Current values
  currentIQR: number | null;
  currentMedian: number | null;
}

const EMA_TAU_MS = 12 * 60 * 60 * 1000; // 12-hour time constant
const MS_PER_HOUR = 60 * 60 * 1000;

const REGIME_DESCRIPTIONS: Record<Regime, string> = {
  locking_wet: "Locking in wet \u2014 models converging on wetter outcome",
  locking_dry: "Locking in dry \u2014 models converging on drier outcome",
  destabilizing: "Destabilizing \u2014 forecast uncertainty growing",
  stable: "Stable \u2014 no significant momentum",
  insufficient_data: "Collecting data...",
};

interface TimeSeries {
  t: number; // epoch ms
  value: number;
}

/**
 * Compute derivatives between consecutive points (units per hour).
 */
function derivatives(series: TimeSeries[]): TimeSeries[] {
  const result: TimeSeries[] = [];
  for (let i = 1; i < series.length; i++) {
    const dt = series[i].t - series[i - 1].t;
    if (dt <= 0) continue;
    const dv = series[i].value - series[i - 1].value;
    result.push({
      t: series[i].t,
      value: dv / (dt / MS_PER_HOUR),
    });
  }
  return result;
}

/**
 * Compute 12-hour EMA over an irregularly-spaced time series.
 * Returns { ema, prevEma } where prevEma is the EMA before the last step.
 */
function computeEMA(series: TimeSeries[]): { ema: number; prevEma: number } | null {
  if (series.length === 0) return null;

  let ema = series[0].value;
  let prevEma = ema;

  for (let i = 1; i < series.length; i++) {
    const dt = series[i].t - series[i - 1].t;
    const alpha = 1 - Math.exp(-dt / EMA_TAU_MS);
    prevEma = ema;
    ema = alpha * series[i].value + (1 - alpha) * ema;
  }

  return { ema, prevEma };
}

/**
 * Compute ensemble momentum metrics for a station from snapshot history.
 */
export function computeMomentum(
  stationCode: string,
  snapshots: ForecastSnapshot[],
): EnsembleMomentum {
  const insufficient: EnsembleMomentum = {
    spreadMomentum: null,
    spreadMomentumEMA: null,
    spreadSignal: "stable",
    levelMomentum: null,
    levelMomentumEMA: null,
    levelSignal: "stable",
    regime: "insufficient_data",
    regimeDescription: REGIME_DESCRIPTIONS.insufficient_data,
    iqrHistory: [],
    medianHistory: [],
    currentIQR: null,
    currentMedian: null,
  };

  // Extract IQR and median time series
  const iqrSeries: TimeSeries[] = [];
  const medianSeries: TimeSeries[] = [];
  const iqrHistory: { timestamp: string; value: number }[] = [];
  const medianHistory: { timestamp: string; value: number }[] = [];

  for (const snap of snapshots) {
    const st = snap.stations[stationCode];
    if (!st) continue;
    const t = new Date(snap.timestamp).getTime();

    if (st.combinedIQR !== null) {
      iqrSeries.push({ t, value: st.combinedIQR });
      iqrHistory.push({ timestamp: snap.timestamp, value: st.combinedIQR });
    }
    if (st.combinedMedian !== null) {
      medianSeries.push({ t, value: st.combinedMedian });
      medianHistory.push({ timestamp: snap.timestamp, value: st.combinedMedian });
    }
  }

  if (iqrSeries.length < 3 || medianSeries.length < 3) {
    return { ...insufficient, iqrHistory, medianHistory };
  }

  // Sort by time
  iqrSeries.sort((a, b) => a.t - b.t);
  medianSeries.sort((a, b) => a.t - b.t);

  // Compute derivatives (change per hour)
  const iqrDerivs = derivatives(iqrSeries);
  const medianDerivs = derivatives(medianSeries);

  if (iqrDerivs.length === 0 || medianDerivs.length === 0) {
    return { ...insufficient, iqrHistory, medianHistory };
  }

  // Raw momentum = latest derivative
  const spreadMomentum = iqrDerivs[iqrDerivs.length - 1].value;
  const levelMomentum = medianDerivs[medianDerivs.length - 1].value;

  // 12-hour EMA of derivatives
  const spreadEmaResult = computeEMA(iqrDerivs);
  const levelEmaResult = computeEMA(medianDerivs);

  const spreadMomentumEMA = spreadEmaResult?.ema ?? null;
  const levelMomentumEMA = levelEmaResult?.ema ?? null;

  // Classify spread signal
  let spreadSignal: SpreadSignal = "stable";
  if (spreadMomentumEMA !== null) {
    if (spreadMomentumEMA < -0.02) spreadSignal = "tightening";
    else if (spreadMomentumEMA > 0.02) spreadSignal = "spreading";
  }

  // Classify level signal
  let levelSignal: LevelSignal = "stable";
  if (levelMomentumEMA !== null) {
    if (levelMomentumEMA > 0.01) levelSignal = "wetting";
    else if (levelMomentumEMA < -0.01) levelSignal = "drying";
  }

  // Classify regime
  let regime: Regime;
  if (spreadSignal === "spreading") {
    regime = "destabilizing";
  } else if (spreadSignal === "tightening" && levelSignal === "wetting") {
    regime = "locking_wet";
  } else if (spreadSignal === "tightening" && levelSignal === "drying") {
    regime = "locking_dry";
  } else {
    regime = "stable";
  }

  const currentIQR = iqrSeries[iqrSeries.length - 1].value;
  const currentMedian = medianSeries[medianSeries.length - 1].value;

  return {
    spreadMomentum: Math.round(spreadMomentum * 10000) / 10000,
    spreadMomentumEMA: spreadMomentumEMA !== null
      ? Math.round(spreadMomentumEMA * 10000) / 10000 : null,
    spreadSignal,
    levelMomentum: Math.round(levelMomentum * 10000) / 10000,
    levelMomentumEMA: levelMomentumEMA !== null
      ? Math.round(levelMomentumEMA * 10000) / 10000 : null,
    levelSignal,
    regime,
    regimeDescription: REGIME_DESCRIPTIONS[regime],
    iqrHistory,
    medianHistory,
    currentIQR: Math.round(currentIQR * 100) / 100,
    currentMedian: Math.round(currentMedian * 100) / 100,
  };
}

/**
 * Compute momentum metrics for all stations.
 */
export function computeAllMomentum(
  snapshots: ForecastSnapshot[],
): Record<string, EnsembleMomentum> {
  if (snapshots.length === 0) return {};

  const latest = snapshots[snapshots.length - 1];
  const result: Record<string, EnsembleMomentum> = {};

  for (const code of Object.keys(latest.stations)) {
    result[code] = computeMomentum(code, snapshots);
  }

  return result;
}
