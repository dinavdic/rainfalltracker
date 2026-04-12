"use client";

import { ThresholdProbability, EnsembleData } from "@/lib/types";

interface StationCardProps {
  code: string;
  city: string;
  mtd: number | null;
  hasLiveData: boolean;
  ensemble: EnsembleData | null;
  qpfSum: number | null; // NWS fallback
  thresholds: ThresholdProbability[];
  lastDate: string | null;
  error?: string;
}

function ProbabilityBadge({ value }: { value: number }) {
  const pct = value * 100;
  const rounded = Math.round(pct);
  // Show 1 decimal place for values under 10% to avoid misleading 0% vs 3% gaps
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

export default function StationCard({
  code,
  city,
  mtd,
  hasLiveData,
  ensemble,
  qpfSum,
  thresholds,
  lastDate,
  error,
}: StationCardProps) {
  const mtdValue = mtd ?? 0;
  const progressPct = Math.min((mtdValue / 5.0) * 100, 100);
  const hasForecast = ensemble !== null || qpfSum !== null;

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
          </tr>
        </thead>
        <tbody>
          {thresholds.map((t) => (
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
                  return pct > 0 && pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
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
            </tr>
          ))}
        </tbody>
      </table>

      {/* Forecast summary line */}
      <div className="text-xs text-gray-400">
        {ensemble ? (
          <>
            Ensemble QPF: {ensemble.stats.median.toFixed(2)}&quot;{" "}
            <span className="text-gray-300">
              ({ensemble.stats.p10.toFixed(2)}&quot; &ndash;{" "}
              {ensemble.stats.p90.toFixed(2)}&quot;)
            </span>
          </>
        ) : qpfSum !== null ? (
          <>NWS QPF (fallback): {qpfSum.toFixed(2)}&quot;</>
        ) : (
          "Forecast unavailable"
        )}
      </div>
    </div>
  );
}
