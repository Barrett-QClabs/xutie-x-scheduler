import { ACCOUNT1_UNFOLLOW_USER_ID, INACTIVE_AFTER_MS, UNFOLLOW_BATCH_LIMIT, UNFOLLOW_WHITELIST } from "@/lib/unfollow-policy";
import { getCredentialsRow, getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { AccountId } from "@/lib/account";

export type UnfollowTier = "non_blue" | "no_followback_72h" | "inactive_48h";
export type UnfollowOutcome = "success" | "failed" | "skipped" | "unknown";

export type FreshProfile = {
  following: boolean | null;
  blue: boolean | null;
  followsBack: boolean | null;
  lastPostAt: string | null;
  lastPostKnown: boolean;
};

export type UnfollowHooks = {
  inspect: (targetUserId: string) => Promise<FreshProfile>;
  unfollow: (targetUserId: string) => Promise<void>;
};

const HOUR = 60 * 60 * 1000;
const TIER_RANK: Record<UnfollowTier, number> = {
  non_blue: 1,
  no_followback_72h: 2,
  inactive_48h: 3,
};

export function account1UnfollowEnabled(): boolean {
  return process.env.XUTIE_ACCOUNT1_UNFOLLOW === "on";
}

export function halfHourSlot(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const minute = Number(read("minute")) < 30 ? "00" : "30";
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${minute}`;
}

export function requireUnfollowAccount(accountId: AccountId): void {
  if (accountId !== 1) {
    throw new AppError("account_forbidden", "自动取关只允许账号1。", 403);
  }
}

export function classifyAction(input: {
  tier: UnfollowTier;
  firstRecordedAt: string | null;
  fresh: FreshProfile;
  now: Date;
  whitelisted: boolean;
}): { proceed: boolean; result: UnfollowOutcome; reason: string } {
  if (input.whitelisted) return { proceed: false, result: "skipped", reason: "whitelist" };
  if (input.fresh.following == null) return { proceed: false, result: "unknown", reason: "following_unconfirmed" };
  if (!input.fresh.following) return { proceed: false, result: "skipped", reason: "not_following" };
  if (input.tier === "non_blue") {
    if (input.fresh.blue == null) return { proceed: false, result: "unknown", reason: "blue_unconfirmed" };
    if (input.fresh.blue) return { proceed: false, result: "skipped", reason: "not_non_blue" };
  }
  if (input.tier === "no_followback_72h") {
    const recorded = Date.parse(input.firstRecordedAt ?? "");
    if (!input.firstRecordedAt || Number.isNaN(recorded)) {
      return { proceed: false, result: "unknown", reason: "first_recorded_unconfirmed" };
    }
    if (input.now.getTime() - recorded < 72 * HOUR) return { proceed: false, result: "skipped", reason: "grace_72h" };
    if (input.fresh.followsBack == null) return { proceed: false, result: "unknown", reason: "followback_unconfirmed" };
    if (input.fresh.followsBack) return { proceed: false, result: "skipped", reason: "follows_back" };
  }
  if (input.tier === "inactive_48h") {
    if (!input.fresh.lastPostKnown) return { proceed: false, result: "unknown", reason: "last_post_unconfirmed" };
    if (input.fresh.lastPostAt) {
      const posted = Date.parse(input.fresh.lastPostAt);
      if (Number.isNaN(posted)) return { proceed: false, result: "unknown", reason: "last_post_unconfirmed" };
      if (input.now.getTime() - posted <= INACTIVE_AFTER_MS) {
        return { proceed: false, result: "skipped", reason: "not_older_than_48h" };
      }
    }
  }
  return { proceed: true, result: "success", reason: "confirmed" };
}

type CandidateRow = {
  target_user_id: string;
  username: string | null;
  tier: string;
  first_recorded_at: string | null;
  status: string;
};

export type UnfollowBatchResult = {
  executed: boolean;
  replay: boolean;
  reason: string | null;
  slot: string | null;
  accountId: 1;
  submitted: number;
  unfollowed: number;
  results: Array<{ targetUserId: string; tier: UnfollowTier; result: UnfollowOutcome; reason: string }>;
};

function one<T>(sql: string, ...params: unknown[]): T | null {
  const row = getDb().prepare(sql).get(...params);
  return (row as T | undefined) ?? null;
}

function controlPaused(): boolean {
  const row = one<{ paused: number }>("SELECT paused FROM unfollow_control WHERE account_id = 1");
  return row?.paused !== 0;
}

export function setUnfollowPaused(paused: boolean, reason: string): { ok: true; paused: boolean } {
  requireUnfollowAccount(1);
  getDb()
    .prepare(`UPDATE unfollow_control SET paused = ?, pause_reason = ?, updated_at = ? WHERE account_id = 1`)
    .run(paused ? 1 : 0, reason, new Date().toISOString());
  return { ok: true, paused };
}

export function getUnfollowStatus() {
  const control = one<{ paused: number; pause_reason: string | null }>(
    "SELECT paused, pause_reason FROM unfollow_control WHERE account_id = 1",
  );
  const counts = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM unfollow_candidates WHERE account_id = 1 GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const last = one<{
    slot: string;
    status: string;
    submitted: number;
    unfollowed: number;
    finished_at: string | null;
  }>("SELECT slot, status, submitted, unfollowed, finished_at FROM unfollow_batches ORDER BY started_at DESC LIMIT 1");
  return {
    accountId: 1 as const,
    enabled: account1UnfollowEnabled(),
    paused: control?.paused !== 0,
    pauseReason: control?.pause_reason ?? null,
    batchSize: UNFOLLOW_BATCH_LIMIT,
    inactiveAfterMs: INACTIVE_AFTER_MS,
    counts: Object.fromEntries(counts.map((row) => [row.status, row.n])),
    lastBatch: last,
    whitelistSize: UNFOLLOW_WHITELIST.size,
  };
}

function parseTier(value: unknown): UnfollowTier {
  if (value === "non_blue" || value === "no_followback_72h" || value === "inactive_48h") return value;
  throw new AppError("invalid_tier", "取关层级必须是 non_blue、no_followback_72h 或 inactive_48h。");
}

function normalizeTier(value: string): UnfollowTier | null {
  if (value === "inactive_36h" || value === "inactive_48h") return "inactive_48h";
  if (value === "non_blue" || value === "no_followback_72h") return value;
  return null;
}

export function importUnfollowCandidates(input: {
  candidates: Array<{ targetUserId?: unknown; username?: unknown; tier?: unknown; firstRecordedAt?: unknown }>;
}): { accepted: string[]; existing: string[]; rejected: Array<{ targetUserId: string; reason: string }> } {
  requireUnfollowAccount(1);
  const accepted: string[] = [];
  const existing: string[] = [];
  const rejected: Array<{ targetUserId: string; reason: string }> = [];
  const now = new Date().toISOString();
  const insert = getDb().prepare(
    `INSERT INTO unfollow_candidates
      (account_id, target_user_id, username, tier, first_recorded_at, status, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, 'candidate', ?, ?)`,
  );
  for (const raw of input.candidates) {
    const id = typeof raw.targetUserId === "string" ? raw.targetUserId.trim() : "";
    if (!/^\d+$/.test(id)) {
      rejected.push({ targetUserId: id || "?", reason: "invalid_id" });
      continue;
    }
    if (UNFOLLOW_WHITELIST.has(id)) {
      rejected.push({ targetUserId: id, reason: "whitelist" });
      continue;
    }
    let tier: UnfollowTier;
    try {
      tier = parseTier(raw.tier);
    } catch {
      rejected.push({ targetUserId: id, reason: "invalid_tier" });
      continue;
    }
    const recorded = typeof raw.firstRecordedAt === "string" && !Number.isNaN(Date.parse(raw.firstRecordedAt)) ? raw.firstRecordedAt : null;
    if (tier === "no_followback_72h" && !recorded) {
      rejected.push({ targetUserId: id, reason: "first_recorded_required" });
      continue;
    }
    const found = one<{ status: string }>(
      "SELECT status FROM unfollow_candidates WHERE account_id = 1 AND target_user_id = ?",
      id,
    );
    if (found) {
      existing.push(id);
      continue;
    }
    const username = typeof raw.username === "string" ? raw.username.slice(0, 64) : null;
    insert.run(id, username, tier, recorded, now, now);
    accepted.push(id);
  }
  return { accepted, existing, rejected };
}

function locallyReady(row: CandidateRow, now: Date): boolean {
  const tier = normalizeTier(row.tier);
  if (!tier || UNFOLLOW_WHITELIST.has(row.target_user_id)) return false;
  if (tier !== "no_followback_72h") return true;
  const recorded = Date.parse(row.first_recorded_at ?? "");
  return !Number.isNaN(recorded) && now.getTime() - recorded >= 72 * HOUR;
}

function selectBatch(now: Date): CandidateRow[] {
  const rows = getDb()
    .prepare(
      `SELECT target_user_id, username, tier, first_recorded_at, status
       FROM unfollow_candidates WHERE account_id = 1 AND status = 'candidate'`,
    )
    .all() as CandidateRow[];
  return rows
    .filter((row) => locallyReady(row, now))
    .sort((a, b) => {
      const left = TIER_RANK[normalizeTier(a.tier) ?? "inactive_48h"];
      const right = TIER_RANK[normalizeTier(b.tier) ?? "inactive_48h"];
      return left - right || a.target_user_id.localeCompare(b.target_user_id);
    })
    .slice(0, UNFOLLOW_BATCH_LIMIT);
}

function identityAllowsRun(): { ok: true } | { ok: false; reason: string } {
  const userId = getCredentialsRow(1)?.user_id ?? null;
  if (userId !== ACCOUNT1_UNFOLLOW_USER_ID) return { ok: false, reason: "identity_unconfirmed" };
  return { ok: true };
}

function emptyResult(slot: string | null, reason: string): UnfollowBatchResult {
  return {
    executed: false,
    replay: false,
    reason,
    slot,
    accountId: 1,
    submitted: 0,
    unfollowed: 0,
    results: [],
  };
}

export async function submitUnfollowBatch(input?: { now?: Date; hooks?: UnfollowHooks }): Promise<UnfollowBatchResult> {
  const now = input?.now ?? new Date();
  const slot = halfHourSlot(now);
  if (!account1UnfollowEnabled()) return emptyResult(slot, "disabled");
  if (!identityAllowsRun().ok) return emptyResult(slot, "identity_unconfirmed");
  if (controlPaused()) return emptyResult(slot, "paused");
  const hooks = input?.hooks;
  if (!hooks) return emptyResult(slot, "verifier_unavailable");

  const db = getDb();
  const existing = one<{ status: string; submitted: number; unfollowed: number; results_json: string | null }>(
    "SELECT status, submitted, unfollowed, results_json FROM unfollow_batches WHERE slot = ?",
    slot,
  );
  if (existing && existing.status !== "running") {
    return {
      executed: true,
      replay: true,
      reason: null,
      slot,
      accountId: 1,
      submitted: existing.submitted,
      unfollowed: existing.unfollowed,
      results: existing.results_json ? (JSON.parse(existing.results_json) as UnfollowBatchResult["results"]) : [],
    };
  }
  const running = one<{ slot: string }>("SELECT slot FROM unfollow_batches WHERE status = 'running'");
  if (running) return emptyResult(slot, "overlap");

  const picked = selectBatch(now);
  try {
    db.prepare(
      `INSERT INTO unfollow_batches (slot, account_id, status, submitted, unfollowed, results_json, started_at)
       VALUES (?, 1, 'running', 0, 0, '[]', ?)`,
    ).run(slot, now.toISOString());
  } catch {
    return emptyResult(slot, "overlap");
  }

  const results: UnfollowBatchResult["results"] = [];
  try {
    for (const row of picked) {
      db.prepare(
        `UPDATE unfollow_candidates SET status = 'submitted', batch_slot = ?, updated_at = ? WHERE account_id = 1 AND target_user_id = ?`,
      ).run(slot, new Date().toISOString(), row.target_user_id);
      let outcome: { result: UnfollowOutcome; reason: string };
      try {
        const fresh = await hooks.inspect(row.target_user_id);
        const decision = classifyAction({
          tier: normalizeTier(row.tier) ?? "inactive_48h",
          firstRecordedAt: row.first_recorded_at,
          fresh,
          now,
          whitelisted: UNFOLLOW_WHITELIST.has(row.target_user_id),
        });
        if (!decision.proceed) outcome = { result: decision.result, reason: decision.reason };
        else {
          await hooks.unfollow(row.target_user_id);
          outcome = { result: "success", reason: "confirmed" };
        }
      } catch {
        outcome = { result: "failed", reason: "action_failed" };
      }
      db.prepare(
        `UPDATE unfollow_candidates SET status = ?, result = ?, reason = ?, updated_at = ? WHERE account_id = 1 AND target_user_id = ?`,
      ).run(outcome.result, outcome.result, outcome.reason, new Date().toISOString(), row.target_user_id);
      results.push({ targetUserId: row.target_user_id, tier: normalizeTier(row.tier) ?? "inactive_48h", result: outcome.result, reason: outcome.reason });
    }
  } finally {
    const unfollowed = results.filter((item) => item.result === "success").length;
    db.prepare(
      `UPDATE unfollow_batches SET status = 'completed', submitted = ?, unfollowed = ?, results_json = ?, finished_at = ? WHERE slot = ?`,
    ).run(results.length, unfollowed, JSON.stringify(results), new Date().toISOString(), slot);
  }
  return {
    executed: true,
    replay: false,
    reason: null,
    slot,
    accountId: 1,
    submitted: results.length,
    unfollowed: results.filter((item) => item.result === "success").length,
    results,
  };
}
