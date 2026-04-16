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
 * Rank `mtd` against the sorted historical MTD array (ascending) and
 * return its empirical percentile in (0, 1). Uses the same
 * (rank - 0.5)/n convention as the Python fitter so coefficients
 * learned during the build match evaluations here.
 *
 * Ties use the average-rank rule: a run of identical values all share
 * the midpoint of their index range.
 */
function mtdPercentile(mtd: number, sortedQuantiles: number[]): number {
  const n = sortedQuantiles.length;
  if (n === 0) return 0.5;
  // First index with value > mtd, and first index with value >= mtd.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (sortedQuantiles[m] < mtd) lo = m + 1;
    else hi = m;
  }
  const firstGE = lo;
  lo = 0;
  hi = n;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (sortedQuantiles[m] <= mtd) lo = m + 1;
    else hi = m;
  }
  const firstGT = lo;
  // Average rank of entries equal to mtd is (firstGE + firstGT - 1) / 2 + 1.
  // If mtd isn't exactly present, firstGE == firstGT and we use firstGE + 0.5
  // as the interpolated rank.
  const avgRank =
    firstGE === firstGT
      ? firstGE + 0.5
      : (firstGE + firstGT - 1) / 2 + 1;
  const pct = (avgRank - 0.5) / n;
  // Clamp to the open interval (0, 1) so the exponential regression
  // can't explode at the endpoints.
  if (pct < 0.005) return 0.005;
  if (pct > 0.995) return 0.995;
  return pct;
}

/**
 * Evaluate the MTD-conditional gamma regression at the current MTD,
 * so the climatological baseline reflects "wet Aprils tend to finish
 * wet" rather than an unconditional all-years mean.
 *
 * Computes mtd_pctile by ranking the current MTD in the historical
 * MTD distribution for today's day, then
 *   shape = exp(a + b * pctile)
 *   scale = exp(c + d * pctile)
 * using the coefficients fit at build time.
 *
 * Falls back to the ENSO-conditional (or unconditional) gamma when
 * conditional_gamma_reg is absent (day 0, or too few years) or when
 * the derived params are non-finite.
 */
function getConditionalGamma(
  dayDist: DayDistribution | undefined,
  mtd: number,
  ensoPhase: EnsoPhase | null,
): GammaParams | null {
  if (!dayDist) return null;
  const reg = dayDist.conditional_gamma_reg;
  const quantiles = dayDist.mtd_quantiles;
  if (!reg || !quantiles || quantiles.length === 0) {
    return getEnsoGamma(dayDist, ensoPhase);
  }

  const pctile = mtdPercentile(mtd, quantiles);
  const shape = Math.exp(reg.a + reg.b * pctile);
  const scale = Math.exp(reg.c + reg.d * pctile);
  if (!Number.isFinite(shape) || !Number.isFinite(scale) || shape <= 0 || scale <= 0) {
    return getEnsoGamma(dayDist, ensoPhase);
  }
  return {
    shape,
    scale,
    zero_fraction: reg.zero_fraction,
  };
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
 * Sample from a zero-inflated gamma distribution.
 */
function sampleZeroInflatedGamma(params: GammaParams): number {
  if (Math.random() < params.zero_fraction) return 0;
  const u = Math.random() * 0.999 + 0.0005;
  return Math.max(0, jStat.gamma.inv(u, params.shape, params.scale));
}

/**
 * BMA (Bayesian Model Averaging) mixture Monte Carlo sampling.
 *
 * For each MC draw: with probability `skillWeight`, pick a random ensemble
 * member's QPF (plus tail gamma for uncovered days); otherwise sample from
 * the conditional climatological gamma for the full remaining period.
 *
 * Returns fraction of draws where remaining QPF >= remainingNeeded.
 */
function bmaMixtureExceedProb(
  memberSums: number[],
  remainingNeeded: number,
  skillWeight: number,
  condGamma: GammaParams | null,
  tailGamma: GammaParams | null,
  hasUncoveredDays: boolean,
): number | null {
  if (memberSums.length === 0) return null;

  const N = 10000;
  const w = skillWeight;
  const nMembers = memberSums.length;
  let exceedCount = 0;

  for (let i = 0; i < N; i++) {
    let draw: number;

    if (Math.random() < w) {
      const mi = Math.floor(Math.random() * nMembers);
      draw = memberSums[mi];
      if (hasUncoveredDays && tailGamma) {
        draw += sampleZeroInflatedGamma(tailGamma);
      }
    } else {
      draw = condGamma ? sampleZeroInflatedGamma(condGamma) : 0;
    }

    if (draw >= remainingNeeded) {
      exceedCount++;
    }
  }

  return exceedCount / N;
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

    // --- Pure climatology probability (MTD-quintile + ENSO conditional) ---
    //
    // Prefer the MTD-quintile gamma for today's day: when MTD is running
    // in the top quintile, "wet Aprils tend to finish wet" shifts the
    // anchor upward (and the opposite on the low end), so the
    // skill-weighted blend no longer regresses to the unconditional mean
    // at long lead times. Falls back to the ENSO-conditional (then
    // unconditional) gamma when conditional_gammas isn't available.
    let climatologyProbability = 0;
    const dayKey = String(dayOfMonth);
    const dayDist = monthData?.days[dayKey];
    const gamma = getConditionalGamma(dayDist, mtd, ensoPhase);

    if (gamma) {
      climatologyProbability = gammaSurvival(remainingNeeded, gamma);
    }

    // --- Ensemble probabilities (combined + per-model) ---
    let ensembleProbability = climatologyProbability; // fallback
    let gefsProb: number | null = null;
    let ecmwfProb: number | null = null;

    if (ensemble !== null) {
      const w = ensemble.skillWeight ?? 1;
      const hasUncovered = daysRemaining - ensemble.forecastDays > 0;

      const combined = bmaMixtureExceedProb(
        ensemble.memberSums, remainingNeeded, w, gamma, tailGamma, hasUncovered,
      );
      if (combined !== null) ensembleProbability = combined;

      gefsProb = bmaMixtureExceedProb(
        ensemble.gefsMemberSums, remainingNeeded, w, gamma, tailGamma, hasUncovered,
      );
      ecmwfProb = bmaMixtureExceedProb(
        ensemble.ecmwfMemberSums, remainingNeeded, w, gamma, tailGamma, hasUncovered,
      );
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
