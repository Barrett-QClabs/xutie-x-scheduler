import type { AccountId } from "@/lib/account";
import { audienceMatch, preferFlb, spamText } from "@/lib/audience";
import { evidenceFollowProfile } from "@/lib/evidence";
import { followTarget } from "@/lib/follow-live";
import { ACCOUNT_USER_ID, audienceFor, followEnabled } from "@/lib/automation-account";
import { getCredentialsRow, getDb } from "@/lib/db";
import { apiMode } from "@/lib/deployment";
import { AppError } from "@/lib/errors";
import { londonClock, londonFollowSlot } from "@/lib/london";
import { FOLLOW_BATCH_LIMIT, FOLLOW_DAILY_CAP, MAX_FOLLOWERS, RESERVE_FRESH_MS } from "@/lib/unfollow-policy";

export type FollowKind = "followback" | "new";
export type FollowOutcome = "success" | "failed" | "skipped" | "unknown";

export type FollowProfile = {
  blue: boolean | null;
  following: boolean | null;
  followsBack: boolean | null;
  followers: number | null;
  name: string | null;
  bio: string | null;
  username: string | null;
  tweetLang: string | null;
  tweetText: string | null;
  lastPostAt: string | null;
  lastPostKnown: boolean;
};

export type FollowHooks = {
  inspect: (targetUserId: string) => Promise<FollowProfile>;
  follow: (targetUserId: string) => Promise<void>;
};

export type FollowReserveView = {
  updatedAt: string | null;
  available: number;
  followbackAvailable: number;
  newAvailable: number;
  stale: number;
  gap: number;
  constraint: string | null;
};

const NO_RETRY = new Set(["unknown", "failed", "followed"]);

function one<T>(sql: string, ...params: unknown[]): T | null {
  const row = getDb().prepare(sql).get(...params);
  return (row as T | undefined) ?? null;
}

function realTime(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function parseKind(value: unknown): FollowKind {
  if (value === "followback" || value === "new") return value;
  throw new AppError("invalid_kind", "储备类型必须是 followback 或 new。");
}

export function followedToday(accountId: AccountId, now: Date): number {
  const day = londonClock(now).day;
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM follow_success WHERE account_id = ? AND london_day = ?",
    accountId,
    day,
  );
  return row?.n ?? 0;
}

export function reserveView(accountId: AccountId, now: Date): FollowReserveView {
  const rows = getDb()
    .prepare(`SELECT kind, status, checked_at, updated_at FROM follow_reserve WHERE account_id = ?`)
    .all(accountId) as Array<{ kind: string; status: string; checked_at: string; updated_at: string }>;
  const freshAfter = now.getTime() - RESERVE_FRESH_MS;
  let updatedAt: string | null = null;
  let available = 0;
  let followbackAvailable = 0;
  let newAvailable = 0;
  let stale = 0;
  for (const row of rows) {
    if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at;
    if (row.status !== "reserved") continue;
    const checked = Date.parse(row.checked_at);
    if (Number.isNaN(checked) || checked < freshAfter) {
      stale += 1;
      continue;
    }
    available += 1;
    if (row.kind === "followback") followbackAvailable += 1;
    else newAvailable += 1;
  }
  const remaining = Math.max(0, FOLLOW_DAILY_CAP - followedToday(accountId, now));
  const room = Math.min(FOLLOW_BATCH_LIMIT, remaining);
  const gap = Math.max(0, room - available);
  return {
    updatedAt,
    available,
    followbackAvailable,
    newAvailable,
    stale,
    gap,
    constraint: reserveConstraint({
      accountId,
      now,
      available,
      stale,
      remaining,
      gap,
    }),
  };
}

function reserveConstraint(input: {
  accountId: AccountId;
  now: Date;
  available: number;
  stale: number;
  remaining: number;
  gap: number;
}): string | null {
  if (!followEnabled(input.accountId)) return "disabled";
  if (getCredentialsRow(input.accountId)?.user_id !== ACCOUNT_USER_ID[input.accountId]) return "identity_unconfirmed";
  const paused = one<{ paused: number }>("SELECT paused FROM follow_control WHERE account_id = ?", input.accountId);
  if (paused?.paused !== 0) return "paused";
  if (!londonFollowSlot(input.now)) return "rest";
  if (input.remaining <= 0) return "daily_cap";
  if (input.available === 0 && input.stale > 0) return "stale_reserve";
  if (input.gap > 0) return "insufficient_candidates";
  return null;
}

