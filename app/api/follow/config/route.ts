import { accountIdFrom } from "@/lib/account";
import { ensureFollowConfig, getFollowConfig, saveFollowConfig, saveFollowOps } from "@/lib/follow-config";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(() => getFollowConfig(accountIdFrom(request)));
}

export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    if (body.ops !== undefined) {
      ensureFollowConfig(accountId);
      return saveFollowOps(accountId, body.ops);
    }
    return saveFollowConfig(accountId, body.keywords);
  });
}
