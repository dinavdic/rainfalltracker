import { NWS_USER_AGENT } from "./stations";

/**
 * Minimal scraper for the NWS CLI (Climatological Report) text product.
 *
 * The product.php page wraps a plaintext CLI inside a <pre> block. We
 * extract that block and pull two signals:
 *   - CLIMATE SUMMARY FOR <MDY>          → dataDate (YYYY-MM-DD)
 *   - MONTH TO DATE <value> (PRECIPITATION section) → mtd (inches)
 *
 * The MTD regex is anchored to the PRECIPITATION section because the
 * same "MONTH TO DATE" phrase appears in the TEMPERATURE section first,
 * and a greedy match there would return the monthly mean temperature
 * instead of total precip.
 *
 * Used both by the rainfall fetch route (to pick the freshest MTD value
 * when IEM lags) and by the every-20-min probe (to detect when a new
 * CLI was just published and trigger a full update).
 */

export interface NWSCLIResult {
  mtd: number | null;
  dataDate: string | null; // YYYY-MM-DD
}

const MONTHS: Record<string, number> = {
  JANUARY: 1,
  FEBRUARY: 2,
  MARCH: 3,
  APRIL: 4,
  MAY: 5,
  JUNE: 6,
  JULY: 7,
  AUGUST: 8,
  SEPTEMBER: 9,
  OCTOBER: 10,
  NOVEMBER: 11,
  DECEMBER: 12,
};

function extractStationCode(cliParams: string): string {
  const m = cliParams.match(/issuedby=([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : "?";
}

function utcDateString(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

export async function fetchNWSCLI(cliParams: string): Promise<NWSCLIResult> {
  // Append a cache-buster so intermediate caches/CDNs can't hand us a
  // stale copy of yesterday's CLI. The server ignores unknown query
  // params, but the URL key changes per request so CDNs treat each call
  // as a fresh fetch. We also set request-level no-cache hints.
  const bustedParams = `${cliParams}&t=${Date.now()}`;
  const url = `https://forecast.weather.gov/product.php?${bustedParams}`;
  const stationCode = extractStationCode(cliParams);

  const resp = await fetch(url, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new Error(`NWS CLI fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const html = await resp.text();

  let text = html;
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch) text = preMatch[1];
  text = text
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");

  let dataDate: string | null = null;
  const dateMatch = text.match(
    /CLIMATE\s+SUMMARY\s+FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})/i,
  );
  if (dateMatch) {
    const month = MONTHS[dateMatch[1].toUpperCase()];
    const day = parseInt(dateMatch[2], 10);
    const year = parseInt(dateMatch[3], 10);
    if (month && Number.isFinite(day) && Number.isFinite(year)) {
      dataDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // Anchor the MONTH TO DATE regex to the PRECIPITATION section. The
  // CLI has TEMPERATURE first (with its own "MONTH TO DATE" mean), so a
  // naive match picks up the monthly average temperature.
  let mtd: number | null = null;
  const precipIdx = text.search(/PRECIPITATION\s*\(/i);
  if (precipIdx >= 0) {
    const precipSection = text.slice(precipIdx);
    const m = precipSection.match(/MONTH\s+TO\s+DATE\s+([\d.]+)/i);
    if (m) {
      const val = parseFloat(m[1]);
      if (!isNaN(val)) mtd = val;
    }
  }
  // Fall back to a global match only if the PRECIPITATION header wasn't
  // found at all (very rare — would indicate a malformed product).
  if (mtd === null && precipIdx < 0) {
    const m = text.match(/MONTH\s+TO\s+DATE\s+([\d.]+)/i);
    if (m) {
      const val = parseFloat(m[1]);
      if (!isNaN(val)) mtd = val;
    }
  }

  const now = new Date();
  const currentMonth = now.getUTCMonth() + 1;
  const currentYear = now.getUTCFullYear();
  const currentDay = now.getUTCDate();
  const currentMonthLabel = now.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });

  // --- Cross-month guard ---
  // On the first day or two of a new month, the freshest CLI product
  // is usually the prior month's final summary (e.g. "April 30" on
  // May 1) and contains the prior month's full MTD (e.g. 2.77"). The
  // new month's MTD is genuinely 0.00 until the first daily CLI for
  // it is published, so the prior-month value must not bleed forward.
  if (dataDate) {
    const reportMonth = parseInt(dataDate.substring(5, 7), 10);
    if (reportMonth !== currentMonth) {
      console.log(
        `[nws-cli] ${stationCode}: report date = ${dataDate}, ` +
          `current month = ${currentMonthLabel}, returning MTD = 0.00 ` +
          `(prior-month report; new month not yet reporting)`,
      );
      const synthesizedDate = `${currentYear}-${String(currentMonth).padStart(2, "0")}-01`;
      return { mtd: 0, dataDate: synthesizedDate };
    }
  } else if (mtd !== null && currentDay <= 2 && mtd > 0.5) {
    // Fallback: when the report date couldn't be parsed and we're at
    // the very start of a new month, an MTD significantly above zero
    // is more likely a stale prior-month value than a genuine reading.
    // Return null rather than risk reporting last month's total.
    console.log(
      `[nws-cli] ${stationCode}: report date = unparseable, ` +
        `current month = ${currentMonthLabel}, day ${currentDay}, ` +
        `MTD=${mtd} suspiciously high — returning null`,
    );
    return { mtd: null, dataDate: null };
  }

  if (dataDate) {
    const reportDate = new Date(dataDate + "T00:00:00Z");
    const fullMonth = reportDate.toLocaleString("en-US", {
      month: "long",
      timeZone: "UTC",
    });
    const shortMonth = reportDate.toLocaleString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
    const dayNum = reportDate.getUTCDate();
    const mtdLabel = mtd !== null ? `MTD=${mtd}` : "MTD=null";
    console.log(
      `[nws-cli] ${stationCode}: report date = ${dataDate}, ` +
        `current month = ${currentMonthLabel}, returning MTD = ${mtdLabel} ` +
        `(${fullMonth} ${dayNum})`,
    );

    const todayStr = utcDateString(now);
    const yd = new Date(now);
    yd.setUTCDate(yd.getUTCDate() - 1);
    const yesterdayStr = utcDateString(yd);
    if (dataDate !== todayStr && dataDate === yesterdayStr) {
      console.log(
        `[nws-cli] ${stationCode}: report is from yesterday (${shortMonth} ${dayNum})`,
      );
    }
  } else {
    console.log(
      `[nws-cli] ${stationCode}: report date = unparseable, ` +
        `current month = ${currentMonthLabel}, returning MTD = ${mtd ?? "null"}`,
    );
  }

  return { mtd, dataDate };
}

export function formatShortDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  if (isNaN(d.getTime())) return isoDate;
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}`;
}
