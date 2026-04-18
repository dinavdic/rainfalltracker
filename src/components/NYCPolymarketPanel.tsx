"use client";

import { PolymarketApiResponse } from "@/lib/types";
import { StationProbabilities } from "@/lib/types";

interface NYCPolymarketPanelProps {
  polymarket: PolymarketApiResponse | null;
  nycProbs: StationProbabilities | null;
}

/**
 * Compute mutually-exclusive bucket probability from cumulative
 * threshold probabilities. Uses:
 *   <2:   1 - P(>=2)
 *   2-3:  P(>=2) - P(>=3)
 *   3-4:  P(>=3) - P(>=4)
 *   4-5:  P(>=4) - P(>=5)
 *   5-6:  P(>=5) - P(>=6)
 *   >6:   P(>=6)
 *
 * Returns a value in [0, 1], or null if the required cumulative
 * probabilities are unavailable.
 */
function bucketProbFromCumulative(
  lowerBound: number | null,
  upperBound: number | null,
  cumulativeByThreshold: Record<string, number>,
): number | null {
  const get = (th: number): number | null => {
    const key = th.toFixed(1);
    const v = cumulativeByThreshold[key];
    return typeof v === "number" ? v : null;
  };

  // <X: 1 - P(>=X)
  if (lowerBound === null && upperBound !== null) {
    const upper = get(upperBound);
    if (upper === null) return null;
    return Math.max(0, Math.min(1, 1 - upper));
  }
  // >X: P(>=X)
  if (lowerBound !== null && upperBound === null) {
    const lower = get(lowerBound);
    if (lower === null) return null;
    return Math.max(0, Math.min(1, lower));
  }
  // [X, Y): P(>=X) - P(>=Y)
  if (lowerBound !== null && upperBound !== null) {
    const lower = get(lowerBound);
    const upper = get(upperBound);
    if (lower === null || upper === null) return null;
    return Math.max(0, Math.min(1, lower - upper));
  }
  return null;
}

function formatCents(v: number | null): string {
  if (v === null) return "—";
  return `${Math.round(v)}¢`;
}

function formatPct(v: number | null): string {
  if (v === null) return "—";
  return `${Math.round(v)}%`;
}

function EdgeBadge({ edge }: { edge: number }) {
  let colorClasses = "text-gray-700 bg-gray-100";
  if (edge > 5) colorClasses = "text-green-700 bg-green-100";
  else if (edge < -5) colorClasses = "text-red-700 bg-red-100";
  const sign = edge >= 0 ? "+" : "";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums ${colorClasses}`}
    >
      {sign}
      {Math.round(edge)}
    </span>
  );
}

export default function NYCPolymarketPanel({
  polymarket,
  nycProbs,
}: NYCPolymarketPanelProps) {
  if (!polymarket || polymarket.outcomes.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-4 mb-8">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-lg font-semibold text-gray-900">
            NYC Polymarket
          </h2>
          <span className="text-xs text-gray-400">
            {polymarket?.error ? `error: ${polymarket.error}` : "no data"}
          </span>
        </div>
        <p className="text-sm text-gray-500">
          Polymarket April rainfall bucket markets unavailable.
        </p>
      </div>
    );
  }

  // Build a { "2.0": P(>=2), "3.0": P(>=3), ... } map from NYC thresholds.
  const cumulativeByThreshold: Record<string, number> = {};
  if (nycProbs) {
    for (const t of nycProbs.thresholds) {
      cumulativeByThreshold[t.threshold.toFixed(1)] = t.ensembleProbability;
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-4 mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">
          NYC Polymarket — April rainfall buckets
        </h2>
        <span className="text-xs text-gray-400">
          {new Date(polymarket.fetchedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-1.5 pr-3 font-medium">Bucket</th>
              <th className="py-1.5 px-3 font-medium text-right">
                Polymarket Yes (¢)
              </th>
              <th className="py-1.5 px-3 font-medium text-right">
                Polymarket Implied
              </th>
              <th className="py-1.5 px-3 font-medium text-right">
                Model Implied
              </th>
              <th className="py-1.5 pl-3 font-medium text-right">Edge</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {polymarket.outcomes.map((o) => {
              const modelProb = bucketProbFromCumulative(
                o.lowerBound,
                o.upperBound,
                cumulativeByThreshold,
              );
              const modelPct = modelProb !== null ? modelProb * 100 : null;
              const polyImpliedPct =
                o.yesAsk !== null
                  ? o.yesAsk
                  : o.yesBid !== null
                    ? o.yesBid
                    : o.lastPrice;
              const edge =
                modelPct !== null && o.yesAsk !== null
                  ? modelPct - o.yesAsk
                  : null;
              return (
                <tr key={o.label} className="text-gray-800">
                  <td className="py-1.5 pr-3 font-medium tabular-nums">
                    {o.label}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums">
                    {o.yesBid !== null || o.yesAsk !== null ? (
                      <>
                        <span className="text-gray-500">
                          {formatCents(o.yesBid)}
                        </span>
                        <span className="text-gray-300 mx-1">/</span>
                        <span className="text-gray-900 font-medium">
                          {formatCents(o.yesAsk)}
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-400">
                        {formatCents(o.lastPrice)}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-gray-600">
                    {formatPct(polyImpliedPct)}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-gray-900 font-medium">
                    {formatPct(modelPct)}
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    {edge !== null ? <EdgeBadge edge={edge} /> : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400 mt-3">
        Bucket probabilities are model cumulative P(≥X) differences. Edge =
        Model Implied − Polymarket yesAsk. Green: edge &gt; +5. Red: edge &lt; −5.
      </p>
    </div>
  );
}
