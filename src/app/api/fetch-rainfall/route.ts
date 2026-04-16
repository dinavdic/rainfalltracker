import { NextRequest, NextResponse } from "next/server";
import { STATIONS, NWS_USER_AGENT } from "@/lib/stations";
import {
  RainfallApiResponse,
  StationRainfallData,
  NWSGridInfo,
  EnsembleData,
  EnsembleStats,
  ModelBreakdown,
  SkillCurvesData,
  HistoricalData,
} from "@/lib/types";
import { saveRainfallData, loadRainfallData, isCacheFresh } from "@/lib/data-store";
import { fetchNWSCLI, formatShortDate } from "@/lib/nws-cli";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const IEM_JSON_BASE = "https://mesonet.agron.iastate.edu/json/cli.py";
const NWS_GRIDPOINTS_BASE = "https://api.weather.gov/gridpoints";
const NWS_POINTS_BASE = "https://api.weather.gov/points";
const OPEN_METEO_ENSEMBLE_BASE =
  "https://ensemble-api.open-meteo.com/v1/ensemble";

// In-memory cache of resolved grid coordinates
const resolvedGridCache: Record<string, NWSGridInfo> = {};

// --- Skill curves & climatological daily means (loaded once, cached) ---

let cachedSkillCurves: SkillCurvesData | null = null;
// climoDailyMean[stationCode]["MM-DD"] = mean daily precip in inches
let cachedClimoDailyMean: Record<string, Record<string, number>> | null = null;

async function loadSkillCurves(): Promise<SkillCurvesData | null> {
  if (cachedSkillCurves) return cachedSkillCurves;
  try {
    const filePath = path.join(process.cwd(), "public", "data", "skill-curves.json");
    const raw = await fs.readFile(filePath, "utf-8");
    cachedSkillCurves = JSON.parse(raw) as SkillCurvesData;
    return cachedSkillCurves;
  } catch {
    console.warn("[skill] Could not load skill-curves.json, skipping skill weighting");
    return null;
  }
}

