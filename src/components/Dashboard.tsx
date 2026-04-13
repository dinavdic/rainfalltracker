"use client";

import { useState, useEffect, useCallback } from "react";
import {
  HistoricalData,
  RainfallApiResponse,
  KalshiApiResponse,
  StationProbabilities,
  EnsoPhase,
} from "@/lib/types";
import { computeProbabilities } from "@/lib/probability";
import { STATIONS, THRESHOLDS } from "@/lib/stations";
import StationCard from "./StationCard";
import CumulativeChart from "./CumulativeChart";

const MONTH_NAMES = [
  "",
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveDataFailed, setLiveDataFailed] = useState(false);

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

      // Fetch live rainfall and Kalshi data in parallel
      const [rainResult, kalshiResult] = await Promise.allSettled([
        fetch("/api/fetch-rainfall"),
        fetch("/api/fetch-kalshi"),
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
    } catch (e) {
      setError(`Error loading data: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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

  // Compute probabilities for each station
  const stationProbs: Record<string, StationProbabilities> = {};
  const mtdValues: Record<string, number | null> = {};

  for (const station of STATIONS) {
    const rainData = rainfall?.stations[station.code];
    const mtd = rainData?.mtd ?? null;
    const ensemble = rainData?.ensemble ?? null;
    const qpfSum = rainData?.qpfSum ?? null;

    mtdValues[station.code] = mtd;

    if (historical) {
      stationProbs[station.code] = computeProbabilities(
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

  const hasLiveData = rainfall && Object.values(rainfall.stations).some((s) => s.mtd !== null);

  const lastUpdated = rainfall?.fetchedAt
    ? new Date(rainfall.fetchedAt).toLocaleString()
    : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            {MONTH_NAMES[month]} {year} Rainfall Tracker
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {daysRemaining} day{daysRemaining !== 1 ? "s" : ""} remaining
            {lastUpdated && <> &middot; Last updated: {lastUpdated}</>}
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

        {/* Station cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {STATIONS.map((station) => {
            const probs = stationProbs[station.code];
            const rainData = rainfall?.stations[station.code];

            return (
              <StationCard
                key={station.code}
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
                kalshi={kalshi?.stations[station.code] ?? null}
                lastDate={rainData?.lastUpdated ?? null}
                error={rainData?.error}
              />
            );
          })}
        </div>

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
