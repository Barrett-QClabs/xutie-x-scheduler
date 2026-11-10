import type { AccountId } from "@/lib/account";
import { ACCOUNT_USER_ID, unfollowEnabled, unfollowWhitelist } from "@/lib/automation-account";
import { getCredentialsRow, getDb } from "@/lib/db";
import { apiMode } from "@/lib/deployment";
import { AppError } from "@/lib/errors";
import { evidenceUnfollowProfile } from "@/lib/evidence";
import { londonUnfollowSlot } from "@/lib/london";
import { unfollowTarget } from "@/lib/unfollow-live";
import {
  FOLLOWING_PAGE_SIZE,
  INACTIVE_AFTER_MS,
  SHALLOW_FOLLOWING_DEPTH,
  UNFOLLOW_BATCH_LIMIT,
  UNFOLLOW_EVIDENCE_MAX_MS,
} from "@/lib/unfollow-policy";

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
const NO_RETRY = new Set(["unknown", "failed", "success"]);

export function classifyAction(input: {
  followedAt: string | null;
  followingRank?: number | null;
  fresh: FreshProfile;
  now: Date;
  whitelisted: boolean;
}): { proceed: boolean; result: UnfollowOutcome; reason: string } {
  if (input.whitelisted) return { proceed: false, result: "skipped", reason: "whitelist" };
  if (input.fresh.following == null) return { proceed: false, result: "unknown", reason: "following_unconfirmed" };
  if (!input.fresh.following) return { proceed: false, result: "skipped", reason: "not_following" };

  let nonBlue: "yes" | "no" | "unknown" = "no";
  if (input.fresh.blue == null) nonBlue = "unknown";
  else if (input.fresh.blue === false) nonBlue = "yes";

  let noFollow: "yes" | "no" | "unknown" = "no";
  const followed = Date.parse(input.followedAt ?? "");
  const followKnown = Boolean(input.followedAt) && !Number.isNaN(followed);
  const beyondShallow = typeof input.followingRank === "number" && input.followingRank > SHALLOW_FOLLOWING_DEPTH;
  let deepRelation = false;
  if (beyondShallow && input.fresh.followsBack === false) {
    noFollow = "yes";
    deepRelation = true;
  } else if (beyondShallow && input.fresh.followsBack == null) {
    noFollow = "unknown";
    deepRelation = true;
  } else if (!followKnown) noFollow = "unknown";
  else if (input.now.getTime() - followed >= 72 * HOUR) {
    if (input.fresh.followsBack == null) noFollow = "unknown";
    else if (input.fresh.followsBack === false) noFollow = "yes";
  }

  let inactive: "yes" | "no" | "unknown" = "no";
  if (!input.fresh.lastPostKnown) inactive = "unknown";
  else if (!input.fresh.lastPostAt) inactive = "yes";
  else {
    const posted = Date.parse(input.fresh.lastPostAt);
    if (Number.isNaN(posted)) inactive = "unknown";
    else if (input.now.getTime() - posted > INACTIVE_AFTER_MS) inactive = "yes";
  }

  if (nonBlue === "yes") return { proceed: true, result: "success", reason: "non_blue" };
  if (noFollow === "yes") {
    return { proceed: true, result: "success", reason: deepRelation ? "no_followback_beyond_1000" : "no_followback_72h" };
  }
  if (inactive === "yes") return { proceed: true, result: "success", reason: "inactive_48h" };
  if (nonBlue === "unknown") return { proceed: false, result: "unknown", reason: "blue_unconfirmed" };
  if (noFollow === "unknown") {
    return {
      proceed: false,
      result: "unknown",
      reason: followKnown || deepRelation ? "followback_unconfirmed" : "follow_time_unknown",
    };
  }
  if (inactive === "unknown") return { proceed: false, result: "unknown", reason: "last_post_unconfirmed" };
  return { proceed: false, result: "skipped", reason: "not_qualified" };
}

