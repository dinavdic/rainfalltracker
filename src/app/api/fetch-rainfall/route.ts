import { NextRequest, NextResponse } from "next/server";
import { STATIONS, NWS_USER_AGENT } from "@/lib/stations";
import {
  RainfallApiResponse,
  StationRainfallData,
  NWSGridInfo,
  EnsembleData,
  EnsembleStats,
  ModelBreakdown,
} from "@/lib/types";
import { saveRainfallData, loadRainfallData, isCacheFresh } from "@/lib/data-store";

export const dynamic = "force-dynamic";

const IEM_JSON_BASE = "https://mesonet.agron.iastate.edu/json/cli.py";
const NWS_GRIDPOINTS_BASE = "https://api.weather.gov/gridpoints";
const NWS_POINTS_BASE = "https://api.weather.gov/points";
const OPEN_METEO_ENSEMBLE_BASE =
  "https://ensemble-api.open-meteo.com/v1/ensemble";

// In-memory cache of resolved grid coordinates
const resolvedGridCache: Record<string, NWSGridInfo> = {};

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
    if (
      precipMonth === null ||
      precipMonth === "M" ||
      precipMonth === undefined
    ) {
      continue;
    }

    const val =
      typeof precipMonth === "string" ? parseFloat(precipMonth) : precipMonth;
    if (isNaN(val)) continue;

    if (latestDate === null || dateStr > latestDate) {
      latestMtd = val;
      latestDate = dateStr;
    }
  }

  return { mtd: latestMtd, lastDate: latestDate };
}

/**
 * Compute summary statistics for an array of numbers.
 */
function computeEnsembleStats(values: number[]): EnsembleStats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);

  const percentile = (p: number): number => {
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  return {
    mean: Math.round((sum / n) * 100) / 100,
    median: Math.round(percentile(50) * 100) / 100,
    p10: Math.round(percentile(10) * 100) / 100,
    p25: Math.round(percentile(25) * 100) / 100,
    p75: Math.round(percentile(75) * 100) / 100,
    p90: Math.round(percentile(90) * 100) / 100,
  };
}

/**
 * Fetch ensemble precipitation from Open-Meteo for a single model.
 *
 * Sums hourly precipitation for each ensemble member, only counting
 * hours that fall within the remainder of the current month.
 *
 * Returns the per-member sums (in inches) and how many forecast days are covered.
 */
async function fetchSingleModelEnsemble(
  lat: number,
  lon: number,
  stationCode: string,
  model: string
): Promise<{ memberSums: number[]; forecastDays: number }> {
  const url =
    `${OPEN_METEO_ENSEMBLE_BASE}?latitude=${lat}&longitude=${lon}` +
    `&models=${model}&hourly=precipitation&forecast_days=16`;

  const resp = await fetch(url, {
    signal: AbortSignal.timeout(20000),
  });

  if (!resp.ok) {
    throw new Error(
      `Open-Meteo ${model} fetch failed for ${stationCode}: ${resp.status} ${resp.statusText}`
    );
  }

  const data = await resp.json();
  const hourly = data.hourly;

  if (!hourly || !hourly.time) {
    throw new Error(
      `Open-Meteo ${model} response missing hourly data for ${stationCode}`
    );
  }

  // Auto-detect ensemble member keys from the response
  const allKeys = Object.keys(hourly);
  const memberKeys = allKeys
    .filter((k) => k.startsWith("precipitation_member"))
    .sort((a, b) => {
      const numA = parseInt(a.replace("precipitation_member", ""), 10);
      const numB = parseInt(b.replace("precipitation_member", ""), 10);
      return numA - numB;
    });

  if (memberKeys.length === 0) {
    // Log all hourly keys for debugging
    const sampleKeys = allKeys.slice(0, 20).join(", ");
    throw new Error(
      `Open-Meteo ${model} for ${stationCode}: no precipitation_member* keys found. ` +
      `Hourly keys (${allKeys.length}): [${sampleKeys}]`
    );
  }

  console.log(
    `[ensemble] ${stationCode} ${model}: found ${memberKeys.length} member keys ` +
    `(${memberKeys[0]}..${memberKeys[memberKeys.length - 1]})`
  );

  const times: string[] = hourly.time;
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-indexed
  // End of current month (start of next month)
  const monthEnd = new Date(currentYear, currentMonth + 1, 1);

  // Find which time indices fall within the remainder of the current month
  const validIndices: number[] = [];
  let lastValidDate: Date | null = null;

  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]);
    if (t >= now && t < monthEnd) {
      validIndices.push(i);
      if (!lastValidDate || t > lastValidDate) {
        lastValidDate = t;
      }
    }
  }

  // Compute how many forecast days are covered within the month
  const forecastDays = lastValidDate
    ? Math.ceil(
        (lastValidDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
      )
    : 0;

  // Sum precipitation for each detected ensemble member across valid hours
  const memberSums: number[] = [];

  for (const key of memberKeys) {
    const memberData: (number | null)[] | undefined = hourly[key];

    if (!memberData) {
      memberSums.push(0);
      continue;
    }

    let sumMm = 0;
    for (const idx of validIndices) {
      const val = memberData[idx];
      if (val !== null && val !== undefined && val > 0) {
        sumMm += val;
      }
    }

    // Convert mm to inches
    memberSums.push(Math.round((sumMm / 25.4) * 100) / 100);
  }

  return { memberSums, forecastDays };
}

