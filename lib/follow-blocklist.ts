import type { AccountId } from "@/lib/account";
import { getDb } from "@/lib/db";

/** Confirmed unfollow for this account. Missing history before the baseline is not a block. */
export function followBlocked(accountId: AccountId, targetUserId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS ok FROM follow_blocklist WHERE account_id = ? AND target_user_id = ?")
    .get(accountId, targetUserId) as { ok: number } | undefined;
  return Boolean(row);
}

export function recordUnfollowBlock(accountId: AccountId, targetUserId: string, now: Date): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO follow_blocklist (account_id, target_user_id, source, blocked_at)
       VALUES (?, ?, 'unfollow_success', ?)`,
    )
    .run(accountId, targetUserId, now.toISOString());
}

export function recordAccount1UnfollowBlock(targetUserId: string, now: Date): void {
  recordUnfollowBlock(1, targetUserId, now);
}
