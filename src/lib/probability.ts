import { jStat } from "jstat";
import {
  HistoricalData,
  GammaParams,
  ThresholdProbability,
  StationProbabilities,
  EnsembleData,
  EnsoPhase,
  DayDistribution,
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
 * Get the ENSO-conditional gamma for a day distribution.
 * Falls back to the unconditional gamma if the ENSO-conditional one is null.
 */
function getEnsoGamma(
  dayDist: DayDistribution | undefined,
  ensoPhase: EnsoPhase | null
): GammaParams | null {
  if (!dayDist) return null;
  if (!ensoPhase) return dayDist.gamma;

  const ensoKey = `gamma_${ensoPhase}` as keyof DayDistribution;
  const ensoGamma = dayDist[ensoKey] as GammaParams | null;
  // Fall back to unconditional if ENSO-conditional gamma is null (too few years)
  return ensoGamma ?? dayDist.gamma;
}

/**
 * Get the ENSO-conditional base rate for a threshold.
 * Falls back to unconditional if ENSO-conditional is unavailable.
 */
function getEnsoBaseRate(
  monthData: { base_rates: Record<string, number>; base_rates_nino?: Record<string, number>; base_rates_nina?: Record<string, number>; base_rates_neutral?: Record<string, number> } | undefined,
  thresholdKey: string,
  ensoPhase: EnsoPhase | null
): number {
  if (!monthData) return 0;
  if (!ensoPhase) return monthData.base_rates[thresholdKey] ?? 0;

  const ensoRatesKey = `base_rates_${ensoPhase}` as keyof typeof monthData;
  const ensoRates = monthData[ensoRatesKey] as Record<string, number> | undefined;
  if (ensoRates && thresholdKey in ensoRates) {
    return ensoRates[thresholdKey];
  }
  // Fall back to unconditional
  return monthData.base_rates[thresholdKey] ?? 0;
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
 * When ensoPhase is provided, uses ENSO-conditional gamma distributions
 * and base rates instead of unconditional ones. Falls back to unconditional
 * if the ENSO-conditional fit is null (too few years).
 *
 * @param station - Station code (e.g., "SFO")
 * @param month - Current month (1-12)
 * @param dayOfMonth - Current day of month (1-31)
 * @param mtd - Month-to-date rainfall in inches
 * @param ensemble - GEFS ensemble data, or null if unavailable
 * @param qpfSum - NWS deterministic QPF fallback (inches), null if unavailable
 * @param historical - The full historical distributions data
 * @param ensoPhase - Current ENSO phase for conditional distributions, or null
 */
export function computeProbabilities(
  station: string,
  month: number,
  dayOfMonth: number,
  mtd: number,
  ensemble: EnsembleData | null,
  qpfSum: number | null,
  historical: HistoricalData,
  ensoPhase: EnsoPhase | null = null
): StationProbabilities {
  const stationData = historical.stations[station];
  const monthData = stationData?.months[String(month)];

  const dim = daysInMonth(month);
  const daysRemaining = dim - dayOfMonth;

  // Pre-compute tail gamma once (shared across thresholds)
  let tailGamma: GammaParams | null = null;
  if (ensemble !== null) {
    const uncoveredDays = daysRemaining - ensemble.forecastDays;
    if (uncoveredDays > 0) {
      const tailStartDay = dayOfMonth + ensemble.forecastDays;
      for (let d = tailStartDay; d >= dayOfMonth + 1; d--) {
        const dist = monthData?.days[String(d)];
        const candidate = getEnsoGamma(dist, ensoPhase);
        if (candidate) {
          tailGamma = candidate;
          break;
        }
      }
    }
  }

  /**
   * Compute P(exceed threshold) from a set of ensemble member sums.
   * Returns null if memberSums is empty.
   */
  function ensembleExceedProb(
    memberSums: number[],
    remainingNeeded: number,
    forecastDays: number,
  ): number | null {
    if (memberSums.length === 0) return null;
    const uncoveredDays = daysRemaining - forecastDays;

    if (uncoveredDays <= 0) {
      let exceedCount = 0;
      for (const s of memberSums) {
        if (s >= remainingNeeded) exceedCount++;
      }
      return exceedCount / memberSums.length;
    } else {
      let totalProb = 0;
      for (const s of memberSums) {
        const gap = remainingNeeded - s;
        if (gap <= 0) {
          totalProb += 1.0;
        } else if (tailGamma) {
          totalProb += gammaSurvival(gap, tailGamma);
        }
      }
      return totalProb / memberSums.length;
    }
  }

  const thresholds: ThresholdProbability[] = THRESHOLDS.map((threshold) => {
    const thresholdKey = threshold.toFixed(1);
    const baseRate = getEnsoBaseRate(monthData, thresholdKey, ensoPhase);
    const remainingNeeded = threshold - mtd;

    // Already exceeded
    if (remainingNeeded <= 0) {
      return {
        threshold,
        remainingNeeded: null,
        baseRate,
        ensembleProbability: 1.0,
        climatologyProbability: 1.0,
        gefsProb: ensemble ? 1.0 : null,
        ecmwfProb: ensemble && ensemble.ecmwfMemberSums.length > 0 ? 1.0 : null,
      };
    }

    // --- Pure climatology probability (ENSO-conditional) ---
    let climatologyProbability = 0;
    const dayKey = String(dayOfMonth);
    const dayDist = monthData?.days[dayKey];
    const gamma = getEnsoGamma(dayDist, ensoPhase);

    if (gamma) {
      climatologyProbability = gammaSurvival(remainingNeeded, gamma);
    }

    // --- Ensemble probabilities (combined + per-model) ---
    let ensembleProbability = climatologyProbability; // fallback
    let gefsProb: number | null = null;
    let ecmwfProb: number | null = null;

    if (ensemble !== null) {
      const fd = ensemble.forecastDays;
      const combined = ensembleExceedProb(ensemble.memberSums, remainingNeeded, fd);
      if (combined !== null) ensembleProbability = combined;

      gefsProb = ensembleExceedProb(ensemble.gefsMemberSums, remainingNeeded, fd);
      ecmwfProb = ensembleExceedProb(ensemble.ecmwfMemberSums, remainingNeeded, fd);
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
        const qpfTailGamma = getEnsoGamma(climatologyDist, ensoPhase);

        if (qpfTailGamma) {
          ensembleProbability = gammaSurvival(neededAfterQpf, qpfTailGamma);
        }
      }
    }

    const round4 = (v: number) => Math.round(v * 10000) / 10000;

    return {
      threshold,
      remainingNeeded: Math.round(remainingNeeded * 100) / 100,
      baseRate,
      ensembleProbability: round4(ensembleProbability),
      climatologyProbability: round4(climatologyProbability),
      gefsProb: gefsProb !== null ? round4(gefsProb) : null,
      ecmwfProb: ecmwfProb !== null ? round4(ecmwfProb) : null,
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