export function getFollowStatus(accountId: AccountId, now = new Date()) {
  const control = one<{ paused: number; pause_reason: string | null }>(
    "SELECT paused, pause_reason FROM follow_control WHERE account_id = ?",
    accountId,
  );
  const reserve = reserveView(accountId, now);
  const recent = getDb()
    .prepare(
      `SELECT target_user_id, username, kind, succeeded_at, slot, london_day
       FROM follow_success WHERE account_id = ? ORDER BY succeeded_at DESC LIMIT 20`,
    )
    .all(accountId) as Array<{
    target_user_id: string;
    username: string | null;
    kind: string;
    succeeded_at: string;
    slot: string;
    london_day: string;
  }>;
  const followed = followedToday(accountId, now);
  return {
    accountId,
    audience: audienceFor(accountId),
    enabled: followEnabled(accountId),
    paused: control?.paused !== 0,
    pauseReason: control?.pause_reason ?? null,
    apiMode: apiMode(),
    identityConfirmed: getCredentialsRow(accountId)?.user_id === ACCOUNT_USER_ID[accountId],
    londonDay: londonClock(now).day,
    schedule: londonFollowSlot(now) ? "work" : "rest",
    batchSize: FOLLOW_BATCH_LIMIT,
    dailyCap: FOLLOW_DAILY_CAP,
    followedToday: followed,
    remainingQuota: Math.max(0, FOLLOW_DAILY_CAP - followed),
    reserve,
    recentSuccess: recent.map((row) => ({
      targetUserId: row.target_user_id,
      username: row.username,
      kind: row.kind,
      succeededAt: row.succeeded_at,
      slot: row.slot,
      londonDay: row.london_day,
    })),
  };
}

export function setFollowPaused(accountId: AccountId, paused: boolean, reason: string) {
  getDb()
    .prepare(`UPDATE follow_control SET paused = ?, pause_reason = ?, updated_at = ? WHERE account_id = ?`)
    .run(paused ? 1 : 0, reason, new Date().toISOString(), accountId);
  return { ok: true as const, accountId, paused };
}

export function stockFollowReserve(
  accountId: AccountId,
  input: {
    checkedAt?: unknown;
    candidates: Array<{
      targetUserId?: unknown;
      username?: unknown;
      kind?: unknown;
      checkedAt?: unknown;
      followersCount?: unknown;
      lastPostAt?: unknown;
      flb?: unknown;
    }>;
  },
): { accepted: string[]; refreshed: string[]; existing: string[]; rejected: Array<{ targetUserId: string; reason: string }> } {
  const fallback = realTime(input.checkedAt);
  if (input.checkedAt !== undefined && !fallback) {
    throw new AppError("invalid_checked_at", "名单核验时间无法解析。");
  }
  const accepted: string[] = [];
  const refreshed: string[] = [];
  const existing: string[] = [];
  const rejected: Array<{ targetUserId: string; reason: string }> = [];
  const now = new Date().toISOString();
  const insert = getDb().prepare(
    `INSERT INTO follow_reserve
      (account_id, target_user_id, username, kind, status, checked_at, followers_count, last_post_at, prefer_flb, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`,
  );
  const refresh = getDb().prepare(
    `UPDATE follow_reserve
     SET username = ?, kind = ?, status = 'reserved', checked_at = ?, followers_count = ?, last_post_at = ?, prefer_flb = ?,
         result = NULL, reason = NULL, updated_at = ?
     WHERE account_id = ? AND target_user_id = ?`,
  );
  for (const raw of input.candidates) {
    const id = typeof raw.targetUserId === "string" ? raw.targetUserId.trim() : "";
    if (!/^\d+$/.test(id)) {
      rejected.push({ targetUserId: id || "?", reason: "invalid_id" });
      continue;
    }
    let kind: FollowKind;
    try {
      kind = parseKind(raw.kind);
    } catch {
      rejected.push({ targetUserId: id, reason: "invalid_kind" });
      continue;
    }
    const checked = realTime(raw.checkedAt) ?? fallback;
    if (!checked) {
      rejected.push({ targetUserId: id, reason: "checked_at_required" });
      continue;
    }
    if (Date.parse(checked) > Date.now() + 5 * 60 * 1000) {
      rejected.push({ targetUserId: id, reason: "checked_at_in_future" });
      continue;
    }
    if (one("SELECT 1 AS ok FROM follow_success WHERE account_id = ? AND target_user_id = ?", accountId, id)) {
      rejected.push({ targetUserId: id, reason: "already_followed" });
      continue;
    }
    const found = one<{ status: string }>(
      "SELECT status FROM follow_reserve WHERE account_id = ? AND target_user_id = ?",
      accountId,
      id,
    );
    const username = typeof raw.username === "string" ? raw.username.slice(0, 64) : null;
    const followers = typeof raw.followersCount === "number" && Number.isFinite(raw.followersCount) ? Math.trunc(raw.followersCount) : null;
    const lastPostAt = realTime(raw.lastPostAt);
    const flb = raw.flb === true ? 1 : 0;
    if (found && NO_RETRY.has(found.status)) {
      existing.push(id);
      continue;
    }
    if (found) {
      refresh.run(username, kind, checked, followers, lastPostAt, flb, now, accountId, id);
      refreshed.push(id);
      continue;
    }
    insert.run(accountId, id, username, kind, checked, followers, lastPostAt, flb, now, now);
    accepted.push(id);
  }
  return { accepted, refreshed, existing, rejected };
}

