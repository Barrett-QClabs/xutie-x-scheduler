import { accountIdFrom } from "@/lib/account";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { approveAccount1NewFollow } from "@/lib/follow-new-admission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    if (accountId !== 1) throw new AppError("account_required", "新关注授权只属于账号1。", 400);
    return approveAccount1NewFollow({ approvedStart: body.approvedStart, approvedEnd: body.approvedEnd });
  });
}
