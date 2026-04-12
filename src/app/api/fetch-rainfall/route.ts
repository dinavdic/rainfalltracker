import { NextRequest, NextResponse } from "next/server";
import { STATIONS, NWS_USER_AGENT } from "@/lib/stations";
import { RainfallApiResponse, StationRainfallData, NWSGridInfo } from "@/lib/types";
import { saveRainfallData, loadRainfallData, isCacheFresh } from "@/lib/data-store";

export const dynamic = "force-dynamic";

const IEM_JSON_BASE = "https://mesonet.agron.iastate.edu/json/cli.py";
const NWS_GRIDPOINTS_BASE = "https://api.weather.gov/gridpoints";

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
    headers: { "User-Agent": NWS_USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`IEM fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const data: IEMResponse = await resp.json();
  const results = data.results || [];

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

    if (latestDate === null || dateStr > latestDate) {
      latestMtd = val;
      latestDate = dateStr;
    }
  }

  return { mtd: latestMtd, lastDate: latestDate };
}

/**
 * Fetch 7-day QPF from NWS gridpoints raw data endpoint.
 *
 * Uses https://api.weather.gov/gridpoints/{office}/{gridX},{gridY}
 * which returns quantitativePrecipitation as a time series of expected
 * precipitation in 6-hour windows. Sums values for the next 7 days.
 *
 * Returns the total QPF in inches for the next 7 days.
 */
async function fetchQPF(grid: NWSGridInfo): Promise<number> {
  const url = `${NWS_GRIDPOINTS_BASE}/${grid.office}/${grid.gridX},${grid.gridY}`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      Accept: "application/geo+json",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`NWS gridpoints failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();

  // quantitativePrecipitation is in properties.quantitativePrecipitation
  // It has a "values" array with { validTime, value } entries
  // validTime is an ISO 8601 interval like "2026-04-12T06:00:00+00:00/PT6H"
  // value is in mm (NWS default unit for QPF)
  const qpfProp = data.properties?.quantitativePrecipitation;
  if (!qpfProp || !qpfProp.values) {
    throw new Error("No quantitativePrecipitation in gridpoints response");
  }

  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Determine the unit — NWS returns "wmoUnit:mm" or "unit:mm" etc.
  const uom: string = qpfProp.uom || "";
  const isMm = uom.includes("mm");

  let totalMm = 0;

  for (const entry of qpfProp.values) {
    const validTime: string = entry.validTime || "";
    const value: number | null = entry.value;

    if (value === null || value === undefined || value <= 0) continue;

    // Parse the start time from the ISO interval
    const slashIdx = validTime.indexOf("/");
    const startStr = slashIdx > 0 ? validTime.substring(0, slashIdx) : validTime;

    let startDate: Date;
    try {
      startDate = new Date(startStr);
    } catch {
      continue;
    }

    if (isNaN(startDate.getTime())) continue;

    // Only include periods within the next 7 days
    if (startDate >= now && startDate < sevenDaysOut) {
      totalMm += value;
    }
  }

  // Convert mm to inches if needed
  const totalInches = isMm ? totalMm / 25.4 : totalMm;
  return Math.round(totalInches * 100) / 100;
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

  // Fetch MTD and QPF data for all stations in parallel
  const results = await Promise.allSettled(
    STATIONS.map(async (station) => {
      // Fetch IEM MTD and NWS QPF in parallel
      const [iemResult, qpfResult] = await Promise.allSettled([
        fetchIEMMTD(station.iemCode),
        fetchQPF(station.nwsGrid),
      ]);

      const iem =
        iemResult.status === "fulfilled"
          ? iemResult.value
          : { mtd: null, lastDate: null };
      const qpfSum =
        qpfResult.status === "fulfilled" ? qpfResult.value : 0;

      const data: StationRainfallData = {
        mtd: iem.mtd,
        qpf7day: [], // We store the aggregate sum, not daily breakdown
        qpfSum,
        lastUpdated: iem.lastDate,
      };

      if (iemResult.status === "rejected") {
        data.error = `IEM fetch error: ${iemResult.reason}`;
      }
      if (qpfResult.status === "rejected") {
        data.qpfError = `QPF fetch error: ${qpfResult.reason}`;
      }

      return { code: station.code, data };
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
