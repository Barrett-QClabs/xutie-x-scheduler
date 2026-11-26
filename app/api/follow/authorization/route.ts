import { accountIdFrom, type AccountId } from "@/lib/account";
import { AppError } from "@/lib/errors";
import {
  account1RunAuthorization,
  authorizeAccount1Run,
  pauseAccount1Run,
  resumeAccount1Run,
  revokeAccount1Run,
} from "@/lib/follow-new-admission";
import { handle, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function account1(accountId: AccountId): 1 {
  if (accountId !== 1) throw new AppError("account_required", "新关注持续授权只属于账号1。账号2的新关注不需要授权。", 400);
  return 1;
}

/** Persistent kind=new run authorization. It does not end at midnight; daily caps still reset. */
export function GET(request: Request) {
  return handle(() => {
    account1(accountIdFrom(request));
    return account1RunAuthorization();
  });
}

/** `action`: `authorize` (default, optional `expiresAt` / `note`), `pause`, `resume`, or `revoke`. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    account1(accountIdFrom(request, body));
    const action = body.action ?? "authorize";
    if (action === "authorize") return authorizeAccount1Run({ expiresAt: body.expiresAt, note: body.note });
    if (action === "pause") return pauseAccount1Run();
    if (action === "resume") return resumeAccount1Run();
    if (action === "revoke") return revokeAccount1Run();
    throw new AppError("invalid_authorization", "action 只能是 authorize、pause、resume 或 revoke。");
  });
}

export function DELETE(request: Request) {
  return handle(() => {
    account1(accountIdFrom(request));
    return revokeAccount1Run();
  });
}
