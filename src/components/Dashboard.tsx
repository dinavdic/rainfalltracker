"use client";

import { useState, useEffect, useCallback } from "react";
import {
  HistoricalData,
  RainfallApiResponse,
  StationProbabilities,
} from "@/lib/types";
import { computeProbabilities } from "@/lib/probability";
import { STATIONS } from "@/lib/stations";
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

export default function Dashboard() {
  const [historical, setHistorical] = useState<HistoricalData | null>(null);
  const [rainfall, setRainfall] = useState<RainfallApiResponse | null>(null);
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

      // Then try the live IEM data via our API route
      try {
        const rainResp = await fetch("/api/fetch-rainfall");
        if (rainResp.ok) {
          setRainfall(await rainResp.json());
        } else {
          setLiveDataFailed(true);
        }
      } catch {
        setLiveDataFailed(true);
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
    const qpf7day = rainData?.qpf7day ?? [0, 0, 0, 0, 0, 0, 0];

    mtdValues[station.code] = mtd;

    if (historical) {
      stationProbs[station.code] = computeProbabilities(
        station.code,
        month,
        dayOfMonth,
        mtd ?? 0,
        qpf7day,
        historical
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
                thresholds={
                  probs?.thresholds ?? [
                    {
                      threshold: 1.0,
                      remainingNeeded: 1.0,
                      baseRate: 0,
                      blendedProbability: 0,
                      climatologyProbability: 0,
                    },
                    {
                      threshold: 2.0,
                      remainingNeeded: 2.0,
                      baseRate: 0,
                      blendedProbability: 0,
                      climatologyProbability: 0,
                    },
                    {
                      threshold: 3.0,
                      remainingNeeded: 3.0,
                      baseRate: 0,
                      blendedProbability: 0,
                      climatologyProbability: 0,
                    },
                  ]
                }
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
            Data sources: IEM CLI Archive (mesonet.agron.iastate.edu) for live
            MTD and 1991–2024 historical distributions.
          </p>
          <p className="mt-1">
            Conditional probabilities: given current MTD and days remaining,
            P(month total &gt; threshold) is computed using gamma distribution
            fits to historical remaining-period rainfall.
          </p>
        </footer>
      </div>
    </div>
  );
}
