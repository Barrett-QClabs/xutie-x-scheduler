import { accountIdFrom } from "@/lib/account";
import { handle } from "@/lib/http";
import { getFollowStatus } from "@/lib/follow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(() => getFollowStatus(accountIdFrom(request)));
}
