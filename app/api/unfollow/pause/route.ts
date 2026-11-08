import { pauseFromBody } from "@/app/api/unfollow/route";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handle(() => pauseFromBody(request, true));
}
