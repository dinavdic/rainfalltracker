"use client";

import { ThresholdProbability, EnsembleData, KalshiStationData } from "@/lib/types";
import { StationConvergence } from "@/lib/convergence";

interface StationCardProps {
  code: string;
  city: string;
  mtd: number | null;
  hasLiveData: boolean;
  ensemble: EnsembleData | null;
  qpfSum: number | null;
  thresholds: ThresholdProbability[];
  convergence: StationConvergence | null;
  divergenceHistory: { t: string; div: number }[];
  kalshi: KalshiStationData | null;
  lastDate: string | null;
  error?: string;
}

function ProbabilityBadge({ value }: { value: number }) {
  const pct = value * 100;
  const rounded = Math.round(pct);
  const label = pct > 0 && pct < 10 ? pct.toFixed(1) : String(rounded);
  let colorClasses: string;

  if (rounded >= 60) {
    colorClasses = "bg-green-100 text-green-800";
  } else if (rounded >= 25) {
    colorClasses = "bg-amber-100 text-amber-800";
  } else {
    colorClasses = "bg-red-100 text-red-800";
  }

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${colorClasses}`}
    >
      {label}%
    </span>
  );
}

function formatEdge(edge: number): string {
  const sign = edge >= 0 ? "+" : "";
  return Math.abs(edge) < 10
    ? `${sign}${edge.toFixed(1)}`
    : `${sign}${Math.round(edge)}`;
}

function EdgeBadge({ edge }: { edge: number }) {
  const label = formatEdge(edge);
  const colorClasses =
    edge >= 0
      ? "text-green-700 bg-green-50"
      : "text-red-700 bg-red-50";

  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums ${colorClasses}`}
    >
      {label}
    </span>
  );
}

/**
 * Compute the Kalshi mid-price as a probability (0-1).
 * Uses mid of bid/ask if available, otherwise last_price.
 */
function kalshiMidProb(
  price: { yesBid: number | null; yesAsk: number | null; lastPrice: number | null }
): number | null {
  if (price.yesBid !== null && price.yesAsk !== null) {
    return (price.yesBid + price.yesAsk) / 2 / 100;
  }
  if (price.lastPrice !== null) {
    return price.lastPrice / 100;
  }
  return null;
}