export function listFollowReserve(accountId: AccountId, input?: { limit?: number; before?: string | null }, now = new Date()) {
  const limit = input?.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AppError("invalid_limit", "名单分页 limit 必须是 1 到 50 的整数。");
  }
  const before = input?.before ?? null;
  const rows = getDb()
    .prepare(
      `SELECT target_user_id, username, kind, status, checked_at, updated_at, result, reason
       FROM follow_reserve
       WHERE account_id = ? AND (? IS NULL OR target_user_id < ?)
       ORDER BY target_user_id DESC
       LIMIT ?`,
    )
    .all(accountId, before, before, limit + 1) as Array<{
    target_user_id: string;
    username: string | null;
    kind: string;
    status: string;
    checked_at: string;
    updated_at: string;
    result: string | null;
    reason: string | null;
  }>;
  const page = rows.slice(0, limit);
  const freshAfter = now.getTime() - RESERVE_FRESH_MS;
  return {
    accountId,
    audience: audienceFor(accountId),
    reserve: reserveView(accountId, now),
    candidates: page.map((row) => ({
      targetUserId: row.target_user_id,
      username: row.username,
      kind: row.kind,
      status: row.status,
      checkedAt: row.checked_at,
      updatedAt: row.updated_at,
      fresh: row.status === "reserved" && Date.parse(row.checked_at) >= freshAfter,
      result: row.result,
      reason: row.reason,
    })),
    nextBefore: rows.length > limit ? (page[page.length - 1]?.target_user_id ?? null) : null,
  };
}

type ReserveRow = {
  target_user_id: string;
  username: string | null;
  kind: string;
  checked_at: string;
  followers_count: number | null;
  last_post_at: string | null;
  prefer_flb: number | null;
};

