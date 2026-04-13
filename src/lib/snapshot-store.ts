import { promises as fs } from "fs";
import path from "path";
import { ForecastSnapshot, appendSnapshot } from "./convergence";

/**
 * Best-effort server-side snapshot storage using /tmp.
 *
 * On Vercel, /tmp is ephemeral per-function and cleared on cold starts,
 * so this is purely a warm-instance cache. The real persistence layer is
 * the browser's localStorage — the Dashboard saves a snapshot on every
 * visit and merges any /tmp snapshots it can retrieve via /api/snapshots.
 */

const TMP_PATH = path.join("/tmp", "forecast-snapshots.json");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Load snapshots from /tmp. Returns empty array on cold start or error.
 */
export async function loadServerSnapshots(): Promise<ForecastSnapshot[]> {
  try {
    const raw = await fs.readFile(TMP_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];

    const cutoff = Date.now() - MAX_AGE_MS;
    return (data as ForecastSnapshot[]).filter(
      (s) => new Date(s.timestamp).getTime() > cutoff,
    );
  } catch {
    return [];
  }
}

/**
 * Save a snapshot to /tmp. Reads existing, appends with dedup/pruning,
 * and writes back. Silently ignores write failures.
 */
export async function saveServerSnapshot(
  snapshot: ForecastSnapshot,
): Promise<void> {
  try {
    const existing = await loadServerSnapshots();
    const updated = appendSnapshot(existing, snapshot);
    await fs.writeFile(TMP_PATH, JSON.stringify(updated));
  } catch {
    // /tmp write failed — non-fatal
  }
}
