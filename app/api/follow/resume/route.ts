import { accountIdFrom } from "@/lib/account";
import { handle, readJson } from "@/lib/http";
import { setFollowPaused } from "@/lib/follow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return setFollowPaused(accountIdFrom(request, body), false, "manual_resume");
  });
}