function selectReserve(accountId: AccountId, now: Date, limit: number): ReserveRow[] {
  const freshAfter = new Date(now.getTime() - RESERVE_FRESH_MS).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT target_user_id, username, kind, checked_at, followers_count, last_post_at, prefer_flb
       FROM follow_reserve
       WHERE account_id = ? AND status = 'reserved' AND checked_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM follow_success s
           WHERE s.account_id = follow_reserve.account_id AND s.target_user_id = follow_reserve.target_user_id
         )`,
    )
    .all(accountId, freshAfter) as ReserveRow[];
  return rows
    .sort((left, right) => reserveRank(left) - reserveRank(right) || left.target_user_id.localeCompare(right.target_user_id))
    .slice(0, limit);
}

/** Lower sorts first. Follow-back stays ahead of new follows. Follower count, flb, and recency only order new follows. */
function reserveRank(row: ReserveRow): number {
  if (row.kind === "followback") return 0;
  let rank = 300;
  if (row.prefer_flb) rank -= 100;
  if (typeof row.followers_count === "number" && row.followers_count <= MAX_FOLLOWERS) rank -= 50;
  if (row.last_post_at && !Number.isNaN(Date.parse(row.last_post_at))) rank -= 10;
  return rank;
}

export function classifyFollow(input: {
  accountId: AccountId;
  kind: FollowKind;
  profile: FollowProfile;
  now: Date;
}): { proceed: boolean; result: FollowOutcome; reason: string } {
  if (input.profile.blue == null) return { proceed: false, result: "unknown", reason: "blue_unconfirmed" };
  if (!input.profile.blue) return { proceed: false, result: "skipped", reason: "not_blue" };
  if (spamText([input.profile.name, input.profile.bio, input.profile.tweetText, input.profile.username])) {
    return { proceed: false, result: "skipped", reason: "spam" };
  }
  if (input.profile.following == null) return { proceed: false, result: "unknown", reason: "following_unconfirmed" };
  if (input.profile.following) return { proceed: false, result: "skipped", reason: "already_following" };
  if (input.kind === "followback") {
    if (input.profile.followsBack == null) return { proceed: false, result: "unknown", reason: "followback_unconfirmed" };
    if (!input.profile.followsBack) return { proceed: false, result: "skipped", reason: "not_follower" };
    return { proceed: true, result: "success", reason: "followback" };
  }
  const audience = audienceMatch(audienceFor(input.accountId), input.profile);
  if (audience === "unknown") return { proceed: false, result: "unknown", reason: "audience_unconfirmed" };
  if (audience === "miss") return { proceed: false, result: "skipped", reason: input.accountId === 1 ? "not_chinese" : "not_english" };
  const hint = preferFlb([input.profile.name, input.profile.bio, input.profile.tweetText]);
  return { proceed: true, result: "success", reason: hint ? "new_flb" : "new" };
}

export type FollowBatchResult = {
  executed: boolean;
  replay: boolean;
  reason: string | null;
  slot: string | null;
  accountId: AccountId;
  submitted: number;
  followed: number;
  remainingQuota: number;
  gap: number;
  constraint: string | null;
  results: Array<{ targetUserId: string; kind: FollowKind; result: FollowOutcome; reason: string }>;
};

function emptyFollow(accountId: AccountId, now: Date, slot: string | null, reason: string): FollowBatchResult {
  const view = reserveView(accountId, now);
  return {
    executed: false,
    replay: false,
    reason,
    slot,
    accountId,
    submitted: 0,
    followed: 0,
    remainingQuota: Math.max(0, FOLLOW_DAILY_CAP - followedToday(accountId, now)),
    gap: view.gap,
    constraint: reason,
    results: [],
  };
}

export async function submitFollowBatch(input: {
  accountId: AccountId;
  now?: Date;
  hooks?: FollowHooks;
}): Promise<FollowBatchResult> {
  const now = input.now ?? new Date();
  const accountId = input.accountId;
  const slot = londonFollowSlot(now);
  if (!followEnabled(accountId)) return emptyFollow(accountId, now, slot, "disabled");
  if (apiMode() !== "live" && !input.hooks) return emptyFollow(accountId, now, slot, "mock_mode");
  if (!slot) return emptyFollow(accountId, now, null, "rest");
  if (getCredentialsRow(accountId)?.user_id !== ACCOUNT_USER_ID[accountId]) {
    return emptyFollow(accountId, now, slot, "identity_unconfirmed");
  }
  const paused = one<{ paused: number }>("SELECT paused FROM follow_control WHERE account_id = ?", accountId);
  if (paused?.paused !== 0) return emptyFollow(accountId, now, slot, "paused");
  const remaining = Math.max(0, FOLLOW_DAILY_CAP - followedToday(accountId, now));
  if (remaining <= 0) return emptyFollow(accountId, now, slot, "daily_cap");
  const sourceUserId = getCredentialsRow(accountId)?.user_id ?? "";
  const hooks = input.hooks ?? {
    inspect: async (targetUserId: string) => evidenceFollowProfile(accountId, targetUserId, now),
    follow: (targetUserId: string) => followTarget(accountId, sourceUserId, targetUserId),
  };

  const view = reserveView(accountId, now);
  if (view.available === 0) {
    return emptyFollow(accountId, now, slot, view.stale > 0 ? "stale_reserve" : "insufficient_candidates");
  }

  const db = getDb();
  const existing = one<{ status: string; submitted: number; followed: number; results_json: string | null }>(
    "SELECT status, submitted, followed, results_json FROM follow_batches WHERE account_id = ? AND slot = ?",
    accountId,
    slot,
  );
  if (existing && existing.status !== "running") {
    const results = parseFollowResults(existing.results_json);
    return {
      executed: true,
      replay: true,
      reason: null,
      slot,
      accountId,
      submitted: existing.submitted,
      followed: existing.followed,
      remainingQuota: remaining,
      gap: view.gap,
      constraint: null,
      results,
    };
  }
  if (one("SELECT slot FROM follow_batches WHERE account_id = ? AND status = 'running'", accountId)) {
    return emptyFollow(accountId, now, slot, "overlap");
  }

  const picked = selectReserve(accountId, now, Math.min(FOLLOW_BATCH_LIMIT, remaining));
  try {
    db.prepare(
      `INSERT INTO follow_batches (account_id, slot, status, submitted, followed, results_json, started_at)
       VALUES (?, ?, 'running', 0, 0, '[]', ?)`,
    ).run(accountId, slot, now.toISOString());
  } catch {
    return emptyFollow(accountId, now, slot, "overlap");
  }

  const results: FollowBatchResult["results"] = [];
  try {
    for (const row of picked) {
      if (one<{ paused: number }>("SELECT paused FROM follow_control WHERE account_id = ?", accountId)?.paused !== 0) break;
      if (followedToday(accountId, now) >= FOLLOW_DAILY_CAP) break;
      const kind: FollowKind = row.kind === "followback" ? "followback" : "new";
      let outcome: { result: FollowOutcome; reason: string };
      try {
        const profile = await hooks.inspect(row.target_user_id);
        const decision = classifyFollow({ accountId, kind, profile, now });
        if (!decision.proceed) outcome = { result: decision.result, reason: decision.reason };
        else {
          await hooks.follow(row.target_user_id);
          const succeeded = new Date().toISOString();
          db.prepare(
            `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(accountId, row.target_user_id, profile.username ?? row.username, kind, succeeded, slot, londonClock(now).day);
          outcome = { result: "success", reason: decision.reason };
        }
      } catch {
        outcome = { result: "failed", reason: "action_failed" };
      }
      const status = outcome.result === "success" ? "followed" : outcome.result;
      db.prepare(
        `UPDATE follow_reserve SET status = ?, result = ?, reason = ?, updated_at = ? WHERE account_id = ? AND target_user_id = ?`,
      ).run(status, outcome.result, outcome.reason, new Date().toISOString(), accountId, row.target_user_id);
      results.push({ targetUserId: row.target_user_id, kind, result: outcome.result, reason: outcome.reason });
    }
  } finally {
    const followed = results.filter((item) => item.result === "success").length;
    db.prepare(
      `UPDATE follow_batches SET status = 'completed', submitted = ?, followed = ?, results_json = ?, finished_at = ? WHERE account_id = ? AND slot = ?`,
    ).run(results.length, followed, JSON.stringify(results), new Date().toISOString(), accountId, slot);
  }
  const followed = results.filter((item) => item.result === "success").length;
  const after = reserveView(accountId, now);
  return {
    executed: true,
    replay: false,
    reason: null,
    slot,
    accountId,
    submitted: results.length,
    followed,
    remainingQuota: Math.max(0, FOLLOW_DAILY_CAP - followedToday(accountId, now)),
    gap: after.gap,
    constraint: after.constraint,
    results,
  };
}

