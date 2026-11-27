import type { AccountId } from "@/lib/account";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";

const MAX_IDS = 5000;

export type FollowAllowlistView = {
  accountId: AccountId;
  enforced: boolean;
  count: number;
  targetUserIds: string[];
  preservesHistory: true;
  touchesBlocklist: false;
};

function idsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) throw new AppError("invalid_allowlist", "targetUserIds 必须是字符串数组。");
  if (value.length > MAX_IDS) throw new AppError("invalid_allowlist", "执行白名单一次最多 5000 个 id。");
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!/^\d{1,32}$/.test(id)) throw new AppError("invalid_allowlist", "目标 id 必须是 1 到 32 位数字。");
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function followAllowlistEnforced(accountId: AccountId): boolean {
  const row = getDb()
    .prepare("SELECT enforced FROM follow_allowlist_control WHERE account_id = ?")
    .get(accountId) as { enforced: number } | undefined;
  return row?.enforced === 1;
}

/** Operator-written execution list. Enforcement being off does not invent membership. */
export function followOperatorListed(accountId: AccountId, targetUserId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS ok FROM follow_execution_allowlist WHERE account_id = ? AND target_user_id = ?")
    .get(accountId, targetUserId) as { ok: number } | undefined;
  return Boolean(row);
}

export function followExecutionAllowed(accountId: AccountId, targetUserId: string): boolean {
  return !followAllowlistEnforced(accountId) || followOperatorListed(accountId, targetUserId);
}

export function getFollowAllowlist(accountId: AccountId): FollowAllowlistView {
  const rows = getDb()
    .prepare("SELECT target_user_id FROM follow_execution_allowlist WHERE account_id = ? ORDER BY target_user_id ASC")
    .all(accountId) as Array<{ target_user_id: string }>;
  return {
    accountId,
    enforced: followAllowlistEnforced(accountId),
    count: rows.length,
    targetUserIds: rows.map((row) => row.target_user_id),
    preservesHistory: true,
    touchesBlocklist: false,
  };
}

/** Replaces this account's execution set. Does not delete reserve, admission, success, or the unfollow blocklist. */
export function saveFollowAllowlist(accountId: AccountId, input: { enforced?: unknown; targetUserIds?: unknown }): FollowAllowlistView {
  if (typeof input.enforced !== "boolean") throw new AppError("invalid_allowlist", "enforced 必须是布尔值。");
  const ids = idsFrom(input.targetUserIds);
  const db = getDb();
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO follow_allowlist_control (account_id, enforced, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET enforced = excluded.enforced, updated_at = excluded.updated_at`,
    ).run(accountId, input.enforced ? 1 : 0, now);
    db.prepare("DELETE FROM follow_execution_allowlist WHERE account_id = ?").run(accountId);
    const insert = db.prepare(
      "INSERT INTO follow_execution_allowlist (account_id, target_user_id, created_at) VALUES (?, ?, ?)",
    );
    for (const id of ids) insert.run(accountId, id, now);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* The allowlist transaction is already closed. */
    }
    throw error;
  }
  return getFollowAllowlist(accountId);
}
