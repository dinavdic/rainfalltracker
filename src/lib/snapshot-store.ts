import { put, list } from "@vercel/blob";
import { ForecastSnapshot, appendSnapshot } from "./convergence";

const BLOB_PATH = "forecast-snapshots.json";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Load all snapshots from Vercel Blob storage.
 * Returns an empty array if no blob exists or blob storage is unavailable.
 */
export async function loadServerSnapshots(): Promise<ForecastSnapshot[]> {
  try {
    const { blobs } = await list({ prefix: BLOB_PATH });
    if (blobs.length === 0) return [];

    const resp = await fetch(blobs[0].url);
    if (!resp.ok) return [];

    const data = await resp.json();
    if (!Array.isArray(data)) return [];

    // Prune stale entries on read
    const cutoff = Date.now() - MAX_AGE_MS;
    return (data as ForecastSnapshot[]).filter(
      (s) => new Date(s.timestamp).getTime() > cutoff
    );
  } catch (e) {
    console.warn("[snapshot-store] Failed to load from Blob:", e);
    return [];
  }
}

/**
 * Save a snapshot to Vercel Blob storage.
 * Reads existing snapshots, appends (with dedup/pruning), and writes back.
 */
export async function saveServerSnapshot(
  snapshot: ForecastSnapshot,
): Promise<void> {
  const existing = await loadServerSnapshots();
  const updated = appendSnapshot(existing, snapshot);

  await put(BLOB_PATH, JSON.stringify(updated), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
}
