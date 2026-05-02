"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  HistoricalData,
  RainfallApiResponse,
  KalshiApiResponse,
  KalshiPortfolioResponse,
  PolymarketApiResponse,
  StationProbabilities,
  EnsoPhase,
} from "@/lib/types";
import { computeProbabilities } from "@/lib/probability";
import { STATIONS, THRESHOLDS } from "@/lib/stations";
import {
  ForecastSnapshot,
  saveSnapshot,
  loadSnapshots,
  computeAllConvergence,
  getDivergenceHistory,
  computeAllKalshiDeltas,
} from "@/lib/convergence";
import { computeAllMomentum } from "@/lib/momentum";
import StationCard from "./StationCard";
import CumulativeChart from "./CumulativeChart";
import TopMovers from "./TopMovers";
import NYCPolymarketPanel from "./NYCPolymarketPanel";

function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Convert a model run label like "12z" into an absolute UTC Date for the
 * most recent occurrence of that hour relative to `now`. If the hour hasn't
 * happened yet today in UTC, roll back to yesterday's run.
 */
function runLabelToTimestamp(label: string | null | undefined, now: Date): Date | null {
  if (!label) return null;
  const m = label.match(/^(\d{1,2})z$/i);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0)
  );
  if (candidate.getTime() > now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  return candidate;
}

