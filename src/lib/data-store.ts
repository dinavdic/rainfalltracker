import { promises as fs } from "fs";
import path from "path";
import { RainfallApiResponse } from "./types";

const DATA_FILE = path.join(process.cwd(), "public", "data", "latest-rainfall.json");

export async function saveRainfallData(data: RainfallApiResponse): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

export async function loadRainfallData(): Promise<RainfallApiResponse | null> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as RainfallApiResponse;
  } catch {
    return null;
  }
}

/**
 * Check if cached data is still fresh (less than 6 hours old).
 */
export function isCacheFresh(data: RainfallApiResponse): boolean {
  const fetchedAt = new Date(data.fetchedAt).getTime();
  const sixHoursMs = 6 * 60 * 60 * 1000;
  return Date.now() - fetchedAt < sixHoursMs;
}
