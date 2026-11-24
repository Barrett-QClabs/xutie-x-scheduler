import { accountIdFrom } from "@/lib/account";
import { getFollowAllowlist, saveFollowAllowlist } from "@/lib/follow-allowlist";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(() => getFollowAllowlist(accountIdFrom(request)));
}

export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return saveFollowAllowlist(accountIdFrom(request, body), {
      enforced: body.enforced,
      targetUserIds: body.targetUserIds,
    });
  });
}
