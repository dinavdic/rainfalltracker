import { NextRequest, NextResponse } from "next/server";
import { STATIONS } from "@/lib/stations";
import { RainfallApiResponse, StationRainfallData } from "@/lib/types";
import { saveRainfallData, loadRainfallData, isCacheFresh } from "@/lib/data-store";

export const dynamic = "force-dynamic";

const IEM_JSON_BASE = "https://mesonet.agron.iastate.edu/json/cli.py";

interface IEMResult {
  valid: string;
  precip: number | string | null;
  precip_month: number | string | null;
}

interface IEMResponse {
  results: IEMResult[];
}

/**
 * Fetch current-year CLI data from IEM JSON API for a station.
 * Returns the most recent precip_month value for the current month as MTD.
 */
async function fetchIEMMTD(
  iemCode: string
): Promise<{ mtd: number | null; lastDate: string | null }> {
  const now = new Date();
  const year = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const icao = `K${iemCode}`;
  const url = `${IEM_JSON_BASE}?station=${icao}&year=${year}`;

  const resp = await fetch(url, {
    headers: { "User-Agent": "RainfallTracker/1.0 (contact@example.com)" },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`IEM fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const data: IEMResponse = await resp.json();
  const results = data.results || [];

  // Filter to current month and find the most recent entry with a valid precip_month
  let latestMtd: number | null = null;
  let latestDate: string | null = null;

  for (const entry of results) {
    const dateStr = entry.valid;
    if (!dateStr) continue;

    const entryMonth = parseInt(dateStr.substring(5, 7), 10);
    if (entryMonth !== currentMonth) continue;

    const precipMonth = entry.precip_month;
    if (precipMonth === null || precipMonth === "M" || precipMonth === undefined) {
      continue;
    }

    const val = typeof precipMonth === "string" ? parseFloat(precipMonth) : precipMonth;
    if (isNaN(val)) continue;

    // Keep the latest (results are generally in order, but be safe)
    if (latestDate === null || dateStr > latestDate) {
      latestMtd = val;
      latestDate = dateStr;
    }
  }

  return { mtd: latestMtd, lastDate: latestDate };
}

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("force") === "1";

  // Check cache first (skip if force refresh)
  if (!forceRefresh) {
    const cached = await loadRainfallData();
    if (cached && isCacheFresh(cached)) {
      return NextResponse.json(cached);
    }
  }

  const stations: Record<string, StationRainfallData> = {};

  // Fetch MTD data for all stations in parallel from IEM
  const results = await Promise.allSettled(
    STATIONS.map(async (station) => {
      try {
        const { mtd, lastDate } = await fetchIEMMTD(station.iemCode);
        const data: StationRainfallData = {
          mtd,
          qpf7day: [0, 0, 0, 0, 0, 0, 0],
          lastUpdated: lastDate,
        };
        return { code: station.code, data };
      } catch (e) {
        return {
          code: station.code,
          data: {
            mtd: null,
            qpf7day: [0, 0, 0, 0, 0, 0, 0],
            lastUpdated: null,
            error: `IEM fetch error: ${e instanceof Error ? e.message : String(e)}`,
          } as StationRainfallData,
        };
      }
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      stations[result.value.code] = result.value.data;
    }
  }

  const response: RainfallApiResponse = {
    stations,
    fetchedAt: new Date().toISOString(),
  };

  // Persist to disk for caching
  try {
    await saveRainfallData(response);
  } catch {
    // Non-fatal
  }

  return NextResponse.json(response);
}
