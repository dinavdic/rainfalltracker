import { jStat } from "jstat";
import {
  HistoricalData,
  GammaParams,
  ThresholdProbability,
  StationProbabilities,
  EnsembleData,
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
 * Uses ensemble members when available: for each member, check if
 * MTD + member_forecast (+ climatology tail if forecast doesn't cover EOM)
 * exceeds the threshold. Average across all members for the ensemble probability.
 *
 * Falls back to deterministic QPF blending if only NWS QPF is available,
 * or pure climatology if neither is available.
 *
 * @param station - Station code (e.g., "SFO")
 * @param month - Current month (1-12)
 * @param dayOfMonth - Current day of month (1-31)
 * @param mtd - Month-to-date rainfall in inches
 * @param ensemble - GEFS ensemble data, or null if unavailable
 * @param qpfSum - NWS deterministic QPF fallback (inches), null if unavailable
 * @param historical - The full historical distributions data
 */
export function computeProbabilities(
  station: string,
  month: number,
  dayOfMonth: number,
  mtd: number,
  ensemble: EnsembleData | null,
  qpfSum: number | null,
  historical: HistoricalData
): StationProbabilities {
  const stationData = historical.stations[station];
  const monthData = stationData?.months[String(month)];

  const dim = daysInMonth(month);
  const daysRemaining = dim - dayOfMonth;

  const thresholds: ThresholdProbability[] = THRESHOLDS.map((threshold) => {
    const baseRate = monthData?.base_rates[threshold.toFixed(1)] ?? 0;
    const remainingNeeded = threshold - mtd;

    // Already exceeded
    if (remainingNeeded <= 0) {
      return {
        threshold,
        remainingNeeded: null,
        baseRate,
        ensembleProbability: 1.0,
        climatologyProbability: 1.0,
      };
    }

    // --- Pure climatology probability ---
    let climatologyProbability = 0;
    const dayKey = String(dayOfMonth);
    const dayDist = monthData?.days[dayKey];

    if (dayDist?.gamma) {
      climatologyProbability = gammaSurvival(remainingNeeded, dayDist.gamma);
    }

    // --- Ensemble probability ---
    let ensembleProbability = climatologyProbability; // fallback

    if (ensemble !== null) {
      // How many days after the forecast ends until EOM?
      const uncoveredDays = daysRemaining - ensemble.forecastDays;

      if (uncoveredDays <= 0) {
        // Forecast covers through EOM — just count exceeding members
        let exceedCount = 0;
        for (const memberSum of ensemble.memberSums) {
          if (memberSum >= remainingNeeded) {
            exceedCount++;
          }
        }
        ensembleProbability = exceedCount / ensemble.memberSums.length;
      } else {
        // Forecast ends before EOM — blend each member with climatology tail
        // For the uncovered tail days, use gamma distribution starting
        // from the day the forecast ends. Search backward if exact day has no fit.
        const tailStartDay = dayOfMonth + ensemble.forecastDays;
        let tailGamma: GammaParams | null = null;
        for (let d = tailStartDay; d >= dayOfMonth + 1; d--) {
          const dist = monthData?.days[String(d)];
          if (dist?.gamma) {
            tailGamma = dist.gamma;
            break;
          }
        }

        let totalProb = 0;
        for (const memberSum of ensemble.memberSums) {
          const remainingAfterMember = remainingNeeded - memberSum;

          if (remainingAfterMember <= 0) {
            // This member already exceeds the threshold
            totalProb += 1.0;
          } else if (tailGamma) {
            // P(tail_rainfall > remaining_after_member)
            totalProb += gammaSurvival(remainingAfterMember, tailGamma);
          }
          // else: no gamma fit at all — this member contributes 0
        }
        ensembleProbability = totalProb / ensemble.memberSums.length;
      }
    } else if (qpfSum !== null) {
      // Fallback: deterministic NWS QPF blending (old behavior)
      const forecastDays = Math.min(7, daysRemaining);
      const climatologyDays = daysRemaining - forecastDays;
      const neededAfterQpf = remainingNeeded - qpfSum;

      if (neededAfterQpf <= 0) {
        ensembleProbability = 0.99;
      } else if (climatologyDays <= 0) {
        ensembleProbability = 0.05;
      } else {
        const climatologyStartDay = dayOfMonth + forecastDays;
        const climatologyDayKey = String(climatologyStartDay);
        const climatologyDist = monthData?.days[climatologyDayKey];

        if (climatologyDist?.gamma) {
          ensembleProbability = gammaSurvival(
            neededAfterQpf,
            climatologyDist.gamma
          );
        }
      }
    }

    return {
      threshold,
      remainingNeeded: Math.round(remainingNeeded * 100) / 100,
      baseRate,
      ensembleProbability: Math.round(ensembleProbability * 10000) / 10000,
      climatologyProbability:
        Math.round(climatologyProbability * 10000) / 10000,
    };
  });

  return {
    station,
    month,
    dayOfMonth,
    mtd,
    ensemble,
    thresholds,
  };
}
