import { NextResponse } from "next/server";
import { loadServerSnapshots } from "@/lib/snapshot-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/snapshots
 *
 * Returns server-side forecast snapshots. Backed by Vercel Blob for
 * durability across cold starts, with /tmp as a warm-instance cache.
 * The Dashboard merges these with localStorage snapshots for the most
 * complete history.
 */
export async function GET() {
  try {
    const snapshots = await loadServerSnapshots();
    return NextResponse.json({
      snapshots,
      count: snapshots.length,
    });
  } catch {
    return NextResponse.json({ snapshots: [], count: 0 });
  }
}
