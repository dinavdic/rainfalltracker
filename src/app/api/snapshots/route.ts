import { NextResponse } from "next/server";
import { loadServerSnapshots } from "@/lib/snapshot-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/snapshots
 *
 * Returns server-side forecast snapshots cached in /tmp.
 * On Vercel, /tmp is ephemeral (cleared on cold starts), so this is a
 * best-effort supplement to the browser's localStorage. The Dashboard
 * merges these with localStorage snapshots for a more complete history.
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
