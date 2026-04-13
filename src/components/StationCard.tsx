"use client";

import { ThresholdProbability, EnsembleData, KalshiStationData } from "@/lib/types";

interface StationCardProps {
  code: string;
  city: string;
  mtd: number | null;
  hasLiveData: boolean;
  ensemble: EnsembleData | null;
  qpfSum: number | null;
  thresholds: ThresholdProbability[];
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

function EdgeBadge({ edge }: { edge: number }) {
  const sign = edge >= 0 ? "+" : "";
  const label =
    Math.abs(edge) < 10
      ? `${sign}${edge.toFixed(1)}`
      : `${sign}${Math.round(edge)}`;
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

export default function StationCard({
  code,
  city,
  mtd,
  hasLiveData,
  ensemble,
  qpfSum,
  thresholds,
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
                          <EdgeBadge edge={edge} />
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
