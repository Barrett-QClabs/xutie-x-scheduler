import { accountIdFrom } from "@/lib/account";
import { getFollowConfig, saveFollowConfig } from "@/lib/follow-config";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(() => getFollowConfig(accountIdFrom(request)));
}

export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return saveFollowConfig(accountIdFrom(request, body), body.keywords);
  });
}