type CandidateRow = {
  target_user_id: string;
  username: string | null;
  tier: string;
  first_recorded_at: string | null;
  followed_at: string | null;
  following_rank: number | null;
  status: string;
};

export type UnfollowBatchResult = {
  executed: boolean;
  replay: boolean;
  reason: string | null;
  slot: string | null;
  accountId: AccountId;
  submitted: number;
  unfollowed: number;
  results: Array<{ targetUserId: string; tier: UnfollowTier; result: UnfollowOutcome; reason: string }>;
};

function one<T>(sql: string, ...params: unknown[]): T | null {
  const row = getDb().prepare(sql).get(...params);
  return (row as T | undefined) ?? null;
}

function controlPaused(accountId: AccountId): boolean {
  const row = one<{ paused: number }>("SELECT paused FROM unfollow_control WHERE account_id = ?", accountId);
  return row?.paused !== 0;
}

export function setUnfollowPaused(accountId: AccountId, paused: boolean, reason: string): { ok: true; accountId: AccountId; paused: boolean } {
  getDb()
    .prepare(`UPDATE unfollow_control SET paused = ?, pause_reason = ?, updated_at = ? WHERE account_id = ?`)
    .run(paused ? 1 : 0, reason, new Date().toISOString(), accountId);
  return { ok: true, accountId, paused };
}

