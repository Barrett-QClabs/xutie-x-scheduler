import { handle } from "@/lib/http";
import { getDailyStats } from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/stats/daily?days=7&refresh=1
export function GET(request: Request) {
  const url = new URL(request.url);
  return handle(() => getDailyStats({ days: Number(url.searchParams.get("days") ?? 7), refresh: url.searchParams.get("refresh") === "1" }));
}