async function loadClimoDailyMean(): Promise<Record<string, Record<string, number>> | null> {
  if (cachedClimoDailyMean) return cachedClimoDailyMean;
  try {
    const filePath = path.join(process.cwd(), "public", "data", "historical-distributions.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const hist = JSON.parse(raw) as HistoricalData;

    const result: Record<string, Record<string, number>> = {};
    for (const [code, sdata] of Object.entries(hist.stations)) {
      const daily: Record<string, number> = {};
      for (const [monthStr, mdata] of Object.entries(sdata.months)) {
        const month = parseInt(monthStr, 10);
        const dim = mdata.days_in_month;
        for (let d = 1; d <= dim; d++) {
          const prevMean = mdata.days[String(d - 1)]?.mean ?? 0;
          const currMean = mdata.days[String(d)]?.mean ?? 0;
          const singleDay = Math.max(0, prevMean - currMean);
          const mmdd = `${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          daily[mmdd] = Math.round(singleDay * 10000) / 10000;
        }
      }
      result[code] = daily;
    }
    cachedClimoDailyMean = result;
    return result;
  } catch {
    console.warn("[skill] Could not load historical-distributions.json for climo means");
    return null;
  }
}

/**
 * Get the skill weight for a given lead day (1-indexed, 1..16).
 * Uses the accumulated_skill fitted curve since we care about
 * cumulative precipitation accuracy.
 */
function getSkillWeight(
  skillCurves: SkillCurvesData | null,
  stationCode: string,
  leadDay: number
): number {
  if (!skillCurves) return 1; // no weighting if unavailable
  const station = skillCurves[stationCode];
  if (!station) return 1;
  const fitted = station.accumulated_skill.fitted;
  const idx = Math.min(Math.max(leadDay - 1, 0), fitted.length - 1);
  return fitted[idx];
}

/**
 * Estimate which standard run cycle the Open-Meteo data reflects.
 *
 * We can't reliably infer the run time from hourly.time[0] because the
 * ensemble API response starts at today 00:00 UTC regardless of when
 * the model actually initialized. Instead we use a simple rule based
 * on current UTC hour: before 18z, today's 00z run is the most recent
 * one that's been fully processed and published; at 18z or later,
 * today's 12z run has typically been published. This is approximate
 * but good enough for the staleness indicator in the dashboard header.
 */
function estimateModelRunLabel(): string {
  const nowHourUtc = new Date().getUTCHours();
  return nowHourUtc < 18 ? "00z" : "12z";
}

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
 * Reconcile IEM and NWS CLI MTD readings. If IEM data is more than 1
 * day behind "now" (or missing entirely), we try the NWS CLI text
 * report. Whichever source has the newer data date wins; logs the
 * comparison when NWS is used.
 */
async function fetchMTDWithFallback(
  stationCode: string,
  iemCode: string,
  cliParams: string,
): Promise<{ mtd: number | null; lastDate: string | null }> {
  let iem: { mtd: number | null; lastDate: string | null };
  try {
    iem = await fetchIEMMTD(iemCode);
  } catch (e) {
    console.warn(
      `[mtd] ${stationCode}: IEM fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    iem = { mtd: null, lastDate: null };
  }

  const iemAgeDays = iem.lastDate
    ? (Date.now() - new Date(iem.lastDate + "T00:00:00Z").getTime()) /
      (24 * 60 * 60 * 1000)
    : Infinity;

  // Fast path: IEM is fresh enough
  if (iem.mtd !== null && iemAgeDays <= 1) {
    return iem;
  }

  // Fallback to NWS CLI
  try {
    const nws = await fetchNWSCLI(cliParams);
    const nwsNewer =
      nws.dataDate !== null &&
      (iem.lastDate === null || nws.dataDate > iem.lastDate);

    if (nws.mtd !== null && nwsNewer) {
      const iemLabel =
        iem.lastDate !== null
          ? `IEM=${iem.mtd} (${formatShortDate(iem.lastDate)})`
          : `IEM=null`;
      const nwsLabel = `NWS=${nws.mtd} (${formatShortDate(nws.dataDate!)})`;
      console.log(`[mtd] ${stationCode}: ${iemLabel}, ${nwsLabel}, using NWS`);
      return { mtd: nws.mtd, lastDate: nws.dataDate };
    }
  } catch (e) {
    console.warn(
      `[mtd] ${stationCode}: NWS CLI fallback failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return iem;
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
  model: string,
  skillCurves: SkillCurvesData | null,
  climoDaily: Record<string, Record<string, number>> | null
): Promise<{ memberSums: number[]; forecastDays: number; modelRunLabel: string | null; skillWeight: number }> {
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

  // Approximate the initialization time of the run we're consuming.
  // See estimateModelRunLabel() for why we don't use hourly.time[0].
  const modelRunLabel: string = estimateModelRunLabel();

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
  const monthEnd = new Date(currentYear, currentMonth + 1, 1);

  // Group valid hour indices by calendar date (YYYY-MM-DD) for per-day aggregation
  // Track lead day (1-indexed from today) for each calendar date
  const dayBuckets: { dateStr: string; mmdd: string; leadDay: number; indices: number[] }[] = [];
  const seenDates = new Map<string, number>(); // dateStr -> index into dayBuckets
  let lastValidDate: Date | null = null;

  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]);
    if (t >= now && t < monthEnd) {
      const dateStr = times[i].substring(0, 10);
      if (!lastValidDate || t > lastValidDate) {
        lastValidDate = t;
      }
      if (!seenDates.has(dateStr)) {
        // Lead day: how many days ahead of today (1 = today/tomorrow)
        const dayDiff = Math.floor((t.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) + 1;
        const mmdd = `${dateStr.substring(5, 7)}-${dateStr.substring(8, 10)}`;
        seenDates.set(dateStr, dayBuckets.length);
        dayBuckets.push({ dateStr, mmdd, leadDay: Math.max(1, dayDiff), indices: [] });
      }
      dayBuckets[seenDates.get(dateStr)!].indices.push(i);
    }
  }

  const forecastDays = lastValidDate
    ? Math.ceil(
        (lastValidDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
      )
    : 0;

  const stationClimo = climoDaily?.[stationCode] ?? null;
  const hasSkill = skillCurves !== null && stationClimo !== null;

  // --- Step 1: Compute raw daily totals (inches) for every member × day ---
  // rawDaily[memberIdx][bucketIdx] = daily precip in inches (unweighted)
  const rawDaily: number[][] = [];

  for (const key of memberKeys) {
    const memberData: (number | null)[] | undefined = hourly[key];
    const dailyValues: number[] = [];

    for (const bucket of dayBuckets) {
      if (!memberData) {
        dailyValues.push(0);
        continue;
      }
      let dayMm = 0;
      for (const idx of bucket.indices) {
        const val = memberData[idx];
        if (val !== null && val !== undefined && val > 0) {
          dayMm += val;
        }
      }
      dailyValues.push(dayMm / 25.4);
    }
    rawDaily.push(dailyValues);
  }

  // --- Step 2: Compute raw (unblended) member sums ---
  // BMA mixture sampling in probability.ts handles skill weighting;
  // member sums here are pure model output.
  const memberSums: number[] = [];
  const numMembers = memberKeys.length;
  for (let mi = 0; mi < numMembers; mi++) {
    const total = rawDaily[mi].reduce((a, b) => a + b, 0);
    memberSums.push(Math.round(total * 100) / 100);
  }

  // --- Compute effective skill weight (average across forecast days) ---
  let skillWeight = 1;
  if (hasSkill && dayBuckets.length > 0) {
    let wSum = 0;
    for (const bucket of dayBuckets) {
      wSum += getSkillWeight(skillCurves, stationCode, bucket.leadDay);
    }
    skillWeight = wSum / dayBuckets.length;
  }

  return { memberSums, forecastDays, modelRunLabel, skillWeight };
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
  // Load skill curves and climo daily means (cached after first call)
  const [skillCurves, climoDaily] = await Promise.all([
    loadSkillCurves(),
    loadClimoDailyMean(),
  ]);

  // Fetch GEFS first (rate-limited — caller handles the first delay)
  const gefsResult = await fetchSingleModelEnsemble(
    lat, lon, stationCode, "gfs_seamless", skillCurves, climoDaily
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
  let ecmwfResult: { memberSums: number[]; forecastDays: number; modelRunLabel: string | null; skillWeight: number } | null = null;
  try {
    ecmwfResult = await fetchSingleModelEnsemble(
      lat, lon, stationCode, "ecmwf_ifs025", skillCurves, climoDaily
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
    modelRuns: {
      gefs: gefsResult.modelRunLabel,
      ecmwf: ecmwfResult?.modelRunLabel ?? null,
    },
    skillWeight: gefsResult.skillWeight,
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
  // but MTD (IEM + NWS CLI fallback) and ensemble run in parallel per station
  for (const station of STATIONS) {
    const [iemResult, ensembleResult] = await Promise.allSettled([
      fetchMTDWithFallback(station.code, station.iemCode, station.cliParams),
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
