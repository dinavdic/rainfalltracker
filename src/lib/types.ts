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

export interface DayDistribution {
  percentiles: Record<string, number>;
  gamma: GammaParams | null;
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

export interface EnsembleData {
  memberSums: number[]; // 31 member totals in inches (remaining-in-month precip)
  forecastDays: number; // how many days of the month the forecast covers
  stats: EnsembleStats;
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
