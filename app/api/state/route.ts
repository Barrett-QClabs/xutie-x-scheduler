import { accountIdFrom } from "@/lib/account";
import { handle } from "@/lib/http";
import { getPublicState } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(() => getPublicState(new Date(), accountIdFrom(request)));
}
