import type { AccountId } from "@/lib/account";
import {
  SETTINGS_LIMITS,
  currentSettings,
  persistAutomationSettings,
  validateAutomationSettingsPatch,
} from "@/lib/automation-settings";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";

/**
 * Compatibility marker. It used to read `compiled` and saving other work/rest minutes was refused.
 * Slot minutes, windows, and zones now come from the saved automation settings, and execution uses them.
 */
export const SETTINGS_SLOT_CLOCK = "settings" as const;

/** Account 1 default unfollow cap (the compiled value), and the ceiling applied to legacy saved ops. */
export const ACCOUNT1_UNFOLLOW_CAP = 80;

/** Account 1 view over its automation settings plus the daily-pool switch. */
export type AccountOps = {
  dailyPool: boolean;
  timezone: string;
  quotaTimezone: string;
  slotClock: typeof SETTINGS_SLOT_CLOCK;
  followback: {
    batchSize: number;
    workMinutes: number;
    restMinutes: number;
    anchorMinute: number;
    windowStartMinute: number | null;
    windowEndMinute: number | null;
    validUntil: "permanent";
  };
  unfollow: { batchSize: number; dailyCap: number | null; evidenceMaxHours: 25; validUntil: "next_09_capped_25h" };
  newFollow: {
    batchSize: number;
    workMinutes: number;
    restMinutes: number;
    windowStartMinute: 540;
    windowEndMinute: 300;
    requiresApproval: true;
    validUntil: "permanent";
  };
};

type LegacyOps = {
  dailyPool: boolean;
  newFollow: { batchSize: number; workMinutes: number; restMinutes: number };
};

const LEGACY_NEW_FOLLOW = { batchSize: 9, workMinutes: 15, restMinutes: 20 };