export function getUnfollowStatus(accountId: AccountId) {
  const control = one<{ paused: number; pause_reason: string | null }>(
    "SELECT paused, pause_reason FROM unfollow_control WHERE account_id = ?",
    accountId,
  );
  const counts = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM unfollow_candidates WHERE account_id = ? GROUP BY status`)
    .all(accountId) as Array<{ status: string; n: number }>;
  const last = one<{
    slot: string;
    status: string;
    submitted: number;
    unfollowed: number;
    started_at: string;
    finished_at: string | null;
  }>(
    "SELECT slot, status, submitted, unfollowed, started_at, finished_at FROM unfollow_batches WHERE account_id = ? ORDER BY started_at DESC LIMIT 1",
    accountId,
  );
  const whitelist = unfollowWhitelist(accountId);
  return {
    accountId,
    enabled: unfollowEnabled(accountId),
    paused: control?.paused !== 0,
    pauseReason: control?.pause_reason ?? null,
    batchSize: UNFOLLOW_BATCH_LIMIT,
    inactiveAfterMs: INACTIVE_AFTER_MS,
    counts: Object.fromEntries(counts.map((row) => [row.status, row.n])),
    lastBatch: last,
    whitelistSize: whitelist.size,
    whitelistMode: accountId === 1 ? "fixed_seven" : "empty_until_configured",
    apiMode: apiMode(),
    identityConfirmed: getCredentialsRow(accountId)?.user_id === ACCOUNT_USER_ID[accountId],
  };
}

export type UnfollowAuditBatch = {
  slot: string;
  status: string;
  submitted: number;
  unfollowed: number;
  startedAt: string;
  finishedAt: string | null;
  results: UnfollowBatchResult["results"];
};

export function listUnfollowAudit(
  accountId: AccountId,
  input?: { limit?: number; before?: string | null },
): { accountId: AccountId; limit: number; batches: UnfollowAuditBatch[]; nextBefore: string | null } {
  const limit = input?.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AppError("invalid_limit", "审计分页 limit 必须是 1 到 50 的整数。");
  }
  const before = input?.before ?? null;
  if (before !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:(15|45)$/.test(before)) {
    throw new AppError("invalid_cursor", "取关审计 before 必须是伦敦 00:15 起的 30 分钟槽。");
  }
  const rows = getDb()
    .prepare(
      `SELECT slot, status, submitted, unfollowed, results_json, started_at, finished_at
       FROM unfollow_batches
       WHERE account_id = ? AND (? IS NULL OR slot < ?)
       ORDER BY slot DESC
       LIMIT ?`,
    )
    .all(accountId, before, before, limit + 1) as Array<{
    slot: string;
    status: string;
    submitted: number;
    unfollowed: number;
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
      unfollowed: row.unfollowed,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      results: parseResults(row.results_json),
    })),
    nextBefore: rows.length > limit ? (page[page.length - 1]?.slot ?? null) : null,
  };
}

function parseResults(raw: string | null): UnfollowBatchResult["results"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as UnfollowBatchResult["results"]) : [];
  } catch {
    return [];
  }
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

function realTime(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

export type UnfollowEvidenceState = "fresh" | "missing" | "expired";

/** Fresh only while now is inside min(expires_at, observed_at + 25h). Longer claims are clamped. */
export function unfollowEvidenceState(accountId: AccountId, targetUserId: string, now = new Date()): UnfollowEvidenceState {
  const rows = getDb()
    .prepare(
      `SELECT observed_at, expires_at FROM evidence_subjects
       WHERE account_id = ? AND source_user_id = ? AND target_user_id = ?`,
    )
    .all(accountId, ACCOUNT_USER_ID[accountId], targetUserId) as Array<{ observed_at: string; expires_at: string }>;
  if (!rows.length) return "missing";
  const fresh = rows.some((row) => {
    const observed = Date.parse(row.observed_at);
    const expires = Date.parse(row.expires_at);
    if (Number.isNaN(observed) || Number.isNaN(expires)) return false;
    return Math.min(expires, observed + UNFOLLOW_EVIDENCE_MAX_MS) > now.getTime();
  });
  return fresh ? "fresh" : "expired";
}

function ledgerFollowedAt(accountId: AccountId, targetUserId: string): string | null {
  const row = one<{ succeeded_at: string }>(
    "SELECT succeeded_at FROM follow_success WHERE account_id = ? AND target_user_id = ?",
    accountId,
    targetUserId,
  );
  return realTime(row?.succeeded_at);
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/** Rank 1 is the shallowest follow. Page 41 of 25 starts at rank 1001. */
function followingRankFrom(raw: { followingRank?: unknown; followingPage?: unknown; pageSize?: unknown; indexOnPage?: unknown }): number | null | "invalid" {
  const pageGiven = raw.followingPage !== undefined && raw.followingPage !== null;
  const rankGiven = raw.followingRank !== undefined && raw.followingRank !== null;
  if (!pageGiven && !rankGiven) return null;
  let fromPage: number | null = null;
  if (pageGiven) {
    const page = wholeNumber(raw.followingPage, 1, 1_000_000);
    const pageSize = raw.pageSize === undefined || raw.pageSize === null ? FOLLOWING_PAGE_SIZE : wholeNumber(raw.pageSize, 1, 100);
    const index = raw.indexOnPage === undefined || raw.indexOnPage === null ? 1 : wholeNumber(raw.indexOnPage, 1, 100);
    if (!page || !pageSize || !index || index > pageSize) return "invalid";
    fromPage = (page - 1) * pageSize + index;
  }
  let declared: number | null = null;
  if (rankGiven) {
    declared = wholeNumber(raw.followingRank, 1, 50_000_000);
    if (!declared) return "invalid";
  }
  if (declared != null && fromPage != null && declared !== fromPage) return "invalid";
  return declared ?? fromPage;
}

export function importUnfollowCandidates(
  accountId: AccountId,
  input: {
    candidates: Array<{
      targetUserId?: unknown;
      username?: unknown;
      tier?: unknown;
      firstRecordedAt?: unknown;
      followedAt?: unknown;
      followingRank?: unknown;
      followingPage?: unknown;
      pageSize?: unknown;
      indexOnPage?: unknown;
    }>;
  },
): { accepted: string[]; reopened: string[]; existing: string[]; rejected: Array<{ targetUserId: string; reason: string }> } {
  const accepted: string[] = [];
  const reopened: string[] = [];
  const existing: string[] = [];
  const rejected: Array<{ targetUserId: string; reason: string }> = [];
  const now = new Date().toISOString();
  const whitelist = unfollowWhitelist(accountId);
  const insert = getDb().prepare(
    `INSERT INTO unfollow_candidates
      (account_id, target_user_id, username, tier, first_recorded_at, followed_at, following_rank, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
  );
  const reopen = getDb().prepare(
    `UPDATE unfollow_candidates
     SET username = ?, tier = ?, first_recorded_at = ?, followed_at = ?, following_rank = ?, status = 'candidate',
         batch_slot = NULL, result = NULL, reason = NULL, updated_at = ?
     WHERE account_id = ? AND target_user_id = ?`,
  );
  for (const raw of input.candidates) {
    const id = typeof raw.targetUserId === "string" ? raw.targetUserId.trim() : "";
    if (!/^\d+$/.test(id)) {
      rejected.push({ targetUserId: id || "?", reason: "invalid_id" });
      continue;
    }
    if (whitelist.has(id)) {
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
    const rank = followingRankFrom(raw);
    if (rank === "invalid") {
      rejected.push({ targetUserId: id, reason: "invalid_following_rank" });
      continue;
    }
    const recorded = realTime(raw.firstRecordedAt);
    const ledger = ledgerFollowedAt(accountId, id);
    let followed: string | null;
    if (raw.followedAt !== undefined && raw.followedAt !== null) {
      const provided = realTime(raw.followedAt);
      if (!provided || provided !== ledger) {
        rejected.push({ targetUserId: id, reason: "followed_at_mismatch" });
        continue;
      }
      followed = provided;
    } else {
      followed = ledger;
    }
    const username = typeof raw.username === "string" ? raw.username.slice(0, 64) : null;
    const found = one<{ status: string }>(
      "SELECT status FROM unfollow_candidates WHERE account_id = ? AND target_user_id = ?",
      accountId,
      id,
    );
    const deep = typeof rank === "number" && rank > SHALLOW_FOLLOWING_DEPTH;
    if (found && NO_RETRY.has(found.status) && !(found.status === "unknown" && deep)) {
      existing.push(id);
      continue;
    }
    if (found) {
      reopen.run(username, tier, recorded, followed, rank, now, accountId, id);
      reopened.push(id);
      continue;
    }
    insert.run(accountId, id, username, tier, recorded, followed, rank, now, now);
    accepted.push(id);
  }
  return { accepted, reopened, existing, rejected };
}

function candidateRows(accountId: AccountId): CandidateRow[] {
  return getDb()
    .prepare(
      `SELECT target_user_id, username, tier, first_recorded_at, followed_at, following_rank, status
       FROM unfollow_candidates WHERE account_id = ? AND status = 'candidate'`,
    )
    .all(accountId) as CandidateRow[];
}

function selectable(accountId: AccountId, row: CandidateRow): boolean {
  return Boolean(normalizeTier(row.tier)) && !unfollowWhitelist(accountId).has(row.target_user_id);
}

function selectBatch(accountId: AccountId, now?: Date, evidenceBacked = false): CandidateRow[] {
  return candidateRows(accountId)
    .filter((row) => selectable(accountId, row))
    .filter((row) => !evidenceBacked || !now || unfollowEvidenceState(accountId, row.target_user_id, now) === "fresh")
    .sort((left, right) => {
      const rank = TIER_RANK[normalizeTier(left.tier) ?? "inactive_48h"] - TIER_RANK[normalizeTier(right.tier) ?? "inactive_48h"];
      return rank || left.target_user_id.localeCompare(right.target_user_id);
    })
    .slice(0, UNFOLLOW_BATCH_LIMIT);
}

function noteStaleEvidence(accountId: AccountId, now: Date) {
  const stamp = now.toISOString();
  const update = getDb().prepare(
    `UPDATE unfollow_candidates SET result = 'skipped', reason = ?, updated_at = ?
     WHERE account_id = ? AND target_user_id = ? AND status = 'candidate'`,
  );
  const clear = getDb().prepare(
    `UPDATE unfollow_candidates SET result = NULL, reason = NULL, updated_at = ?
     WHERE account_id = ? AND target_user_id = ? AND status = 'candidate' AND reason IN ('evidence_missing', 'evidence_expired')`,
  );
  for (const row of candidateRows(accountId)) {
    if (!selectable(accountId, row)) continue;
    const state = unfollowEvidenceState(accountId, row.target_user_id, now);
    if (state === "fresh") clear.run(stamp, accountId, row.target_user_id);
    else update.run(state === "expired" ? "evidence_expired" : "evidence_missing", stamp, accountId, row.target_user_id);
  }
}

export function executableUnfollowCount(accountId: AccountId, now = new Date()): number {
  return candidateRows(accountId).filter(
    (row) => selectable(accountId, row) && unfollowEvidenceState(accountId, row.target_user_id, now) === "fresh",
  ).length;
}

export function listUnfollowCandidates(
  accountId: AccountId,
  input?: { limit?: number; before?: string | null },
  now = new Date(),
) {
  const limit = input?.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AppError("invalid_limit", "取关候选分页 limit 必须是 1 到 50 的整数。");
  }
  const before = input?.before ?? null;
  if (before !== null && !/^\d+$/.test(before)) {
    throw new AppError("invalid_cursor", "取关候选 before 必须是数字 id。");
  }
  const rows = getDb()
    .prepare(
      `SELECT target_user_id, username, tier, first_recorded_at, followed_at, following_rank, status, result, reason
       FROM unfollow_candidates
       WHERE account_id = ? AND status = 'candidate' AND (? IS NULL OR target_user_id < ?)
       ORDER BY target_user_id DESC
       LIMIT ?`,
    )
    .all(accountId, before, before, limit + 1) as Array<{
    target_user_id: string;
    username: string | null;
    tier: string;
    first_recorded_at: string | null;
    followed_at: string | null;
    following_rank: number | null;
    status: string;
    result: string | null;
    reason: string | null;
  }>;
  const page = rows.slice(0, limit);
  return {
    accountId,
    limit,
    executable: executableUnfollowCount(accountId, now),
    candidates: page.map((row) => ({
      targetUserId: row.target_user_id,
      username: row.username,
      tier: normalizeTier(row.tier) ?? row.tier,
      status: row.status,
      followedAt: row.followed_at,
      followingRank: row.following_rank,
      firstRecordedAt: row.first_recorded_at,
      result: row.result,
      reason: row.reason,
      evidence: unfollowEvidenceState(accountId, row.target_user_id, now),
    })),
    nextBefore: rows.length > limit ? (page[page.length - 1]?.target_user_id ?? null) : null,
  };
}