/**
 * Fetch both GEFS and ECMWF ensembles, combine into a multi-model ensemble.
 * Falls back to GEFS-only if ECMWF fails.
 */
async function fetchCombinedEnsemble(
  lat: number,
  lon: number,
  stationCode: string
): Promise<EnsembleData> {
  // Fetch GEFS first (rate-limited — caller handles the first delay)
  const gefsResult = await fetchSingleModelEnsemble(
    lat, lon, stationCode, "gfs_seamless"
  );

  // Rate limit before ECMWF request
  const now = Date.now();
  const elapsed = now - lastOpenMeteoRequest;
  if (elapsed < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
  }
  lastOpenMeteoRequest = Date.now();

  // Fetch ECMWF (non-fatal if it fails)
  // Model name is ecmwf_ifs025 — the 0.25° ensemble model.
  // "ecmwf_ifs" is the deterministic/HRES model with no per-member fields.
  let ecmwfResult: { memberSums: number[]; forecastDays: number } | null = null;
  try {
    ecmwfResult = await fetchSingleModelEnsemble(
      lat, lon, stationCode, "ecmwf_ifs025"
    );
    console.log(`[ensemble] ${stationCode}: ECMWF OK (${ecmwfResult.memberSums.length} members)`);
  } catch (e) {
    console.warn(
      `[ensemble] ${stationCode}: ECMWF failed (${e instanceof Error ? e.message : String(e)}), using GEFS-only`
    );
  }

  const gefsSums = gefsResult.memberSums;
  const ecmwfSums = ecmwfResult?.memberSums ?? [];
  const combinedSums = [...gefsSums, ...ecmwfSums];
  const forecastDays = Math.max(
    gefsResult.forecastDays,
    ecmwfResult?.forecastDays ?? 0
  );

  const gefsStats = computeEnsembleStats(gefsSums);
  const combinedStats = computeEnsembleStats(combinedSums);

  let modelBreakdown: ModelBreakdown | null = null;
  if (ecmwfSums.length > 0) {
    const ecmwfStats = computeEnsembleStats(ecmwfSums);
    modelBreakdown = {
      gefs: gefsStats,
      ecmwf: ecmwfStats,
      combined: combinedStats,
    };
    console.log(
      `[ensemble] ${stationCode}: Combined ${gefsSums.length}+${ecmwfSums.length}=${combinedSums.length} members, ` +
      `median GEFS=${gefsStats.median}" ECMWF=${ecmwfStats.median}" combined=${combinedStats.median}"`
    );
  } else {
    console.log(
      `[ensemble] ${stationCode}: GEFS-only ${gefsSums.length} members, median=${gefsStats.median}"`
    );
  }

  return {
    memberSums: combinedSums,
    gefsMemberSums: gefsSums,
    ecmwfMemberSums: ecmwfSums,
    modelBreakdown,
    forecastDays,
    stats: combinedStats,
  };
}

// --- NWS deterministic QPF (fallback) ---

async function resolveGridFromPoints(
  lat: number,
  lon: number
): Promise<NWSGridInfo> {
  const url = `${NWS_POINTS_BASE}/${lat},${lon}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      Accept: "application/geo+json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(`NWS /points failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  const props = data.properties;

  if (
    !props?.gridId ||
    props?.gridX === undefined ||
    props?.gridY === undefined
  ) {
    throw new Error("NWS /points response missing grid properties");
  }

  return { office: props.gridId, gridX: props.gridX, gridY: props.gridY };
}

