import { parseAccountId } from "@/lib/account";
import { listPostDeleteLog } from "@/lib/db";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Local SQLite only. Does not call X. */
export function GET(request: Request) {
  return handle(() => {
    const accountId = parseAccountId(new URL(request.url).searchParams.get("accountId"));
    const records = listPostDeleteLog(accountId);
    return { accountId, count: records.length, records };
  });
}
