import { accountIdFrom } from "@/lib/account";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { admitAccount1NewFollows, listNewAdmissions } from "@/lib/follow-new-admission";
import { getFollowStatus } from "@/lib/follow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handle(() => {
    const accountId = accountIdFrom(request);
    if (accountId !== 1) throw new AppError("account_required", "新关注入池只属于账号1。", 400);
    return { ...getFollowStatus(1).newAdmission, candidates: listNewAdmissions() };
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    if (accountId !== 1) throw new AppError("account_required", "新关注入池只属于账号1。", 400);
    return admitAccount1NewFollows(body.candidates);
  });
}