async function fetchQPF(
  grid: NWSGridInfo,
  lat: number,
  lon: number,
  stationCode: string
): Promise<number> {
  const effectiveGrid = resolvedGridCache[stationCode] || grid;

  let resp = await fetch(
    `${NWS_GRIDPOINTS_BASE}/${effectiveGrid.office}/${effectiveGrid.gridX},${effectiveGrid.gridY}`,
    {
      headers: {
        "User-Agent": NWS_USER_AGENT,
        Accept: "application/geo+json",
      },
      signal: AbortSignal.timeout(15000),
    }
  );

  if (!resp.ok) {
    console.warn(
      `[QPF] ${stationCode}: gridpoints failed (${resp.status}) for ` +
        `${effectiveGrid.office}/${effectiveGrid.gridX},${effectiveGrid.gridY}. ` +
        `Falling back to /points/${lat},${lon}`
    );

    const resolved = await resolveGridFromPoints(lat, lon);
    resolvedGridCache[stationCode] = resolved;

    resp = await fetch(
      `${NWS_GRIDPOINTS_BASE}/${resolved.office}/${resolved.gridX},${resolved.gridY}`,
      {
        headers: {
          "User-Agent": NWS_USER_AGENT,
          Accept: "application/geo+json",
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!resp.ok) {
      throw new Error(
        `NWS gridpoints failed after /points resolve: ${resp.status} ${resp.statusText}`
      );
    }
  }

  const data = await resp.json();
  const qpfProp = data.properties?.quantitativePrecipitation;
  if (!qpfProp || !qpfProp.values) {
    throw new Error("No quantitativePrecipitation in gridpoints response");
  }

  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const uom: string = qpfProp.uom || "";
  const isMm = uom.includes("mm");

  let totalMm = 0;
  for (const entry of qpfProp.values) {
    const validTime: string = entry.validTime || "";
    const value: number | null = entry.value;
    if (value === null || value === undefined || value <= 0) continue;

    const slashIdx = validTime.indexOf("/");
    const startStr =
      slashIdx > 0 ? validTime.substring(0, slashIdx) : validTime;

    let startDate: Date;
    try {
      startDate = new Date(startStr);
    } catch {
      continue;
    }
    if (isNaN(startDate.getTime())) continue;

    if (startDate >= now && startDate < sevenDaysOut) {
      totalMm += value;
    }
  }

  const totalInches = isMm ? totalMm / 25.4 : totalMm;
  return Math.round(totalInches * 100) / 100;
}

// --- Rate limiter for Open-Meteo (1 req/sec) ---

let lastOpenMeteoRequest = 0;

async function rateLimitedEnsembleFetch(
  lat: number,
  lon: number,
  stationCode: string
): Promise<EnsembleData> {
  const now = Date.now();
  const elapsed = now - lastOpenMeteoRequest;
  if (elapsed < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
  }
  lastOpenMeteoRequest = Date.now();
  return fetchCombinedEnsemble(lat, lon, stationCode);
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

  // Fetch all stations — ensemble requests are sequential (rate limited),
  // but IEM and NWS QPF fallback run in parallel per station
  for (const station of STATIONS) {
    // Fetch IEM MTD and ensemble concurrently for this station
    // (ensemble is rate-limited so we process stations sequentially)
    const [iemResult, ensembleResult] = await Promise.allSettled([
      fetchIEMMTD(station.iemCode),
      rateLimitedEnsembleFetch(station.lat, station.lon, station.code),
    ]);

    const iem =
      iemResult.status === "fulfilled"
        ? iemResult.value
        : { mtd: null, lastDate: null };

    let ensemble: EnsembleData | null = null;
    let qpfSum: number | null = null;

    if (ensembleResult.status === "fulfilled") {
      ensemble = ensembleResult.value;
    } else {
      // Ensemble failed — fall back to NWS deterministic QPF
      console.warn(
        `[ensemble] ${station.code}: Open-Meteo failed (${ensembleResult.reason}), falling back to NWS QPF`
      );

      try {
        qpfSum = await fetchQPF(
          station.nwsGrid,
          station.lat,
          station.lon,
          station.code
        );
      } catch (e) {
        console.error(
          `[QPF fallback] ${station.code}: NWS QPF also failed: ${e}`
        );
      }
    }

    const data: StationRainfallData = {
      mtd: iem.mtd,
      qpf7day: [],
      qpfSum,
      ensemble,
      lastUpdated: iem.lastDate,
    };

    if (iemResult.status === "rejected") {
      data.error = `IEM fetch error: ${iemResult.reason}`;
    }
    if (ensembleResult.status === "rejected" && qpfSum === null) {
      data.qpfError = `Ensemble + QPF fetch error: ${ensembleResult.reason}`;
    }

    stations[station.code] = data;
  }

  // Log errors for debugging
  for (const [code, stationData] of Object.entries(stations)) {
    if (stationData.qpfError) {
      console.error(`[fetch-rainfall] ${code}: ${stationData.qpfError}`);
    }
    if (stationData.error) {
      console.error(`[fetch-rainfall] ${code}: ${stationData.error}`);
    }
  }

  const response: RainfallApiResponse = {
    stations,
    fetchedAt: new Date().toISOString(),
  };

  try {
    await saveRainfallData(response);
  } catch {
    // Non-fatal
  }

  return NextResponse.json(response);
}
