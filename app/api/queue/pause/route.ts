import { handle } from "@/lib/http";
import { pauseQueue } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  return handle(() => pauseQueue("manual"));
}