function emptyResult(accountId: AccountId, slot: string | null, reason: string): UnfollowBatchResult {
  return { executed: false, replay: false, reason, slot, accountId, submitted: 0, unfollowed: 0, results: [] };
}

export async function submitUnfollowBatch(input: {
  accountId: AccountId;
  now?: Date;
  hooks?: UnfollowHooks;
}): Promise<UnfollowBatchResult> {
  const now = input.now ?? new Date();
  const accountId = input.accountId;
  const slot = londonUnfollowSlot(now);
  if (!unfollowEnabled(accountId)) return emptyResult(accountId, slot, "disabled");
  if (apiMode() !== "live" && !input.hooks) return emptyResult(accountId, slot, "mock_mode");
  if (!slot) return emptyResult(accountId, null, "outside_window");
  if (getCredentialsRow(accountId)?.user_id !== ACCOUNT_USER_ID[accountId]) {
    return emptyResult(accountId, slot, "identity_unconfirmed");
  }
  if (controlPaused(accountId)) return emptyResult(accountId, slot, "paused");
  const sourceUserId = getCredentialsRow(accountId)?.user_id ?? "";
  const hooks = input.hooks ?? {
    inspect: async (targetUserId: string) => evidenceUnfollowProfile(accountId, targetUserId, now),
    unfollow: (targetUserId: string) => unfollowTarget(accountId, sourceUserId, targetUserId),
  };

  const db = getDb();
  const existing = one<{ status: string; submitted: number; unfollowed: number; results_json: string | null }>(
    "SELECT status, submitted, unfollowed, results_json FROM unfollow_batches WHERE account_id = ? AND slot = ?",
    accountId,
    slot,
  );
  if (existing && existing.status !== "running") {
    return {
      executed: true,
      replay: true,
      reason: null,
      slot,
      accountId,
      submitted: existing.submitted,
      unfollowed: existing.unfollowed,
      results: parseResults(existing.results_json),
    };
  }
  const running = one<{ slot: string }>("SELECT slot FROM unfollow_batches WHERE account_id = ? AND status = 'running'", accountId);
  if (running) return emptyResult(accountId, slot, "overlap");

  const evidenceBacked = !input.hooks;
  if (evidenceBacked) noteStaleEvidence(accountId, now);
  const picked = selectBatch(accountId, now, evidenceBacked);
  try {
    db.prepare(
      `INSERT INTO unfollow_batches (account_id, slot, status, submitted, unfollowed, results_json, started_at)
       VALUES (?, ?, 'running', 0, 0, '[]', ?)`,
    ).run(accountId, slot, now.toISOString());
  } catch {
    return emptyResult(accountId, slot, "overlap");
  }

  const results: UnfollowBatchResult["results"] = [];
  try {
    for (const row of picked) {
      if (controlPaused(accountId)) break;
      db.prepare(
        `UPDATE unfollow_candidates SET status = 'submitted', batch_slot = ?, updated_at = ? WHERE account_id = ? AND target_user_id = ?`,
      ).run(slot, new Date().toISOString(), accountId, row.target_user_id);
      let outcome: { result: UnfollowOutcome; reason: string };
      try {
        const fresh = await hooks.inspect(row.target_user_id);
        const decision = classifyAction({
          followedAt: row.followed_at,
          followingRank: row.following_rank,
          fresh,
          now,
          whitelisted: unfollowWhitelist(accountId).has(row.target_user_id),
        });
        if (!decision.proceed) outcome = { result: decision.result, reason: decision.reason };
        else {
          await hooks.unfollow(row.target_user_id);
          outcome = { result: "success", reason: decision.reason };
        }
      } catch {
        outcome = { result: "failed", reason: "action_failed" };
      }
      db.prepare(
        `UPDATE unfollow_candidates SET status = ?, result = ?, reason = ?, updated_at = ? WHERE account_id = ? AND target_user_id = ?`,
      ).run(outcome.result, outcome.result, outcome.reason, new Date().toISOString(), accountId, row.target_user_id);
      results.push({
        targetUserId: row.target_user_id,
        tier: normalizeTier(row.tier) ?? "inactive_48h",
        result: outcome.result,
        reason: outcome.reason,
      });
    }
  } finally {
    const unfollowed = results.filter((item) => item.result === "success").length;
    db.prepare(
      `UPDATE unfollow_batches SET status = 'completed', submitted = ?, unfollowed = ?, results_json = ?, finished_at = ? WHERE account_id = ? AND slot = ?`,
    ).run(results.length, unfollowed, JSON.stringify(results), new Date().toISOString(), accountId, slot);
  }
  return {
    executed: true,
    replay: false,
    reason: null,
    slot,
    accountId,
    submitted: results.length,
    unfollowed: results.filter((item) => item.result === "success").length,
    results,
  };
}
