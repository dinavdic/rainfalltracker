"use client";

import { useMemo } from "react";
import { ForecastSnapshot } from "@/lib/convergence";
import {
  KalshiApiResponse,
  KalshiPortfolioResponse,
} from "@/lib/types";

// --- Shared types & helpers ---

interface ModelMover {
  stationCode: string;
  thresholdKey: string;
  thresholdLabel: string;
  prevProb: number; // 0-1
  currProb: number; // 0-1
  changePp: number; // percentage points, signed
}

interface MarketMover {
  stationCode: string;
  thresholdKey: string;
  thresholdLabel: string;
  prevCents: number;
  currCents: number;
  changeCents: number; // signed
}

interface PositionMover {
  stationCode: string;
  thresholdKey: string;
  thresholdLabel: string;
  side: "YES" | "NO";
  qty: number;
  currValue: number; // dollars
  prevValue: number; // dollars
  pctChange: number; // percent, signed
  edge: number | null; // pp, signed
  prevEdge: number | null; // pp, signed
  edgeChange: number | null; // pp, signed
  edgeCompressed: boolean; // true when edge is within -3 to +3
}

interface TopMoversProps {
  snapshots: ForecastSnapshot[];
  portfolio: KalshiPortfolioResponse | null;
  kalshi: KalshiApiResponse | null;
}

const MODEL_TOP_N = 5;
const MARKET_TOP_N = 5;
const POSITION_TOP_N = 5;
const MODEL_MIN_PP = 1;
const MARKET_MIN_CENTS = 1;

function formatThresholdLabel(key: string): string {
  const n = parseFloat(key);
  if (!Number.isFinite(n)) return `>${key}"`;
  return `>${Number.isInteger(n) ? n.toFixed(0) : String(n)}"`;
}