function integer(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The daily-pool switch and the retired evening new-follow numbers still live in `ops_json`. */
function readLegacyOps(): LegacyOps {
  const fallback = (): LegacyOps => ({ dailyPool: true, newFollow: { ...LEGACY_NEW_FOLLOW } });
  const row = getDb().prepare("SELECT ops_json FROM follow_account_config WHERE account_id = 1").get() as
    | { ops_json: string | null }
    | undefined;
  if (!row?.ops_json) return fallback();
  try {
    const parsed = record(JSON.parse(row.ops_json));
    const fresh = record(parsed?.newFollow);
    if (!parsed || typeof parsed.dailyPool !== "boolean" || !parsed.followback || !parsed.unfollow || !fresh) return fallback();
    return {
      dailyPool: parsed.dailyPool,
      newFollow: {
        batchSize: integer(fresh.batchSize, SETTINGS_LIMITS.batchSize.min, SETTINGS_LIMITS.batchSize.max) ?? LEGACY_NEW_FOLLOW.batchSize,
        workMinutes: integer(fresh.workMinutes, SETTINGS_LIMITS.workMinutes.min, SETTINGS_LIMITS.workMinutes.max) ?? LEGACY_NEW_FOLLOW.workMinutes,
        restMinutes: integer(fresh.restMinutes, SETTINGS_LIMITS.restMinutes.min, SETTINGS_LIMITS.restMinutes.max) ?? LEGACY_NEW_FOLLOW.restMinutes,
      },
    };
  } catch {
    return fallback();
  }
}

export function readAccountOps(accountId: AccountId): AccountOps | { dailyPool: false; locked: true } {
  if (accountId !== 1) return { dailyPool: false, locked: true };
  const legacy = readLegacyOps();
  const settings = currentSettings(1);
  const single = settings.follow.windows.length === 1 ? settings.follow.windows[0] : null;
  return {
    dailyPool: legacy.dailyPool,
    timezone: settings.scheduleTimezone,
    quotaTimezone: settings.quotaTimezone,
    slotClock: SETTINGS_SLOT_CLOCK,
    followback: {
      batchSize: settings.follow.batchSize,
      workMinutes: settings.follow.workMinutes,
      restMinutes: settings.follow.restMinutes,
      anchorMinute: settings.follow.anchorMinute,
      windowStartMinute: single?.start ?? null,
      windowEndMinute: single?.end ?? null,
      validUntil: "permanent",
    },
    unfollow: {
      batchSize: settings.unfollow.batchSize,
      dailyCap: settings.unfollow.dailyCap,
      evidenceMaxHours: 25,
      validUntil: "next_09_capped_25h",
    },
    newFollow: {
      ...legacy.newFollow,
      windowStartMinute: 540,
      windowEndMinute: 300,
      requiresApproval: true,
      validUntil: "permanent",
    },
  };
}

export function accountOps(accountId: AccountId): AccountOps | null {
  const ops = readAccountOps(accountId);
  if (!("followback" in ops) || !ops.dailyPool) return null;
  return ops;
}

export function dailyPoolOn(accountId: AccountId): boolean {
  return accountId === 1 && readLegacyOps().dailyPool;
}

/**
 * Account 1 only. Saves the daily-pool switch and writes batch sizes, the unfollow cap, and any
 * submitted follow cadence (work/rest/anchor/window) into the account 1 automation settings.
 * Nothing is written when any value is invalid.
 */
export function saveAccountOps(accountId: AccountId, input: unknown): AccountOps {
  if (accountId !== 1) throw new AppError("account_ops_locked", "账号2不使用日池配置，不能改这些开关。", 400);
  const body = record(input);
  if (!body) throw new AppError("invalid_ops", "ops 必须是对象。");
  if (typeof body.dailyPool !== "boolean") throw new AppError("invalid_ops", "dailyPool 必须是布尔值。");
  const followback = record(body.followback);
  const unfollow = record(body.unfollow);
  const fresh = record(body.newFollow);
  const batchMax = SETTINGS_LIMITS.batchSize.max;
  const followBatch = integer(followback?.batchSize, 1, batchMax);
  const newBatch = integer(fresh?.batchSize, 1, batchMax);
  const unfollowBatch = integer(unfollow?.batchSize, 1, batchMax);
  const unfollowCap = integer(unfollow?.dailyCap, 0, SETTINGS_LIMITS.unfollowDailyCap.max);
  if (followBatch === null || newBatch === null || unfollowBatch === null || unfollowCap === null) {
    throw new AppError("invalid_ops", "批量必须是 1 到 50 的整数，取关日上限必须是 0 到 400 的整数。");
  }
  const newWork = fresh && fresh.workMinutes !== undefined
    ? integer(fresh.workMinutes, 1, SETTINGS_LIMITS.workMinutes.max)
    : LEGACY_NEW_FOLLOW.workMinutes;
  const newRest = fresh && fresh.restMinutes !== undefined
    ? integer(fresh.restMinutes, 0, SETTINGS_LIMITS.restMinutes.max)
    : LEGACY_NEW_FOLLOW.restMinutes;
  if (newWork === null || newRest === null) {
    throw new AppError("invalid_ops", "newFollow 的工作分钟必须是 1 到 720 的整数，休息分钟必须是 0 到 720 的整数。");
  }
  const followLane: Record<string, unknown> = { batchSize: followBatch };
  for (const key of ["workMinutes", "restMinutes", "anchorMinute"] as const) {
    if (followback && followback[key] !== undefined) followLane[key] = followback[key];
  }
  if (followback && (followback.windowStartMinute !== undefined || followback.windowEndMinute !== undefined)) {
    followLane.windows = [{ start: followback.windowStartMinute, end: followback.windowEndMinute }];
  }
  const existing = getDb().prepare("SELECT account_id FROM follow_account_config WHERE account_id = 1").get();
  if (!existing) throw new AppError("missing_config", "请先保存账号1的关键词，再改日池开关。", 400);
  const patch: Record<string, unknown> = {
    follow: followLane,
    unfollow: { batchSize: unfollowBatch, dailyCap: unfollowCap },
  };
  // `timezone` in this view is the schedule zone. `slotClock` and `validUntil` are read-only markers.
  if (body.timezone !== undefined) patch.scheduleTimezone = body.timezone;
  if (body.quotaTimezone !== undefined) patch.quotaTimezone = body.quotaTimezone;
  const settings = validateAutomationSettingsPatch(1, patch);
  // Same shape the previous release reads, so a rollback keeps these numbers (it clamps what it cannot run).
  const mirror = {
    dailyPool: body.dailyPool,
    timezone: settings.scheduleTimezone,
    slotClock: SETTINGS_SLOT_CLOCK,
    followback: { batchSize: followBatch, workMinutes: settings.follow.workMinutes, restMinutes: settings.follow.restMinutes },
    unfollow: { batchSize: unfollowBatch, dailyCap: unfollowCap },
    newFollow: { batchSize: newBatch, workMinutes: newWork, restMinutes: newRest },
  };
  const now = new Date();
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    persistAutomationSettings(1, settings, now);
    db.prepare("UPDATE follow_account_config SET ops_json = ?, updated_at = ? WHERE account_id = 1").run(JSON.stringify(mirror), now.toISOString());
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* The ops transaction is already closed. */
    }
    throw error;
  }
  return readAccountOps(1) as AccountOps;
}

/** Saved daily unfollow cap for this account, or null when the account has no unfollow cap. */
export function unfollowDailyCap(accountId: AccountId): number | null {
  return currentSettings(accountId).unfollow.dailyCap;
}

/** Saved unfollow batch size for this account. */
export function unfollowBatchSize(accountId: AccountId): number {
  return currentSettings(accountId).unfollow.batchSize;
}

/** As before: account 1 with the daily pool on pauses its unfollow lane on a 429 or 403. */
export function unfollowPausesOnRisk(accountId: AccountId): boolean {
  return dailyPoolOn(accountId);
}
