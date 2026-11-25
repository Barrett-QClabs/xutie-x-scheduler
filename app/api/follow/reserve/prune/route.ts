import { accountIdFrom } from "@/lib/account";
import { pruneActiveReserve } from "@/lib/follow-queue";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return pruneActiveReserve(accountIdFrom(request, body), {
      kinds: body.kinds,
      statuses: body.statuses,
      reason: body.reason,
    });
  });
}