function scrollToStation(code: string) {
  if (typeof window === "undefined") return;
  const el = document.getElementById(`station-${code}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("ring-2", "ring-blue-400", "ring-offset-2");
  setTimeout(() => {
    el.classList.remove("ring-2", "ring-blue-400", "ring-offset-2");
  }, 1500);
}

function hasEnsembleData(snap: ForecastSnapshot): boolean {
  for (const station of Object.values(snap.stations)) {
    for (const t of Object.values(station.thresholds)) {
      if (t.combinedProb !== 0) return true;
    }
  }
  return false;
}

function ensembleChanged(a: ForecastSnapshot, b: ForecastSnapshot): boolean {
  for (const [code, bStation] of Object.entries(b.stations)) {
    const aStation = a.stations[code];
    if (!aStation) continue;
    for (const [threshKey, bT] of Object.entries(bStation.thresholds)) {
      const aT = aStation.thresholds[threshKey];
      if (!aT) continue;
      if (Math.abs(bT.combinedProb - aT.combinedProb) > 1e-6) return true;
    }
  }
  return false;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Build a reverse lookup: ticker → { stationCode, thresholdKey }
 * from the live Kalshi API response.
 */
function buildTickerMap(
  kalshi: KalshiApiResponse,
): Map<string, { stationCode: string; thresholdKey: string }> {
  const map = new Map<string, { stationCode: string; thresholdKey: string }>();
  for (const [stationCode, stationData] of Object.entries(kalshi.stations)) {
    for (const [thresholdKey, price] of Object.entries(stationData.thresholds)) {
      map.set(price.ticker, { stationCode, thresholdKey });
    }
  }
  return map;
}

// --- Component ---

export default function TopMovers({
  snapshots,
  portfolio,
  kalshi,
}: TopMoversProps) {
  const {
    modelMovers,
    marketMovers,
    positionMovers,
    modelTimeRange,
    marketTimeRange,
    positionTimeRange,
  } = useMemo(() => {
    const empty = {
      modelMovers: [] as ModelMover[],
      marketMovers: [] as MarketMover[],
      positionMovers: [] as PositionMover[],
      modelTimeRange: null as { from: string; to: string } | null,
      marketTimeRange: null as { from: string; to: string } | null,
      positionTimeRange: null as { from: string; to: string } | null,
    };

    if (snapshots.length < 2) return empty;

    const sorted = [...snapshots].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const curr = sorted[sorted.length - 1];

    // --- Model Movers ---
    let modelPrev: ForecastSnapshot | null = null;
    if (hasEnsembleData(curr)) {
      for (let i = sorted.length - 2; i >= 0; i--) {
        if (hasEnsembleData(sorted[i]) && ensembleChanged(sorted[i], curr)) {
          modelPrev = sorted[i];
          break;
        }
      }
    }

    const mMovers: ModelMover[] = [];
    if (modelPrev) {
      for (const [code, currStation] of Object.entries(curr.stations)) {
        const prevStation = modelPrev.stations[code];
        if (!prevStation) continue;
        for (const [threshKey, currT] of Object.entries(
          currStation.thresholds,
        )) {
          const prevT = prevStation.thresholds[threshKey];
          if (!prevT) continue;
          const changePp = (currT.combinedProb - prevT.combinedProb) * 100;
          if (Math.abs(changePp) < MODEL_MIN_PP) continue;
          mMovers.push({
            stationCode: code,
            thresholdKey: threshKey,
            thresholdLabel: formatThresholdLabel(threshKey),
            prevProb: prevT.combinedProb,
            currProb: currT.combinedProb,
            changePp,
          });
        }
      }
      mMovers.sort((a, b) => Math.abs(b.changePp) - Math.abs(a.changePp));
    }

    // --- Market Movers: compare to ~6 hours ago (36 snapshots back). ---
    const marketIdx = Math.max(0, sorted.length - 37);
    const marketPrev = sorted[marketIdx];
    const mkMovers: MarketMover[] = [];

    if (marketPrev !== curr) {
      for (const [code, currStation] of Object.entries(curr.stations)) {
        const prevStation = marketPrev.stations[code];
        if (!prevStation) continue;
        const currPrices = currStation.kalshiPrices;
        const prevPrices = prevStation.kalshiPrices;
        if (!currPrices || !prevPrices) continue;
        for (const threshKey of Object.keys(currPrices)) {
          const currCents = currPrices[threshKey];
          const prevCents = prevPrices[threshKey];
          if (currCents == null || prevCents == null) continue;
          const changeCents = currCents - prevCents;
          if (Math.abs(changeCents) < MARKET_MIN_CENTS) continue;
          mkMovers.push({
            stationCode: code,
            thresholdKey: threshKey,
            thresholdLabel: formatThresholdLabel(threshKey),
            prevCents,
            currCents,
            changeCents,
          });
        }
      }
      mkMovers.sort(
        (a, b) => Math.abs(b.changeCents) - Math.abs(a.changeCents),
      );
    }

    // --- Position Movers ---
    const posMovers: PositionMover[] = [];
    const positions = portfolio?.positions;
    const tickerMap = kalshi ? buildTickerMap(kalshi) : null;
    // Use same 36-snapshot-back window as market movers
    const posPrev = marketPrev !== curr ? marketPrev : null;

    if (positions && tickerMap && posPrev) {
      for (const [ticker, pos] of Object.entries(positions)) {
        if (pos.position === 0) continue;
        const mapping = tickerMap.get(ticker);
        if (!mapping) continue;
        const { stationCode, thresholdKey } = mapping;

        const side: "YES" | "NO" = pos.position > 0 ? "YES" : "NO";
        const qty = Math.abs(pos.position);

        // Current value from latest snapshot's kalshiPrices (mid-price in cents)
        const currStation = curr.stations[stationCode];
        const prevStation = posPrev.stations[stationCode];
        if (!currStation || !prevStation) continue;

        const currMidCents = currStation.kalshiPrices?.[thresholdKey];
        const prevMidCents = prevStation.kalshiPrices?.[thresholdKey];
        if (currMidCents == null || prevMidCents == null) continue;

        // kalshiPrices stores YES mid-price. NO mid = 100 - YES mid.
        const currSideCents = side === "YES" ? currMidCents : 100 - currMidCents;
        const prevSideCents = side === "YES" ? prevMidCents : 100 - prevMidCents;

        const currValue = (qty * currSideCents) / 100;
        const prevValue = (qty * prevSideCents) / 100;
        const pctChange =
          prevValue !== 0 ? ((currValue - prevValue) / prevValue) * 100 : 0;

        // Edge: ensemble prob (as %) minus market YES mid (as %)
        const currThresh = currStation.thresholds[thresholdKey];
        const prevThresh = prevStation.thresholds[thresholdKey];

        let edge: number | null = null;
        if (currThresh && currMidCents != null) {
          edge = currThresh.combinedProb * 100 - currMidCents;
        }

        let prevEdge: number | null = null;
        if (prevThresh && prevMidCents != null) {
          prevEdge = prevThresh.combinedProb * 100 - prevMidCents;
        }

        const edgeChange =
          edge !== null && prevEdge !== null ? edge - prevEdge : null;
        const edgeCompressed = edge !== null && edge > -3 && edge < 3;

        posMovers.push({
          stationCode,
          thresholdKey,
          thresholdLabel: formatThresholdLabel(thresholdKey),
          side,
          qty,
          currValue,
          prevValue,
          pctChange,
          edge,
          prevEdge,
          edgeChange,
          edgeCompressed,
        });
      }
      posMovers.sort(
        (a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange),
      );
    }

    return {
      modelMovers: mMovers.slice(0, MODEL_TOP_N),
      marketMovers: mkMovers.slice(0, MARKET_TOP_N),
      positionMovers: posMovers.slice(0, POSITION_TOP_N),
      modelTimeRange: modelPrev
        ? { from: modelPrev.timestamp, to: curr.timestamp }
        : null,
      marketTimeRange:
        marketPrev !== curr
          ? { from: marketPrev.timestamp, to: curr.timestamp }
          : null,
      positionTimeRange:
        posPrev
          ? { from: posPrev.timestamp, to: curr.timestamp }
          : null,
    };
  }, [snapshots, portfolio, kalshi]);

  if (snapshots.length < 2) {
    return (
      <section className="mb-6 bg-white border border-gray-200 rounded-lg px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Biggest Movers</h2>
        <p className="text-xs text-gray-500 mt-1">
          Waiting for snapshot history...
        </p>
      </section>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
      {/* Model Movers */}
      <section className="bg-white border border-gray-200 rounded-lg px-4 py-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">
            Biggest Model Movers
          </h2>
          {modelTimeRange && (
            <span className="text-xs text-gray-400">
              {formatTime(modelTimeRange.from)} →{" "}
              {formatTime(modelTimeRange.to)}
            </span>
          )}
        </div>

        {modelMovers.length === 0 ? (
          <p className="text-xs text-gray-500 mt-2">
            No ensemble probabilities changed since last model refresh.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5" role="list">
            {modelMovers.map((m) => {
              const up = m.changePp > 0;
              const bgCls = up
                ? "bg-green-50 border-green-200 hover:bg-green-100"
                : "bg-red-50 border-red-200 hover:bg-red-100";
              const deltaCls = up ? "text-green-700" : "text-red-700";
              const arrow = up ? "▲" : "▼";
              return (
                <button
                  type="button"
                  role="listitem"
                  key={`model-${m.stationCode}-${m.thresholdKey}`}
                  onClick={() => scrollToStation(m.stationCode)}
                  className={
                    "w-full text-left border rounded-md px-3 py-1.5 " +
                    "transition-colors cursor-pointer " +
                    bgCls
                  }
                  title={`Jump to ${m.stationCode}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-2">
                      <span className="font-bold text-gray-900 text-sm">
                        {m.stationCode}
                      </span>
                      <span className="text-xs text-gray-600">
                        {m.thresholdLabel}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-gray-700">
                      <span>{Math.round(m.prevProb * 100)}%</span>
                      <span className="text-gray-400">→</span>
                      <span className="font-medium">
                        {Math.round(m.currProb * 100)}%
                      </span>
                      <span className={`font-semibold ${deltaCls}`}>
                        {arrow}
                        {Math.abs(m.changePp).toFixed(0)}pp
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Market Movers */}
      <section className="bg-white border border-gray-200 rounded-lg px-4 py-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">
            Biggest Market Movers
          </h2>
          {marketTimeRange && (
            <span className="text-xs text-gray-400">
              {formatTime(marketTimeRange.from)} →{" "}
              {formatTime(marketTimeRange.to)}
            </span>
          )}
        </div>

        {marketMovers.length === 0 ? (
          <p className="text-xs text-gray-500 mt-2">
            No Kalshi price moves in the last 6 hours.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5" role="list">
            {marketMovers.map((m) => {
              const up = m.changeCents > 0;
              const bgCls = up
                ? "bg-green-50 border-green-200 hover:bg-green-100"
                : "bg-red-50 border-red-200 hover:bg-red-100";
              const deltaCls = up ? "text-green-700" : "text-red-700";
              const arrow = up ? "▲" : "▼";
              return (
                <button
                  type="button"
                  role="listitem"
                  key={`market-${m.stationCode}-${m.thresholdKey}`}
                  onClick={() => scrollToStation(m.stationCode)}
                  className={
                    "w-full text-left border rounded-md px-3 py-1.5 " +
                    "transition-colors cursor-pointer " +
                    bgCls
                  }
                  title={`Jump to ${m.stationCode}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-2">
                      <span className="font-bold text-gray-900 text-sm">
                        {m.stationCode}
                      </span>
                      <span className="text-xs text-gray-600">
                        {m.thresholdLabel}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-gray-700">
                      <span>{m.prevCents}¢</span>
                      <span className="text-gray-400">→</span>
                      <span className="font-medium">{m.currCents}¢</span>
                      <span className={`font-semibold ${deltaCls}`}>
                        {arrow}
                        {Math.abs(m.changeCents)}¢
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Position Movers */}
      <section className="bg-white border border-gray-200 rounded-lg px-4 py-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">
            Biggest Position Movers
          </h2>
          {positionTimeRange && (
            <span className="text-xs text-gray-400">
              {formatTime(positionTimeRange.from)} →{" "}
              {formatTime(positionTimeRange.to)}
            </span>
          )}
        </div>

        {!portfolio?.positions ||
        Object.keys(portfolio.positions).length === 0 ? (
          <p className="text-xs text-gray-500 mt-2">No open positions.</p>
        ) : positionMovers.length === 0 ? (
          <p className="text-xs text-gray-500 mt-2">
            No position value changes in the last 6 hours.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5" role="list">
            {positionMovers.map((m) => {
              const up = m.pctChange > 0;
              const bgCls = up
                ? "bg-green-50 border-green-200 hover:bg-green-100"
                : "bg-red-50 border-red-200 hover:bg-red-100";
              const deltaCls = up ? "text-green-700" : "text-red-700";
              const sideColor =
                m.side === "YES" ? "text-green-700" : "text-red-700";
              return (
                <button
                  type="button"
                  role="listitem"
                  key={`pos-${m.stationCode}-${m.thresholdKey}`}
                  onClick={() => scrollToStation(m.stationCode)}
                  className={
                    "w-full text-left border rounded-md px-3 py-1.5 " +
                    "transition-colors cursor-pointer " +
                    bgCls
                  }
                  title={`Jump to ${m.stationCode}`}
                >
                  {/* Row 1: Station, threshold, side, value + % change */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-bold text-gray-900 text-sm">
                        {m.stationCode}
                      </span>
                      <span className="text-xs text-gray-600">
                        {m.thresholdLabel}
                      </span>
                      <span
                        className={`text-[10px] font-semibold ${sideColor}`}
                      >
                        {m.side}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className={`font-semibold ${deltaCls}`}>
                        ${Math.round(m.currValue)}
                      </span>
                      <span className={`font-semibold ${deltaCls}`}>
                        {m.pctChange >= 0 ? "+" : ""}
                        {m.pctChange.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  {/* Row 2: Edge + edge change + compressed badge */}
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-500">
                    {m.edge !== null && (
                      <span>
                        Edge:{" "}
                        <span
                          className={
                            m.edge >= 0 ? "text-green-600" : "text-red-600"
                          }
                        >
                          {m.edge >= 0 ? "+" : ""}
                          {m.edge.toFixed(0)}
                        </span>
                      </span>
                    )}
                    {m.edgeChange !== null && (
                      <span className="text-gray-400">
                        ({m.edgeChange >= 0 ? "+" : ""}
                        {m.edgeChange.toFixed(0)} 6h)
                      </span>
                    )}
                    {m.edgeCompressed && (
                      <span className="ml-auto px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 text-[10px] font-medium whitespace-nowrap">
                        Edge compressed
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
