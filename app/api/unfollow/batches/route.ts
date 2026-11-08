import { accountIdFrom } from "@/lib/account";
import { getCredentialsRow } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { ACCOUNT1_UNFOLLOW_USER_ID } from "@/lib/unfollow-policy";
import { inspectTarget, unfollowTarget } from "@/lib/unfollow-live";
import { requireUnfollowAccount, submitUnfollowBatch, type UnfollowHooks } from "@/lib/unfollow-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hooksForBatch(): UnfollowHooks | undefined {
  if (process.env.VITEST) {
    return (globalThis as { __xutiUnfollowHooks?: UnfollowHooks }).__xutiUnfollowHooks;
  }
  const sourceUserId = getCredentialsRow(1)?.user_id;
  if (sourceUserId !== ACCOUNT1_UNFOLLOW_USER_ID) return undefined;
  return {
    inspect: (targetUserId) => inspectTarget(sourceUserId, targetUserId),
    unfollow: (targetUserId) => unfollowTarget(sourceUserId, targetUserId),
  };
}

/** One half-hour batch for account 1. Does not import candidates and does not touch the post queue. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const accountId = accountIdFrom(request, body);
    requireUnfollowAccount(accountId);
    if (!process.env.VITEST && getCredentialsRow(1)?.user_id !== ACCOUNT1_UNFOLLOW_USER_ID) {
      throw new AppError("identity_unconfirmed", "账号1尚未确认是指定账号，不会取关。", 409);
    }
    return submitUnfollowBatch({ hooks: hooksForBatch() });
  });
}