function formatAge(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// Current ENSO phase — as of April 2026, neutral (transitioning from La Niña).
// Update this when ENSO state changes, or fetch dynamically in the future.
const CURRENT_ENSO_PHASE: EnsoPhase = "neutral";
const ENSO_LABEL: Record<EnsoPhase, string> = {
  nino: "El Niño",
  nina: "La Niña",
  neutral: "Neutral",
};

export default function Dashboard() {
  const [historical, setHistorical] = useState<HistoricalData | null>(null);
  const [rainfall, setRainfall] = useState<RainfallApiResponse | null>(null);
  const [kalshi, setKalshi] = useState<KalshiApiResponse | null>(null);
  const [portfolio, setPortfolio] = useState<KalshiPortfolioResponse | null>(null);
  const [polymarket, setPolymarket] = useState<PolymarketApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveDataFailed, setLiveDataFailed] = useState(false);
  const [serverSnapshots, setServerSnapshots] = useState<ForecastSnapshot[]>([]);

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const dayOfMonth = now.getDate();
  const dim = daysInMonth(month, year);
  const daysRemaining = dim - dayOfMonth;

  const fetchData = useCallback(async () => {
    try {
      // Always fetch historical first — it's the static JSON, will always work
      const histResp = await fetch("/data/historical-distributions.json");
      if (histResp.ok) {
        setHistorical(await histResp.json());
      } else {
        setError("Failed to load historical data");
        setLoading(false);
        return;
      }

      // Fetch live rainfall, Kalshi markets, Kalshi portfolio, and
      // Polymarket NYC buckets in parallel.
      const [rainResult, kalshiResult, portfolioResult, polymarketResult] =
        await Promise.allSettled([
          fetch("/api/fetch-rainfall"),
          fetch("/api/fetch-kalshi"),
          fetch("/api/fetch-portfolio"),
          fetch("/api/fetch-polymarket"),
        ]);

      if (rainResult.status === "fulfilled" && rainResult.value.ok) {
        setRainfall(await rainResult.value.json());
      } else {
        setLiveDataFailed(true);
      }

      if (kalshiResult.status === "fulfilled" && kalshiResult.value.ok) {
        setKalshi(await kalshiResult.value.json());
      }
      // Kalshi failure is non-fatal — we just don't show Market/Edge columns

      if (portfolioResult.status === "fulfilled" && portfolioResult.value.ok) {
        setPortfolio(await portfolioResult.value.json());
      }
      // Portfolio failure is non-fatal — positions just won't render

      if (polymarketResult.status === "fulfilled" && polymarketResult.value.ok) {
        setPolymarket(await polymarketResult.value.json());
      }
      // Polymarket failure is non-fatal — NYC panel hides when unavailable

      // Fetch server-side snapshots from Blob storage (non-blocking)
      try {
        const snapResp = await fetch("/api/snapshots");
        if (snapResp.ok) {
          const snapData = await snapResp.json();
          if (Array.isArray(snapData.snapshots)) {
            setServerSnapshots(snapData.snapshots);
          }
        }
      } catch {
        // Non-fatal — fall back to localStorage-only snapshots
      }
    } catch (e) {
      setError(`Error loading data: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Compute probabilities for each station (memoized for stable reference)
  const { stationProbs, mtdValues } = useMemo(() => {
    const probs: Record<string, StationProbabilities> = {};
    const mtds: Record<string, number | null> = {};

    for (const station of STATIONS) {
      const rainData = rainfall?.stations[station.code];
      const mtd = rainData?.mtd ?? null;
      const ensemble = rainData?.ensemble ?? null;
      const qpfSum = rainData?.qpfSum ?? null;

      mtds[station.code] = mtd;

      if (historical) {
        probs[station.code] = computeProbabilities(
          station.code,
          month,
          dayOfMonth,
          mtd ?? 0,
          ensemble,
          qpfSum,
          historical,
          CURRENT_ENSO_PHASE
        );
      }
    }

    return { stationProbs: probs, mtdValues: mtds };
  }, [historical, rainfall, month, dayOfMonth]);

  // Save forecast snapshot to localStorage on each successful fetch
  const snapshotSaved = useRef(false);
  useEffect(() => {
    if (rainfall && Object.keys(stationProbs).length > 0 && !snapshotSaved.current) {
      snapshotSaved.current = true;
      saveSnapshot(rainfall, stationProbs, kalshi, polymarket);
    }
  }, [rainfall, stationProbs, kalshi, polymarket]);

  // Compute convergence, momentum, and Kalshi delta metrics from snapshot history
  const { convergenceMap, divergenceHistories, momentumMap, kalshiDeltaMap, mergedSnapshots } = useMemo(() => {
    // Merge server-side (Blob) and client-side (localStorage) snapshots,
    // deduplicating by timestamp so we get a complete history
    const localSnaps = loadSnapshots();
    const seen = new Set(localSnaps.map((s) => s.timestamp));
    const merged = [...localSnaps];
    for (const s of serverSnapshots) {
      if (!seen.has(s.timestamp)) {
        merged.push(s);
      }
    }
    merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const snapshots = merged;

    // Build Kalshi threshold keys per station for convergence filtering
    const kalshiKeysPerStation: Record<string, string[]> = {};
    if (kalshi) {
      for (const [code, data] of Object.entries(kalshi.stations)) {
        kalshiKeysPerStation[code] = Object.keys(data.thresholds);
      }
    }

    const cMap = computeAllConvergence(snapshots, kalshiKeysPerStation);
    const dHist: Record<string, { t: string; div: number }[]> = {};
    for (const station of STATIONS) {
      const keys = kalshiKeysPerStation[station.code];
      const keySet = keys && keys.length > 0 ? new Set(keys) : null;
      dHist[station.code] = getDivergenceHistory(station.code, snapshots, keySet);
    }
    const mMap = computeAllMomentum(snapshots);
    const kMap = computeAllKalshiDeltas(snapshots);
    return {
      convergenceMap: cMap,
      divergenceHistories: dHist,
      momentumMap: mMap,
      kalshiDeltaMap: kMap,
      mergedSnapshots: snapshots,
    };
    // Re-compute after snapshot is saved (rainfall change triggers save)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rainfall, kalshi, serverSnapshots]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading rainfall data...</div>
      </div>
    );
  }

  if (error && !historical) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  const hasLiveData = rainfall && Object.values(rainfall.stations).some((s) => s.mtd !== null);

  const lastUpdated = rainfall?.fetchedAt
    ? new Date(rainfall.fetchedAt).toLocaleString()
    : null;

  // Compute the worst-case (oldest) model-run age across all stations and
  // both GEFS + ECMWF. Used to warn the user when forecasts are stale and
  // a newer run might be available.
  let oldestRunTs: Date | null = null;
  if (rainfall) {
    for (const station of Object.values(rainfall.stations)) {
      const runs = station.ensemble?.modelRuns;
      if (!runs) continue;
      for (const label of [runs.gefs, runs.ecmwf]) {
        const ts = runLabelToTimestamp(label, now);
        if (ts && (!oldestRunTs || ts.getTime() < oldestRunTs.getTime())) {
          oldestRunTs = ts;
        }
      }
    }
  }
  const modelAgeMs = oldestRunTs ? now.getTime() - oldestRunTs.getTime() : null;
  const modelAgeHours = modelAgeMs != null ? modelAgeMs / 3600000 : null;
  const modelAgeColor =
    modelAgeHours == null
      ? ""
      : modelAgeHours < 8
      ? "bg-green-100 text-green-700"
      : modelAgeHours < 14
      ? "bg-yellow-100 text-yellow-800"
      : "bg-red-100 text-red-700";

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            {now.toLocaleString("en-US", { month: "long", year: "numeric" })}{" "}
            Rainfall Tracker
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {daysRemaining} day{daysRemaining !== 1 ? "s" : ""} remaining
            {lastUpdated && <> &middot; Last updated: {lastUpdated}</>}
            {modelAgeMs != null && (
              <>
                {" "}&middot;{" "}
                <span className="inline-flex items-center gap-1">
                  <span className="text-gray-400">Model age:</span>
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${modelAgeColor}`}
                  >
                    {formatAge(modelAgeMs)}
                  </span>
                </span>
              </>
            )}
            {" "}&middot;{" "}
            <span className="inline-flex items-center gap-1">
              <span className="text-gray-400">ENSO:</span>
              <span className="inline-block px-1.5 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-700">
                {ENSO_LABEL[CURRENT_ENSO_PHASE]}
              </span>
            </span>
          </p>
          {liveDataFailed && (
            <p className="text-xs text-amber-600 mt-1">
              Live MTD data unavailable — showing climatological probabilities only
            </p>
          )}
          {!hasLiveData && !liveDataFailed && rainfall && (
            <p className="text-xs text-amber-600 mt-1">
              No MTD data for current month yet — showing climatological probabilities
            </p>
          )}
        </header>

        {/* Biggest movers across last two snapshots */}
        <TopMovers snapshots={mergedSnapshots} portfolio={portfolio} kalshi={kalshi} />

        {/* Station cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {STATIONS.map((station) => {
            const probs = stationProbs[station.code];
            const rainData = rainfall?.stations[station.code];

            // Look up gamma params for climatological stdev
            const dayDist = historical?.stations[station.code]
              ?.months[String(month)]?.days[String(dayOfMonth)] ?? null;
            const gamma = dayDist?.gamma ?? null;

            return (
              <div
                key={station.code}
                id={`station-${station.code}`}
                className="scroll-mt-4 rounded-lg transition-shadow"
              >
              <StationCard
                code={station.code}
                city={station.city}
                mtd={mtdValues[station.code]}
                hasLiveData={rainData?.mtd !== null && rainData?.mtd !== undefined}
                ensemble={rainData?.ensemble ?? null}
                qpfSum={rainData?.qpfSum ?? null}
                thresholds={
                  probs?.thresholds ?? THRESHOLDS.map((t) => ({
                    threshold: t,
                    remainingNeeded: t,
                    baseRate: 0,
                    ensembleProbability: 0,
                    climatologyProbability: 0,
                    gefsProb: null,
                    ecmwfProb: null,
                  }))
                }
                convergence={convergenceMap[station.code] ?? null}
                divergenceHistory={divergenceHistories[station.code] ?? []}
                momentum={momentumMap[station.code] ?? null}
                kalshiDeltas={kalshiDeltaMap[station.code] ?? null}
                kalshi={kalshi?.stations[station.code] ?? null}
                positions={portfolio?.positions ?? {}}
                snapshots={mergedSnapshots}
                lastDate={rainData?.lastUpdated ?? null}
                climoShape={gamma?.shape ?? null}
                climoScale={gamma?.scale ?? null}
                error={rainData?.error}
              />
              </div>
            );
          })}
        </div>

        {/* NYC Polymarket bucket panel */}
        <NYCPolymarketPanel
          polymarket={polymarket}
          nycProbs={stationProbs["NYC"] ?? null}
          nycKalshi={kalshi?.stations["NYC"] ?? null}
        />

        {/* Cumulative chart */}
        {historical && (
          <CumulativeChart
            historical={historical}
            stations={STATIONS.map((s) => s.code)}
            month={month}
            dayOfMonth={dayOfMonth}
            mtdValues={mtdValues}
          />
        )}

        {/* Footer */}
        <footer className="mt-8 pt-6 border-t border-gray-200 text-xs text-gray-400">
          <p>
            Data sources: IEM CLI Archive for live MTD, GEFS ensemble via
            Open-Meteo for probabilistic QPF, Kalshi for market prices,
            1991–2024 historical CLI distributions.
          </p>
          <p className="mt-1">
            Clim. = P(exceed | MTD, days remaining, ENSO phase) using
            gamma CDF. Base/Clim. rates are ENSO-conditioned
            ({ENSO_LABEL[CURRENT_ENSO_PHASE]} years only, falling back to
            all years when subset too small).
            Ensemble = average P(exceed) across GEFS+ECMWF members with
            ENSO-conditioned climatology tail. Ensemble forecasts weighted
            by lead-time skill (verified against 2 years of observations).
            Market = Kalshi mid-price. Edge = Ensemble &minus; Market.
          </p>
        </footer>
      </div>
    </div>
  );
}
