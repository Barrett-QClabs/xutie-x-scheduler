import type { AccountId } from "@/lib/account";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";

/** Compiled slot clock. Saved window numbers are shown, not used to move slot keys. */
export const COMPILED_SLOT_CLOCK = "compiled" as const;

export type AccountOps = {
  dailyPool: boolean;
  timezone: "Asia/Taipei";
  slotClock: typeof COMPILED_SLOT_CLOCK;
  followback: { batchSize: number; workMinutes: 15; restMinutes: 18; windowStartMinute: 0; windowEndMinute: 300; validUntil: "next_05" };
  unfollow: { batchSize: number; dailyCap: number; evidenceMaxHours: 25; validUntil: "next_09_capped_25h" };
  newFollow: { batchSize: number; workMinutes: 15; restMinutes: 20; windowStartMinute: 1080; windowEndMinute: 1440; requiresApproval: true; validUntil: "next_evening_24" };
};

const ACCOUNT1_DEFAULT: AccountOps = {
  dailyPool: true,
  timezone: "Asia/Taipei",
  slotClock: COMPILED_SLOT_CLOCK,
  followback: { batchSize: 13, workMinutes: 15, restMinutes: 18, windowStartMinute: 0, windowEndMinute: 300, validUntil: "next_05" },
  unfollow: { batchSize: 10, dailyCap: 80, evidenceMaxHours: 25, validUntil: "next_09_capped_25h" },
  newFollow: { batchSize: 9, workMinutes: 15, restMinutes: 20, windowStartMinute: 1080, windowEndMinute: 1440, requiresApproval: true, validUntil: "next_evening_24" },
};

function cloneDefault(): AccountOps {
  return {
    ...ACCOUNT1_DEFAULT,
    followback: { ...ACCOUNT1_DEFAULT.followback },
    unfollow: { ...ACCOUNT1_DEFAULT.unfollow },
    newFollow: { ...ACCOUNT1_DEFAULT.newFollow },
  };
}

export function readAccountOps(accountId: AccountId): AccountOps | { dailyPool: false; locked: true } {
  if (accountId !== 1) return { dailyPool: false, locked: true };
  const row = getDb().prepare("SELECT ops_json FROM follow_account_config WHERE account_id = 1").get() as { ops_json: string | null } | undefined;
  if (!row?.ops_json) return cloneDefault();
  try {
    const parsed = JSON.parse(row.ops_json) as AccountOps;
    if (typeof parsed?.dailyPool !== "boolean" || !parsed.followback || !parsed.unfollow || !parsed.newFollow) return cloneDefault();
    return parsed;
  } catch {
    return cloneDefault();
  }
}

export function accountOps(accountId: AccountId): AccountOps | null {
  const ops = readAccountOps(accountId);
  if (!("followback" in ops) || !ops.dailyPool) return null;
  return ops;
}

export function dailyPoolOn(accountId: AccountId): boolean {
  return accountOps(accountId)?.dailyPool === true;
}

function integer(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

export function saveAccountOps(accountId: AccountId, input: unknown): AccountOps {
  if (accountId !== 1) throw new AppError("account_ops_locked", "账号2不使用日池配置，不能改这些开关。", 400);
  const body = input && typeof input === "object" ? input as Record<string, unknown> : null;
  if (!body) throw new AppError("invalid_ops", "ops 必须是对象。");
  if (typeof body.dailyPool !== "boolean") throw new AppError("invalid_ops", "dailyPool 必须是布尔值。");
  const followback = body.followback as Record<string, unknown> | undefined;
  const unfollow = body.unfollow as Record<string, unknown> | undefined;
  const fresh = body.newFollow as Record<string, unknown> | undefined;
  const followBatch = integer(followback?.batchSize, 1, 20);
  const newBatch = integer(fresh?.batchSize, 1, 20);
  const unfollowBatch = integer(unfollow?.batchSize, 1, 20);
  const unfollowCap = integer(unfollow?.dailyCap, 0, 380);
  if (followBatch === null || newBatch === null || unfollowBatch === null || unfollowCap === null) {
    throw new AppError("invalid_ops", "批量必须是 1 到 20 的整数，取关日上限必须是 0 到 380 的整数。");
  }
  if (followback?.workMinutes !== 15 || followback?.restMinutes !== 18 || fresh?.workMinutes !== 15 || fresh?.restMinutes !== 20) {
    throw new AppError("slot_clock_fixed", "工作/休息分钟和窗口时刻固定在已编译的槽位上，只能改开关、批量和日上限。");
  }
  const ops: AccountOps = {
    dailyPool: body.dailyPool,
    timezone: "Asia/Taipei",
    slotClock: COMPILED_SLOT_CLOCK,
    followback: { ...ACCOUNT1_DEFAULT.followback, batchSize: followBatch },
    unfollow: { ...ACCOUNT1_DEFAULT.unfollow, batchSize: unfollowBatch, dailyCap: unfollowCap },
    newFollow: { ...ACCOUNT1_DEFAULT.newFollow, batchSize: newBatch },
  };
  const existing = getDb().prepare("SELECT account_id FROM follow_account_config WHERE account_id = 1").get();
  if (!existing) throw new AppError("missing_config", "请先保存账号1的关键词，再改日池开关。", 400);
  getDb().prepare("UPDATE follow_account_config SET ops_json = ?, updated_at = ? WHERE account_id = 1").run(JSON.stringify(ops), new Date().toISOString());
  return ops;
}

export function followBatchSize(accountId: AccountId, phase: "followback" | "new" | null): number | null {
  const ops = accountOps(accountId);
  if (!ops || !phase) return null;
  return phase === "new" ? ops.newFollow.batchSize : ops.followback.batchSize;
}

export function unfollowLimits(accountId: AccountId): { batchSize: number; dailyCap: number } | null {
  const ops = accountOps(accountId);
  if (!ops) return null;
  return { batchSize: ops.unfollow.batchSize, dailyCap: ops.unfollow.dailyCap };
}
