import { accountIdFrom } from "@/lib/account";
import { handle, readJson } from "@/lib/http";
import { setUnfollowPaused } from "@/lib/unfollow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return setUnfollowPaused(accountIdFrom(request, body), true, "manual");
  });
}
