import { accountIdFrom } from "@/lib/account";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { listFollowReserve, stockFollowReserve } from "@/lib/follow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pageQuery(request: Request): { limit?: number; before: string | null } {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const before = url.searchParams.get("before");
  return {
    limit: rawLimit === null ? undefined : Number(rawLimit),
    before: before === null || before === "" ? null : before,
  };
}

export function GET(request: Request) {
  return handle(() => listFollowReserve(accountIdFrom(request), pageQuery(request)));
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    if (!Array.isArray(body.candidates)) throw new AppError("invalid_json", "储备名单格式不正确。");
    return stockFollowReserve(accountId, { checkedAt: body.checkedAt, candidates: body.candidates });
  });
}
