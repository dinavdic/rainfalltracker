"use client";

import { useMemo } from "react";
import { ForecastSnapshot } from "@/lib/convergence";

interface Mover {
  stationCode: string;
  thresholdKey: string;
  thresholdLabel: string;
  prevProb: number; // 0-1
  currProb: number; // 0-1
  changePp: number; // in percentage points, signed
  marketPct: number | null; // 0-100 (cents)
  edge: number | null; // percentage points, signed
}

interface TopMoversProps {
  snapshots: ForecastSnapshot[];
}

const TOP_N = 10;
const MIN_CHANGE_PP = 2; // filter out noise below 2pp
const SIGNIFICANT_PP = 5; // summary line threshold

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
  // Brief highlight so the user can locate the card
  el.classList.add("ring-2", "ring-blue-400", "ring-offset-2");
  setTimeout(() => {
    el.classList.remove("ring-2", "ring-blue-400", "ring-offset-2");
  }, 1500);
}

export default function TopMovers({ snapshots }: TopMoversProps) {
  const { movers, totalMoved, totalTracked, prev, curr } = useMemo(() => {
    if (snapshots.length < 2) {
      return {
        movers: [] as Mover[],
        totalMoved: 0,
        totalTracked: 0,
        prev: null as ForecastSnapshot | null,
        curr: null as ForecastSnapshot | null,
      };
    }

    const sorted = [...snapshots].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const currSnap = sorted[sorted.length - 1];
    const prevSnap = sorted[sorted.length - 2];

    const allMovers: Mover[] = [];
    let tracked = 0;
    let moved = 0;

    for (const [code, currStation] of Object.entries(currSnap.stations)) {
      const prevStation = prevSnap.stations[code];
      if (!prevStation) continue;
      for (const [threshKey, currT] of Object.entries(currStation.thresholds)) {
        const prevT = prevStation.thresholds[threshKey];
        if (!prevT) continue;
        tracked++;
        const changePp = (currT.combinedProb - prevT.combinedProb) * 100;
        if (Math.abs(changePp) >= SIGNIFICANT_PP) moved++;
        if (Math.abs(changePp) < MIN_CHANGE_PP) continue;

        const marketCents = currStation.kalshiPrices?.[threshKey] ?? null;
        const marketPct = marketCents != null ? marketCents : null;
        const edge =
          marketPct != null ? currT.combinedProb * 100 - marketPct : null;

        allMovers.push({
          stationCode: code,
          thresholdKey: threshKey,
          thresholdLabel: formatThresholdLabel(threshKey),
          prevProb: prevT.combinedProb,
          currProb: currT.combinedProb,
          changePp,
          marketPct,
          edge,
        });
      }
    }

    allMovers.sort((a, b) => Math.abs(b.changePp) - Math.abs(a.changePp));
    return {
      movers: allMovers.slice(0, TOP_N),
      totalMoved: moved,
      totalTracked: tracked,
      prev: prevSnap,
      curr: currSnap,
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

  const tsCurr = curr ? new Date(curr.timestamp).toLocaleString() : "";
  const tsPrev = prev ? new Date(prev.timestamp).toLocaleString() : "";

  return (
    <section className="mb-6 bg-white border border-gray-200 rounded-lg px-4 py-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-900">
          Biggest Movers <span className="text-gray-400 font-normal">(last update)</span>
        </h2>
        <span className="text-xs text-gray-400">
          {tsPrev} → {tsCurr}
        </span>
      </div>

      {movers.length === 0 ? (
        <p className="text-xs text-gray-500 mt-2">
          No probabilities moved &gt;{MIN_CHANGE_PP}pp since last update.
        </p>
      ) : (
        <div
          className="mt-2 flex gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible"
          role="list"
        >
          {movers.map((m) => {
            const up = m.changePp > 0;
            const containerCls = up
              ? "bg-green-50 border-green-200 hover:bg-green-100"
              : "bg-red-50 border-red-200 hover:bg-red-100";
            const deltaCls = up ? "text-green-700" : "text-red-700";
            const arrow = up ? "▲" : "▼";
            return (
              <button
                type="button"
                role="listitem"
                key={`${m.stationCode}-${m.thresholdKey}`}
                onClick={() => scrollToStation(m.stationCode)}
                className={
                  "flex-shrink-0 min-w-[12rem] text-left border rounded-md px-3 py-2 " +
                  "transition-colors cursor-pointer " +
                  containerCls
                }
                title={`Jump to ${m.stationCode}`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-bold text-gray-900">
                    {m.stationCode}
                  </span>
                  <span className="text-xs text-gray-600">
                    {m.thresholdLabel}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-xs text-gray-700">
                  <span>{Math.round(m.prevProb * 100)}%</span>
                  <span className="text-gray-400">→</span>
                  <span className="font-medium">
                    {Math.round(m.currProb * 100)}%
                  </span>
                  <span className={`ml-auto font-semibold ${deltaCls}`}>
                    {arrow}
                    {Math.abs(m.changePp).toFixed(0)}pp
                  </span>
                </div>
                {m.marketPct != null && m.edge != null && (
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    Market: {Math.round(m.marketPct)}% &middot; Edge:{" "}
                    <span
                      className={
                        m.edge >= 0 ? "text-green-600" : "text-red-600"
                      }
                    >
                      {m.edge >= 0 ? "+" : ""}
                      {Math.round(m.edge)}
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-gray-500 mt-2">
        {totalMoved} of {totalTracked} thresholds moved &gt;{SIGNIFICANT_PP}pp
        since last update
      </p>
    </section>
  );
}