function parseFollowResults(raw: string | null): FollowBatchResult["results"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FollowBatchResult["results"]) : [];
  } catch {
    return [];
  }
}

export function listFollowAudit(accountId: AccountId, input?: { limit?: number; before?: string | null }) {
  const limit = input?.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AppError("invalid_limit", "审计分页 limit 必须是 1 到 50 的整数。");
  }
  const before = input?.before ?? null;
  if (before !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:(00|15|30|45)$/.test(before)) {
    throw new AppError("invalid_cursor", "关注审计 before 必须是伦敦关注工作窗起点。");
  }
  const rows = getDb()
    .prepare(
      `SELECT slot, status, submitted, followed, results_json, started_at, finished_at
       FROM follow_batches
       WHERE account_id = ? AND (? IS NULL OR slot < ?)
       ORDER BY slot DESC LIMIT ?`,
    )
    .all(accountId, before, before, limit + 1) as Array<{
    slot: string;
    status: string;
    submitted: number;
    followed: number;
    results_json: string | null;
    started_at: string;
    finished_at: string | null;
  }>;
  const page = rows.slice(0, limit);
  return {
    accountId,
    limit,
    batches: page.map((row) => ({
      slot: row.slot,
      status: row.status,
      submitted: row.submitted,
      followed: row.followed,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      results: parseFollowResults(row.results_json),
    })),
    nextBefore: rows.length > limit ? (page[page.length - 1]?.slot ?? null) : null,
  };
}
