"use client";

import {
  PolymarketApiResponse,
  StationProbabilities,
  KalshiStationData,
} from "@/lib/types";

interface NYCPolymarketPanelProps {
  polymarket: PolymarketApiResponse | null;
  nycProbs: StationProbabilities | null;
  nycKalshi: KalshiStationData | null;
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

/**
 * Compute the Kalshi implied bucket probability (in percent) by
 * differencing cumulative P(>=X) represented by yesAsk on NYC Kalshi
 * markets. NYC Kalshi only publishes 1/2/3/4" thresholds, so buckets
 * at or above 4-5" cannot be derived and return null.
 */
function kalshiBucketImpliedPct(
  label: string,
  kalshi: KalshiStationData | null,
): number | null {
  if (!kalshi) return null;
  const ask = (th: string): number | null => {
    const v = kalshi.thresholds[th]?.yesAsk;
    return typeof v === "number" ? v : null;
  };
  switch (label) {
    case "<2": {
      const p2 = ask("2.0");
      return p2 !== null ? 100 - p2 : null;
    }
    case "2-3": {
      const p2 = ask("2.0");
      const p3 = ask("3.0");
      return p2 !== null && p3 !== null ? p2 - p3 : null;
    }
    case "3-4": {
      const p3 = ask("3.0");
      const p4 = ask("4.0");
      return p3 !== null && p4 !== null ? p3 - p4 : null;
    }
    default:
      return null;
  }
}

function formatCents(v: number | null): string {
  if (v === null) return "—";
  return `${Math.round(v)}¢`;
}

function formatPct(v: number | null): string {
  if (v === null) return "—";
  return `${Math.round(v)}%`;
}

/**
 * Edge badge with intensity scaling — deep green at large positive
 * edges, deep red at large negative edges, near-neutral in the middle.
 * Magnitudes > 20pp get the strongest shade.
 */
function EdgeBadge({ edge }: { edge: number }) {
  let colorClasses: string;
  if (edge >= 20) colorClasses = "bg-green-700 text-white";
  else if (edge >= 10) colorClasses = "bg-green-500 text-white";
  else if (edge >= 5) colorClasses = "bg-green-200 text-green-900";
  else if (edge > -5) colorClasses = "bg-gray-100 text-gray-700";
  else if (edge > -10) colorClasses = "bg-red-200 text-red-900";
  else if (edge > -20) colorClasses = "bg-red-500 text-white";
  else colorClasses = "bg-red-700 text-white";
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

/**
 * Cross-market gap badge. Highlights potential arbitrage when
 * |gap| > 5pp; otherwise renders muted gray.
 */
function GapBadge({ gap }: { gap: number }) {
  const colorClasses =
    Math.abs(gap) > 5
      ? "bg-green-100 text-green-800"
      : "bg-gray-100 text-gray-600";
  const sign = gap >= 0 ? "+" : "";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums ${colorClasses}`}
    >
      {sign}
      {Math.round(gap)}
    </span>
  );
}

export default function NYCPolymarketPanel({
  polymarket,
  nycProbs,
  nycKalshi,
}: NYCPolymarketPanelProps) {
  const monthLabel = new Date().toLocaleString("en-US", { month: "long" });

  if (!polymarket || polymarket.outcomes.length === 0) {
    const detail = polymarket?.errorDetail;
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
          {detail ?? `NYC ${monthLabel} market not yet listed on Polymarket.`}
        </p>
        {polymarket?.slugsAttempted && polymarket.slugsAttempted.length > 1 && (
          <p className="text-xs text-gray-400 mt-1">
            Tried slugs: {polymarket.slugsAttempted.join(", ")}
          </p>
        )}
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
          NYC Polymarket — {monthLabel} rainfall buckets
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
                Kalshi Implied
              </th>
              <th className="py-1.5 px-3 font-medium text-right">
                Cross-market gap
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
              const kalshiImpliedPct = kalshiBucketImpliedPct(o.label, nycKalshi);
              const edge =
                modelPct !== null && o.yesAsk !== null
                  ? modelPct - o.yesAsk
                  : null;
              const gap =
                polyImpliedPct !== null && kalshiImpliedPct !== null
                  ? polyImpliedPct - kalshiImpliedPct
                  : null;

              const rowTint =
                edge !== null && edge > 5
                  ? "bg-green-50/60"
                  : edge !== null && edge < -5
                    ? "bg-red-50/60"
                    : "";

              return (
                <tr key={o.label} className={`text-gray-800 ${rowTint}`}>
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
                  <td className="py-1.5 px-3 text-right tabular-nums text-gray-600">
                    {formatPct(kalshiImpliedPct)}
                  </td>
                  <td className="py-1.5 px-3 text-right">
                    {gap !== null ? (
                      <GapBadge gap={gap} />
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-gray-900 font-medium">
                    {formatPct(modelPct)}
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    {edge !== null ? (
                      <EdgeBadge edge={edge} />
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-gray-400 mt-3 space-y-1">
        <p>
          Bucket probabilities are model cumulative P(≥X) differences. Edge =
          Model Implied − Polymarket yesAsk. Edge shading scales with
          magnitude; rows tinted green when edge &gt; +5, red when edge &lt; −5.
        </p>
        <p>
          Cross-market gap = Polymarket Implied − Kalshi Implied for the same
          outcome. Large gaps (|gap| &gt; 5) may indicate arbitrage.
        </p>
      </div>
    </div>
  );
}
