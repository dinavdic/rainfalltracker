import { NextRequest, NextResponse } from "next/server";
import { STATIONS, NWS_USER_AGENT } from "@/lib/stations";
import { RainfallApiResponse, StationRainfallData } from "@/lib/types";
import { saveRainfallData, loadRainfallData, isCacheFresh } from "@/lib/data-store";

export const dynamic = "force-dynamic";

const CLI_BASE_URL = "https://forecast.weather.gov/product.php";
const NWS_POINTS_BASE = "https://api.weather.gov/points";

/**
 * Parse the NWS CLI report to extract MTD precipitation.
 */
function parseCLIReport(text: string): { today: number | null; mtd: number | null } {
  let today: number | null = null;
  let mtd: number | null = null;

  const lines = text.split("\n");
  let inPrecipSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("PRECIPITATION (IN)") || trimmed === "PRECIPITATION") {
      inPrecipSection = true;
      continue;
    }

    if (inPrecipSection) {
      // Look for TODAY and MONTH TO DATE lines
      const todayMatch = trimmed.match(/^TODAY\s+([\d.]+|T|M)/i);
      if (todayMatch) {
        const val = todayMatch[1];
        today = val === "T" ? 0.001 : val === "M" ? null : parseFloat(val);
        continue;
      }

      const mtdMatch = trimmed.match(/^MONTH\s+TO\s+DATE\s+([\d.]+|T|M)/i);
      if (mtdMatch) {
        const val = mtdMatch[1];
        mtd = val === "T" ? 0.001 : val === "M" ? null : parseFloat(val);
        continue;
      }

      // Exit section when we hit a blank line or next section header
      if (trimmed === "" || (trimmed.match(/^[A-Z]/) && !trimmed.startsWith("TODAY") && !trimmed.startsWith("MONTH"))) {
        if (mtd !== null) break;
      }
    }
  }

  return { today, mtd };
}

/**
 * Fetch the NWS CLI report for a station and extract precipitation data.
 */
async function fetchCLIData(
  cliParams: string
): Promise<{ today: number | null; mtd: number | null }> {
  const url = `${CLI_BASE_URL}?${cliParams}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": NWS_USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`CLI fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const html = await resp.text();

  // The CLI report is embedded in the HTML page inside a <pre> tag
  const preMatch = html.match(/<pre[^>]*class="glossaryProduct"[^>]*>([\s\S]*?)<\/pre>/i);
  const reportText = preMatch ? preMatch[1] : html;

  return parseCLIReport(reportText);
}

/**
 * Fetch 7-day QPF from NWS API for a station's coordinates.
 */
async function fetchQPF(lat: number, lon: number): Promise<number[]> {
  // First get the grid point info
  const pointsUrl = `${NWS_POINTS_BASE}/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const pointsResp = await fetch(pointsUrl, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      Accept: "application/geo+json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!pointsResp.ok) {
    throw new Error(`Points API failed: ${pointsResp.status}`);
  }

  const pointsData = await pointsResp.json();
  const forecastUrl = pointsData.properties?.forecast;

  if (!forecastUrl) {
    throw new Error("No forecast URL in points response");
  }

  // Fetch the forecast
  const forecastResp = await fetch(forecastUrl, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      Accept: "application/geo+json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!forecastResp.ok) {
    throw new Error(`Forecast API failed: ${forecastResp.status}`);
  }

  const forecastData = await forecastResp.json();
  const periods = forecastData.properties?.periods || [];

  // Extract precipitation amounts for next 7 days
  // NWS forecast periods alternate between day and night
  // We need to extract any mentioned precipitation amounts
  const dailyPrecip: number[] = [];
  let currentDay = -1;

  for (const period of periods) {
    if (dailyPrecip.length >= 7) break;

    const isDaytime = period.isDaytime;
    if (isDaytime) {
      currentDay++;
      if (currentDay >= 7) break;
      dailyPrecip.push(0);
    }

    // Parse the detailed forecast text for precipitation amounts
    const detailedForecast: string = period.detailedForecast || "";
    const shortForecast: string = period.shortForecast || "";

    // Look for patterns like "0.5 inches", "1 to 2 inches", "less than a quarter inch"
    let precipAmount = 0;

    // Match patterns like "New rainfall amounts between X and Y inches"
    const rangeMatch = detailedForecast.match(
      /(?:rainfall|precipitation|snow).*?(?:between|of)\s+([\d.]+)\s+(?:and|to)\s+([\d.]+)\s+inch/i
    );
    if (rangeMatch) {
      precipAmount = (parseFloat(rangeMatch[1]) + parseFloat(rangeMatch[2])) / 2;
    }

    // Match "around X inches"
    const aroundMatch = detailedForecast.match(
      /(?:rainfall|precipitation).*?(?:around|near)\s+([\d.]+)\s+inch/i
    );
    if (!rangeMatch && aroundMatch) {
      precipAmount = parseFloat(aroundMatch[1]);
    }

    // "less than a quarter inch" or "less than half an inch"
    if (detailedForecast.match(/less than a quarter/i)) {
      precipAmount = 0.1;
    } else if (detailedForecast.match(/less than half/i)) {
      precipAmount = 0.25;
    }

    // Check for rain keywords with no amount specified - assign a small amount
    if (
      precipAmount === 0 &&
      (shortForecast.match(/rain|shower|storm|drizzle/i) ||
        detailedForecast.match(/chance of rain|chance of showers/i))
    ) {
      // Extract probability if available
      const probMatch = detailedForecast.match(/(\d+)\s*percent/i);
      const prob = probMatch ? parseInt(probMatch[1]) / 100 : 0.3;
      precipAmount = prob * 0.15; // rough expected value
    }

    if (currentDay >= 0 && currentDay < dailyPrecip.length) {
      dailyPrecip[currentDay] = Math.max(
        dailyPrecip[currentDay],
        precipAmount
      );
    }
  }

  // Pad to 7 days with zeros
  while (dailyPrecip.length < 7) {
    dailyPrecip.push(0);
  }

  return dailyPrecip.slice(0, 7);
}

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("force") === "1";

  // Check cache first (skip if force refresh from cron)
  if (!forceRefresh) {
    const cached = await loadRainfallData();
    if (cached && isCacheFresh(cached)) {
      return NextResponse.json(cached);
    }
  }

  const stations: Record<string, StationRainfallData> = {};

  // Fetch data for all stations in parallel
  const results = await Promise.allSettled(
    STATIONS.map(async (station) => {
      try {
        const [cliData, qpf] = await Promise.allSettled([
          fetchCLIData(station.cliParams),
          fetchQPF(station.lat, station.lon),
        ]);

        const cli =
          cliData.status === "fulfilled"
            ? cliData.value
            : { today: null, mtd: null };
        const qpf7day =
          qpf.status === "fulfilled"
            ? qpf.value
            : [0, 0, 0, 0, 0, 0, 0];

        const data: StationRainfallData = {
          mtd: cli.mtd,
          qpf7day,
          lastUpdated: new Date().toISOString(),
        };

        if (cliData.status === "rejected") {
          data.error = `CLI fetch error: ${cliData.reason}`;
        }

        return { code: station.code, data };
      } catch (e) {
        return {
          code: station.code,
          data: {
            mtd: null,
            qpf7day: [0, 0, 0, 0, 0, 0, 0],
            lastUpdated: null,
            error: `Error: ${e instanceof Error ? e.message : String(e)}`,
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
    // Non-fatal: continue even if we can't persist
  }

  return NextResponse.json(response);
}
