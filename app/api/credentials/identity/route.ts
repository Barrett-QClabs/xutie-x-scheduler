import { accountIdFrom } from "@/lib/account";
import { accountIdentity, saveManualIdentity } from "@/lib/account-identity";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** This slot's stored identity and whether follows/unfollows may run as it. Reads nothing from X. */
export function GET(request: Request) {
  return handle(() => accountIdentity(accountIdFrom(request)));
}

/**
 * Manual fallback when the explicit live identity read is unavailable: the operator supplies or
 * confirms `userId`, `username`, and optionally `displayName` for this slot's own saved keys.
 */
export async function PUT(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return saveManualIdentity(accountIdFrom(request, body), {
      userId: body.userId,
      username: body.username,
      displayName: body.displayName,
    });
  });
}
