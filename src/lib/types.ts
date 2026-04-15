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

export interface ConditionalGammaEntry {
  // [lo, hi] MTD interval covered by this quintile bucket, inclusive lo,
  // exclusive hi (the final bucket extends slightly past the observed max
  // so lookups at extreme MTD still resolve).
  mtd_range: [number, number];
  n: number;
  shape: number | null;
  scale: number | null;
  zero_fraction: number | null;
}

export interface DayDistribution {
  percentiles: Record<string, number>;
  gamma: GammaParams | null;
  gamma_nino: GammaParams | null;
  gamma_nina: GammaParams | null;
  gamma_neutral: GammaParams | null;
  // Up to 5 entries (one per MTD quintile) for day_of_month >= 1.
  // Null/absent when too few years to bucket meaningfully (e.g. early
  // days where most years have MTD=0).
  conditional_gammas?: ConditionalGammaEntry[] | null;
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
  modelRuns?: { gefs: string | null; ecmwf: string | null }; // e.g. "12z"
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
  // Each side's top-of-book in cents (0-100). yesAsk = 100 - noBid and
  // noAsk = 100 - yesBid by Kalshi's pricing identity, but we store all
  // four independently so display and P&L can pick the right side.
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
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

// --- Kalshi portfolio (authenticated, read-only) ---

export interface KalshiPosition {
  ticker: string;
  // Signed contract count: positive = YES side, negative = NO side.
  position: number;
  // Current marked value of the position, in cents (from Kalshi's
  // market_exposure_dollars).
  marketExposure: number;
  // Lifetime cost basis of contracts traded into this position, parsed
  // directly from Kalshi's total_traded_dollars string (in dollars).
  // Used as the denominator for Kalshi-style Total Return %.
  totalTradedDollars: number;
  // Realized P&L on this ticker so far, in cents (may be 0).
  realizedPnl: number;
  // Cumulative fees paid on this ticker, in cents.
  feesPaid: number;
  // Avg entry price per contract in cents (0-100), or null if position is 0.
  // For YES positions this is the avg YES price; for NO positions it is the
  // avg NO price. Convert NO → YES-equivalent only when comparing to market.
  avgPrice: number | null;
}

export interface KalshiPortfolioResponse {
  authenticated: boolean;
  // Keyed by market ticker (e.g. "KXRAINSFOM-24APR-B3.0").
  positions: Record<string, KalshiPosition>;
  fetchedAt: string;
  error?: string;
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
