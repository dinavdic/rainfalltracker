"use client";

import { useMemo } from "react";
import { ForecastSnapshot } from "@/lib/convergence";

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

interface TopMoversProps {
  snapshots: ForecastSnapshot[];
}

const MODEL_TOP_N = 5;
const MARKET_TOP_N = 5;
const MODEL_MIN_PP = 1; // filter noise below 1pp
const MARKET_MIN_CENTS = 1; // filter noise below 1 cent

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

/**
 * Check whether a snapshot has non-null ensemble data (combinedProb)
 * on at least one station-threshold.
 */
function hasEnsembleData(snap: ForecastSnapshot): boolean {
  for (const station of Object.values(snap.stations)) {
    for (const t of Object.values(station.thresholds)) {
      if (t.combinedProb !== 0) return true;
    }
  }
  return false;
}

/**
 * Check whether the ensemble probabilities differ between two snapshots
 * on at least one station-threshold (i.e., model data actually changed).
 */
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

// --- Component ---

export default function TopMovers({ snapshots }: TopMoversProps) {
  const { modelMovers, marketMovers, modelTimeRange, marketTimeRange } =
    useMemo(() => {
      const empty = {
        modelMovers: [] as ModelMover[],
        marketMovers: [] as MarketMover[],
        modelTimeRange: null as { from: string; to: string } | null,
        marketTimeRange: null as { from: string; to: string } | null,
      };

      if (snapshots.length < 2) return empty;

      const sorted = [...snapshots].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
      const curr = sorted[sorted.length - 1];

      // --- Model Movers: find most recent snapshot where ensemble data
      //     differs from current (i.e., the last model refresh boundary). ---
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

      // --- Market Movers: compare Kalshi prices ~1 hour ago (6 snapshots back). ---
      const marketIdx = Math.max(0, sorted.length - 7); // 6 back from current
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

      return {
        modelMovers: mMovers.slice(0, MODEL_TOP_N),
        marketMovers: mkMovers.slice(0, MARKET_TOP_N),
        modelTimeRange: modelPrev
          ? { from: modelPrev.timestamp, to: curr.timestamp }
          : null,
        marketTimeRange:
          marketPrev !== curr
            ? { from: marketPrev.timestamp, to: curr.timestamp }
            : null,
      };
    }, [snapshots]);

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
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
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
          <div
            className="mt-2 flex flex-col gap-1.5"
            role="list"
          >
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
            No Kalshi price moves in the last hour.
          </p>
        ) : (
          <div
            className="mt-2 flex flex-col gap-1.5"
            role="list"
          >
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
    </div>
  );
}
