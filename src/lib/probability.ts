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
 * @param qpfSum - 7-day quantitative precipitation forecast total (inches), 0 if unavailable
 * @param historical - The full historical distributions data
 */
export function computeProbabilities(
  station: string,
  month: number,
  dayOfMonth: number,
  mtd: number,
  qpfSum: number,
  historical: HistoricalData
): StationProbabilities {
  const stationData = historical.stations[station];
  const monthData = stationData?.months[String(month)];

  const dim = daysInMonth(month);
  const daysRemaining = dim - dayOfMonth;

  // Forecast period: next 7 days (or fewer if near month end)
  const forecastDays = Math.min(7, daysRemaining);
  // Climatology period: days after the forecast window through end of month
  const climatologyDays = daysRemaining - forecastDays;

  const hasQpf = qpfSum > 0;

  const thresholds: ThresholdProbability[] = THRESHOLDS.map((threshold) => {
    // Base rate: unconditional probability that the full month exceeds this threshold
    const baseRate = monthData?.base_rates[threshold.toFixed(1)] ?? 0;

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

    // --- Pure climatology probability ---
    // Uses gamma distribution for the full remaining period from current day
    let climatologyProbability = 0;
    const dayKey = String(dayOfMonth);
    const dayDist = monthData?.days[dayKey];

    if (dayDist?.gamma) {
      climatologyProbability = gammaSurvival(remainingNeeded, dayDist.gamma);
    }

    // --- Blended probability (QPF + climatology) ---
    // Split remaining days: forecast period uses QPF sum as ~deterministic,
    // climatology period uses gamma distribution for just those remaining days.
    // P(exceed) = P(QPF_sum + climatology_remainder > remaining_needed)
    //           = P(climatology_remainder > remaining_needed - QPF_sum)
    let blendedProbability = climatologyProbability; // fallback if no QPF

    if (hasQpf) {
      const neededAfterQpf = remainingNeeded - qpfSum;

      if (neededAfterQpf <= 0) {
        // QPF alone covers the threshold
        blendedProbability = 0.99;
      } else if (climatologyDays <= 0) {
        // All remaining days are within the QPF window — no climatology period
        // QPF wasn't enough, so probability is very low
        blendedProbability = 0.05;
      } else {
        // Use gamma distribution for the climatology period (day 8+ through EOM)
        const climatologyStartDay = dayOfMonth + forecastDays;
        const climatologyDayKey = String(climatologyStartDay);
        const climatologyDist = monthData?.days[climatologyDayKey];

        if (climatologyDist?.gamma) {
          blendedProbability = gammaSurvival(
            neededAfterQpf,
            climatologyDist.gamma
          );
        } else {
          // No gamma fit for that day — fall back to pure climatology
          blendedProbability = climatologyProbability;
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
    qpfSum,
    thresholds,
  };
}
