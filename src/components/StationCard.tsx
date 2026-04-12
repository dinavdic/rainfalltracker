"use client";

import { ThresholdProbability } from "@/lib/types";

interface StationCardProps {
  code: string;
  city: string;
  mtd: number | null;
  qpfSum: number;
  thresholds: ThresholdProbability[];
  error?: string;
}

function ProbabilityBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  let colorClasses: string;

  if (pct >= 60) {
    colorClasses = "bg-green-100 text-green-800";
  } else if (pct >= 25) {
    colorClasses = "bg-amber-100 text-amber-800";
  } else {
    colorClasses = "bg-red-100 text-red-800";
  }

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${colorClasses}`}
    >
      {pct}%
    </span>
  );
}

export default function StationCard({
  code,
  city,
  mtd,
  qpfSum,
  thresholds,
  error,
}: StationCardProps) {
  const mtdValue = mtd ?? 0;
  const progressPct = Math.min((mtdValue / 3.0) * 100, 100);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-2xl font-bold text-gray-900">{code}</span>
        <span className="text-sm text-gray-500">{city}</span>
      </div>

      {error && mtd === null ? (
        <div className="text-sm text-gray-400 mb-3">Data unavailable</div>
      ) : (
        <>
          <div className="mb-3">
            <span className="text-3xl font-semibold text-gray-900">
              {mtdValue.toFixed(2)}
            </span>
            <span className="text-sm text-gray-500 ml-1">inches MTD</span>
          </div>

          {/* Progress bar */}
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
            <th className="text-right pb-1 font-medium">P(exceed)</th>
          </tr>
        </thead>
        <tbody>
          {thresholds.map((t) => (
            <tr key={t.threshold} className="border-t border-gray-50">
              <td className="py-1.5 text-gray-700">{`>${t.threshold}"`}</td>
              <td className="py-1.5 text-right text-gray-600">
                {t.remainingNeeded === null ? (
                  <span className="text-green-600 font-medium">&mdash;</span>
                ) : (
                  `${t.remainingNeeded.toFixed(2)}"`
                )}
              </td>
              <td className="py-1.5 text-right text-gray-500">
                {Math.round(t.baseRate * 100)}%
              </td>
              <td className="py-1.5 text-right">
                <ProbabilityBadge value={t.blendedProbability} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* QPF line */}
      <div className="text-xs text-gray-400">
        7-day QPF: {qpfSum.toFixed(2)}&quot;
      </div>
    </div>
  );
}
