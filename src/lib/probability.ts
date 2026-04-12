import { jStat } from "jstat";
import {
  HistoricalData,
  GammaParams,
  ThresholdProbability,
  StationProbabilities,
} from "./types";
import { THRESHOLDS } from "./stations";

/**
 * Compute P(X > x) for a zero-inflated gamma distribution.
 * The gamma CDF gives P(X <= x), so P(X > x) = 1 - CDF(x).
 * With zero inflation: P(X > x) = (1 - zero_fraction) * P(gamma > x)
 */
function gammaSurvival(x: number, params: GammaParams): number {
  if (x <= 0) return 1 - params.zero_fraction;
  const cdf = jStat.gamma.cdf(x, params.shape, params.scale);
  return (1 - params.zero_fraction) * (1 - cdf);
}

/**
 * Get the number of days in a given month (1-indexed).
 */
function daysInMonth(month: number): number {
  const dims = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return dims[month];
}

/**
 * Compute conditional probabilities of exceeding rainfall thresholds.
 *
 * @param station - Station code (e.g., "SFO")
 * @param month - Current month (1-12)
 * @param dayOfMonth - Current day of month (1-31)
 * @param mtd - Month-to-date rainfall in inches
 * @param qpf7day - Array of 7-day quantitative precipitation forecast values
 * @param historical - The full historical distributions data
 */
export function computeProbabilities(
  station: string,
  month: number,
  dayOfMonth: number,
  mtd: number,
  qpf7day: number[],
  historical: HistoricalData
): StationProbabilities {
  const stationData = historical.stations[station];
  const monthData = stationData?.months[String(month)];

  const dim = daysInMonth(month);
  const daysRemaining = dim - dayOfMonth;
  const qpfSum = qpf7day.reduce((a, b) => a + b, 0);

  // Days covered by QPF forecast (up to 7, but not past end of month)
  const forecastDays = Math.min(7, daysRemaining);
  // Days after the forecast period through end of month
  const climatologyDays = daysRemaining - forecastDays;

  const thresholds: ThresholdProbability[] = THRESHOLDS.map((threshold) => {
    // Base rate: unconditional probability that the full month exceeds this threshold
    const baseRate = monthData?.base_rates[String(threshold)] ?? 0;

    const remainingNeeded = threshold - mtd;

    // If already exceeded
    if (remainingNeeded <= 0) {
      return {
        threshold,
        remainingNeeded: null,
        baseRate,
        blendedProbability: 1.0,
        climatologyProbability: 1.0,
      };
    }

    // Pure climatology: use gamma distribution for remaining period from current day
    let climatologyProbability = 0;
    const dayKey = String(dayOfMonth);
    const dayDist = monthData?.days[dayKey];

    if (dayDist?.gamma) {
      climatologyProbability = gammaSurvival(remainingNeeded, dayDist.gamma);
    }

    // Blended model: QPF as point estimate + climatology for remaining
    let blendedProbability = 0;

    if (climatologyDays <= 0) {
      // All remaining days are covered by QPF
      blendedProbability = qpfSum >= remainingNeeded ? 0.95 : 0.05;
    } else {
      // Need climatology for the post-forecast period
      const neededFromClimatology = remainingNeeded - qpfSum;

      if (neededFromClimatology <= 0) {
        // QPF alone is enough
        blendedProbability = 0.95;
      } else {
        // Use gamma distribution for the climatology period
        // The climatology period starts at dayOfMonth + forecastDays
        const climatologyStartDay = dayOfMonth + forecastDays;
        const climatologyDayKey = String(climatologyStartDay);
        const climatologyDist = monthData?.days[climatologyDayKey];

        if (climatologyDist?.gamma) {
          blendedProbability = gammaSurvival(
            neededFromClimatology,
            climatologyDist.gamma
          );
        }
      }
    }

    return {
      threshold,
      remainingNeeded: Math.round(remainingNeeded * 100) / 100,
      baseRate,
      blendedProbability: Math.round(blendedProbability * 10000) / 10000,
      climatologyProbability:
        Math.round(climatologyProbability * 10000) / 10000,
    };
  });

  return {
    station,
    month,
    dayOfMonth,
    mtd,
    qpf7day,
    thresholds,
  };
}