function DivergenceSparkline({ data }: { data: { t: string; div: number }[] }) {
  const W = 50;
  const H = 16;
  const pad = 1;

  if (data.length < 2) return null;

  const maxDiv = Math.max(...data.map((d) => d.div), 0.01);
  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * (W - 2 * pad);
    const y = H - pad - (d.div / maxDiv) * (H - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg width={W} height={H} className="inline-block align-middle">
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="#9ca3af"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function StationCard({
  code,
  city,
  mtd,
  hasLiveData,
  ensemble,
  qpfSum,
  thresholds,
  convergence,
  divergenceHistory,
  kalshi,
  lastDate,
  error,
}: StationCardProps) {
  const mtdValue = mtd ?? 0;
  const progressPct = Math.min((mtdValue / 5.0) * 100, 100);
  const hasForecast = ensemble !== null || qpfSum !== null;
  const hasKalshi =
    kalshi !== null && Object.keys(kalshi.thresholds).length > 0;

  // Total volume across all thresholds for this station
  const totalVolume = hasKalshi
    ? Object.values(kalshi!.thresholds).reduce(
        (sum, p) => sum + (p.volume || 0),
        0
      )
    : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      {/* Station header */}
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-gray-900">{code}</span>
          <span className="text-sm text-gray-500">{city}</span>
        </div>
        {hasLiveData && lastDate && (
          <span className="text-[10px] text-gray-400">as of {lastDate}</span>
        )}
      </div>

      {/* MTD display */}
      {error && !hasLiveData ? (
        <div className="mb-4">
          <span className="text-3xl font-semibold text-gray-300">&mdash;</span>
          <span className="text-sm text-gray-400 ml-1">MTD unavailable</span>
        </div>
      ) : (
        <>
          <div className="mb-1">
            <span className="text-4xl font-bold tabular-nums text-gray-900">
              {mtdValue.toFixed(2)}
            </span>
            <span className="text-sm text-gray-500 ml-1">&quot;</span>
            {!hasLiveData && (
              <span className="text-[10px] text-gray-400 ml-2">
                no live data
              </span>
            )}
          </div>

          {/* Progress bar toward 5" */}
          <div className="w-full bg-gray-100 rounded-full h-1.5 mb-4">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </>
      )}

      {/* Thresholds table */}
      <table className="w-full text-sm mb-3">
        <thead>
          <tr className="text-gray-500 text-xs">
            <th className="text-left pb-1 font-medium">Threshold</th>
            <th className="text-right pb-1 font-medium">Need</th>
            <th className="text-right pb-1 font-medium">Base</th>
            <th className="text-right pb-1 font-medium">Clim.</th>
            {hasForecast && (
              <th className="text-right pb-1 font-medium">Ensemble</th>
            )}
            {hasKalshi && (
              <>
                <th className="text-right pb-1 font-medium">Market</th>
                {hasForecast && (
                  <th className="text-right pb-1 font-medium">Edge</th>
                )}
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {thresholds.map((t) => {
            const thresholdKey = t.threshold.toFixed(1);
            const kalshiPrice = kalshi?.thresholds[thresholdKey] ?? null;
            const marketProb = kalshiPrice
              ? kalshiMidProb(kalshiPrice)
              : null;
            const edge =
              hasForecast && marketProb !== null
                ? t.ensembleProbability * 100 - marketProb * 100
                : null;

            // Model range info
            const hasModelRange = t.gefsProb !== null && t.ecmwfProb !== null;
            const singleModel = t.gefsProb !== null && t.ecmwfProb === null;
            const loProb = hasModelRange ? Math.min(t.gefsProb!, t.ecmwfProb!) : 0;
            const hiProb = hasModelRange ? Math.max(t.gefsProb!, t.ecmwfProb!) : 0;
            const spread = hasModelRange ? (hiProb - loProb) * 100 : 0;
            const pctMain = t.ensembleProbability * 100;
            const showRange = hasModelRange && spread > 2 && pctMain > 1 && pctMain < 99;

            // Edge range info
            const worstEdge = showRange && marketProb !== null
              ? loProb * 100 - marketProb * 100 : null;
            const bestEdge = showRange && marketProb !== null
              ? hiProb * 100 - marketProb * 100 : null;
            const signsAgree = worstEdge !== null && bestEdge !== null
              && ((worstEdge >= 0 && bestEdge >= 0) || (worstEdge < 0 && bestEdge < 0));

            return (
              <tr key={t.threshold} className="border-t border-gray-50">
                <td className="py-1.5 text-gray-700 font-medium">
                  &gt;{t.threshold}&quot;
                </td>
                <td className="py-1.5 text-right text-gray-600">
                  {t.remainingNeeded === null ? (
                    <span className="text-green-600 text-xs font-semibold">
                      exceeded
                    </span>
                  ) : (
                    <span className="tabular-nums">
                      {t.remainingNeeded.toFixed(2)}&quot;
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right text-gray-400 tabular-nums">
                  {(() => {
                    const pct = t.baseRate * 100;
                    return pct > 0 && pct < 10
                      ? pct.toFixed(1)
                      : String(Math.round(pct));
                  })()}%
                </td>
                <td className="py-1.5 text-right">
                  <ProbabilityBadge value={t.climatologyProbability} />
                </td>
                {hasForecast && (
                  <td className="py-1.5 text-right">
                    <ProbabilityBadge value={t.ensembleProbability} />
                    {showRange && (
                      <div className="text-[10px] text-gray-400 tabular-nums mt-0.5">
                        ({Math.round(loProb * 100)}&ndash;{Math.round(hiProb * 100)}%)
                      </div>
                    )}
                    {hasModelRange && spread > 15 && (
                      <div className="text-[10px] text-gray-400 tabular-nums mt-0.5">
                        G:{Math.round(t.gefsProb! * 100)}/E:{Math.round(t.ecmwfProb! * 100)}
                      </div>
                    )}
                    {singleModel && (
                      <div className="text-[10px] text-gray-400 italic mt-0.5">
                        (single model)
                      </div>
                    )}
                  </td>
                )}
                {hasKalshi && (
                  <>
                    <td className="py-1.5 text-right">
                      {marketProb !== null ? (
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-blue-50 text-blue-800 tabular-nums">
                          {(() => {
                            const pct = marketProb * 100;
                            return pct > 0 && pct < 10
                              ? pct.toFixed(1)
                              : String(Math.round(pct));
                          })()}%
                        </span>
                      ) : (
                        <span className="text-gray-300">&mdash;</span>
                      )}
                    </td>
                    {hasForecast && (
                      <td className="py-1.5 text-right">
                        {edge !== null ? (
                          <>
                            <EdgeBadge edge={edge} />
                            {worstEdge !== null && bestEdge !== null && (
                              <div className={`text-[10px] tabular-nums mt-0.5 ${
                                signsAgree ? "text-green-600" : "text-red-500"
                              }`}>
                                ({formatEdge(worstEdge)} to {formatEdge(bestEdge)})
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-gray-300">&mdash;</span>
                        )}
                      </td>
                    )}
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Model convergence row */}
      {convergence && (
        <div className="text-[11px] mb-2 flex items-center gap-1.5 flex-wrap">
          <span className="text-gray-500">Models:</span>
          {(() => {
            const { qpfDivergence, convergenceSignal, confidenceLevel } = convergence;

            // Alignment status
            const isAligned = qpfDivergence <= 0.3;
            const alignColor = isAligned
              ? "text-green-600"
              : qpfDivergence <= 0.8
                ? "text-amber-600"
                : "text-red-600";
            const alignIcon = isAligned ? "\u2713" : "\u2717";
            const alignLabel = isAligned ? "Aligned" : "Divergent";

            // Signal arrow
            const signalMap = {
              converging: { arrow: "\u2198", color: "text-green-600" },
              diverging: { arrow: "\u2197", color: "text-red-600" },
              stable: { arrow: "\u2192", color: "text-gray-500" },
            } as const;
            const sig = signalMap[convergenceSignal];

            // Confidence color
            const confColor =
              confidenceLevel === "high"
                ? "text-green-600"
                : confidenceLevel === "medium"
                  ? "text-amber-600"
                  : "text-red-600";
            const confLabel =
              confidenceLevel.charAt(0).toUpperCase() + confidenceLevel.slice(1);

            return (
              <>
                <span className={`font-semibold ${alignColor}`}>
                  {alignIcon} {alignLabel}
                </span>
                <span className="text-gray-400 tabular-nums">
                  ({qpfDivergence.toFixed(2)}&quot; gap)
                </span>
                <span className={sig.color}>{sig.arrow} {convergenceSignal}</span>
                <span className="text-gray-400">|</span>
                <span className="text-gray-500">Confidence:</span>
                <span className={`font-semibold ${confColor}`}>{confLabel}</span>
                {divergenceHistory.length >= 4 ? (
                  <DivergenceSparkline data={divergenceHistory} />
                ) : (
                  <span className="text-gray-400 italic">Collecting data...</span>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Forecast summary line */}
      <div className="text-xs text-gray-400">
        {ensemble ? (
          <>
            {ensemble.modelBreakdown ? "Multi-model" : "Ensemble"} QPF:{" "}
            {ensemble.stats.median.toFixed(2)}&quot;{" "}
            <span className="text-gray-300">
              ({ensemble.stats.p10.toFixed(2)}&quot; &ndash;{" "}
              {ensemble.stats.p90.toFixed(2)}&quot;)
            </span>
            {ensemble.modelBreakdown && (
              <span className="text-gray-300">
                {" "}&middot; GEFS: {ensemble.modelBreakdown.gefs.median.toFixed(2)}&quot;
                {" "}/ ECMWF: {ensemble.modelBreakdown.ecmwf.median.toFixed(2)}&quot;
              </span>
            )}
          </>
        ) : qpfSum !== null ? (
          <>NWS QPF (fallback): {qpfSum.toFixed(2)}&quot;</>
        ) : (
          "Forecast unavailable"
        )}
      </div>

      {/* Kalshi volume and link */}
      {hasKalshi && (
        <div className="text-xs text-gray-400 mt-1">
          Kalshi vol: {totalVolume.toLocaleString()}
          {kalshi!.eventTicker && (
            <>
              {" "}&middot;{" "}
              <a
                href={`https://kalshi.com/markets/${kalshi!.eventTicker}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-600 underline"
              >
                trade
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
