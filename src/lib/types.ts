export interface NWSGridInfo {
  office: string;
  gridX: number;
  gridY: number;
}

export interface StationConfig {
  code: string;
  city: string;
  cliParams: string;
  iemCode: string;
  lat: number;
  lon: number;
  nwsGrid: NWSGridInfo;
}

export interface GammaParams {
  shape: number;
  scale: number;
  zero_fraction: number;
}

export type EnsoPhase = "nino" | "nina" | "neutral";

export interface DayDistribution {
  percentiles: Record<string, number>;
  gamma: GammaParams | null;
  gamma_nino: GammaParams | null;
  gamma_nina: GammaParams | null;
  gamma_neutral: GammaParams | null;
  n_years: number;
  mean: number;
}

export interface CumulativePercentiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface MonthDistribution {
  days_in_month: number;
  days: Record<string, DayDistribution>;
  base_rates: Record<string, number>;
  base_rates_nino: Record<string, number>;
  base_rates_nina: Record<string, number>;
  base_rates_neutral: Record<string, number>;
  monthly_totals_percentiles: Record<string, number>;
  cumulative_percentiles: Record<string, CumulativePercentiles>;
}

export interface StationHistorical {
  city: string;
  iem_code: string;
  months: Record<string, MonthDistribution>;
}

export interface HistoricalData {
  stations: Record<string, StationHistorical>;
  generated_at: string;
}

export interface EnsembleStats {
  mean: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

export interface ModelBreakdown {
  gefs: EnsembleStats;
  ecmwf: EnsembleStats;
  combined: EnsembleStats;
}

export interface EnsembleData {
  memberSums: number[]; // all combined member sums (up to 82: 31 GEFS + 51 ECMWF)
  gefsMemberSums: number[]; // 31 GEFS members
  ecmwfMemberSums: number[]; // 51 ECMWF members (empty if ECMWF failed)
  modelBreakdown: ModelBreakdown | null; // null if only one model available
  forecastDays: number; // how many days of the month the forecast covers
  stats: EnsembleStats; // combined stats (backward compat)
}

export interface StationRainfallData {
  mtd: number | null;
  qpf7day: number[];
  qpfSum: number | null; // NWS deterministic fallback; null = unavailable
  ensemble: EnsembleData | null; // Open-Meteo GEFS ensemble; null = unavailable
  lastUpdated: string | null;
  error?: string;
  qpfError?: string;
}

export interface RainfallApiResponse {
  stations: Record<string, StationRainfallData>;
  fetchedAt: string;
}

export interface ThresholdProbability {
  threshold: number;
  remainingNeeded: number | null; // null if already exceeded
  baseRate: number;
  ensembleProbability: number;
  climatologyProbability: number;
  gefsProb: number | null; // P(exceed) from GEFS members only; null if unavailable
  ecmwfProb: number | null; // P(exceed) from ECMWF members only; null if unavailable
}

export interface StationProbabilities {
  station: string;
  month: number;
  dayOfMonth: number;
  mtd: number;
  ensemble: EnsembleData | null;
  thresholds: ThresholdProbability[];
}

// --- Kalshi market data ---

export interface KalshiMarketPrice {
  ticker: string;
  lastPrice: number | null; // cents (0-100)
  yesBid: number | null;
  yesAsk: number | null;
  volume: number;
  isStale: boolean; // true when bid/ask unavailable, falling back to lastPrice
}

export interface KalshiStationData {
  thresholds: Record<string, KalshiMarketPrice>; // keyed by threshold like "1.0"
  eventTicker: string | null; // the Kalshi event ticker for linking
}

export interface KalshiApiResponse {
  stations: Record<string, KalshiStationData>;
  fetchedAt: string;
  discoveryLog: string[]; // ticker discovery debug info
}

// --- Skill curves (forecast verification) ---

export interface SkillCurveData {
  raw: number[]; // 16 elements, lead day 1..16
  fitted_params: { model: string; a: number; b: number };
  fitted: number[]; // 16 elements, smoothed exponential decay
}

export interface StationSkillCurves {
  daily_skill: SkillCurveData;
  accumulated_skill: SkillCurveData;
  sample_count: number;
  verification_period: string;
  daily_rmse_forecast: number;
  daily_rmse_climo: number;
  placeholder?: boolean; // true if using default values (not yet verified)
}

export type SkillCurvesData = Record<string, StationSkillCurves>;
