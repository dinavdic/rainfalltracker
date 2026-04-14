import { NWS_USER_AGENT } from "./stations";

/**
 * Minimal scraper for the NWS CLI (Climatological Report) text product.
 *
 * The product.php page wraps a plaintext CLI inside a <pre> block. We
 * extract that block and pull two signals:
 *   - MONTH TO DATE <value>         → mtd (inches)
 *   - CLIMATE SUMMARY FOR <MDY>     → dataDate (YYYY-MM-DD)
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

export async function fetchNWSCLI(cliParams: string): Promise<NWSCLIResult> {
  const url = `https://forecast.weather.gov/product.php?${cliParams}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": NWS_USER_AGENT },
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

  let mtd: number | null = null;
  const mtdMatch = text.match(/MONTH\s+TO\s+DATE\s+([\d.]+)/i);
  if (mtdMatch) {
    const val = parseFloat(mtdMatch[1]);
    if (!isNaN(val)) mtd = val;
  }

  return { mtd, dataDate };
}

export function formatShortDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  if (isNaN(d.getTime())) return isoDate;
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}`;
}
