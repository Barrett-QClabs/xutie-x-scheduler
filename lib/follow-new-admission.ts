import type { AccountId } from "@/lib/account";
import { audienceMatch, preferFlb, spamText } from "@/lib/audience";
import { UNFOLLOW_WHITELIST } from "@/lib/automation-account";
import { dailyPoolOn } from "@/lib/account-ops";
import { followFilters, quotaDay } from "@/lib/automation-settings";
import { followBlocked } from "@/lib/follow-blocklist";
import { ACCOUNT1_FOLLOW_ZONE, account1PoolInUse } from "@/lib/follow-cadence";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { zonedClock } from "@/lib/london";
import { RECENT_ACTIVITY_MS } from "@/lib/unfollow-policy";

const SKEW_MS = 5 * 60 * 1000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export type NewAdmissionSnapshot = {
  verified: boolean;
  verifiedType: string;
  following: false;
  lang: string | null;
  name: string | null;
  description: string | null;
  relationshipSemantics: string | null;
  lastPostAt: string | null;
};

export type NewAdmissionRow = {
  targetUserId: string;
  username: string | null;
  sequence: number;
  admittedAt: string;
  qualificationCheckedAt: string;
  followReason: "new" | "new_flb";
  status: string;
};

export type NewAdmissionView = {
  admitted: number;
  executable: number;
  succeeded: number;
  /** Legacy same-day approval row for the current Taipei day, if any. */
  approval: { poolDay: string; approvedStart: string; approvedEnd: string; active: boolean } | null;
  /** What currently authorizes kind=new for account 1, or null when nothing does. */
  approvalSource: "persistent" | "daily" | null;
  /** Persistent run authorization (account 1 only). */
  authorization: RunAuthorizationView | null;
};

export type RunAuthorizationStatus = "active" | "paused" | "revoked";

export type RunAuthorizationView = {
  accountId: 1;
  persistent: true;
  status: RunAuthorizationStatus | "none";
  authorizedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  updatedAt: string | null;
  /** True when this record authorizes kind=new at the time it was read. */
  active: boolean;
};

export type Account1NewApproval =
  | { source: "persistent"; poolDay: string; approvedStart: string; approvedEnd: string | null }
  | { source: "daily"; poolDay: string; approvedStart: string; approvedEnd: string };

type StoredAdmission = {
  target_user_id: string;
  username: string | null;
  sequence: number;
  admitted_at: string;
  qualification_checked_at: string;
  follow_reason: string;
  status: string;
};

function taipeiMidnight(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date, 0, 0, 0) - TAIPEI_OFFSET_MS);
}

function nextTaipeiDay(day: string): string {
  const midnight = taipeiMidnight(day).getTime() + 24 * 60 * 60 * 1000;
  return zonedClock(new Date(midnight), ACCOUNT1_FOLLOW_ZONE).day;
}

/** Same instant, or null when the value is missing, unparseable, or more than five minutes ahead. */
export function frozenInstant(value: unknown, now: Date): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  const time = Date.parse(value);
  if (time > now.getTime() + SKEW_MS) return null;
  return new Date(time).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Screens one snapshot with account 1's saved filter toggles (defaults: Blue Verified and Chinese on, activity off). */
function qualify(snapshot: Record<string, unknown>, checkedAt: string): { ok: true; stored: NewAdmissionSnapshot; followReason: "new" | "new_flb" } | { ok: false; reason: string } {
  const filters = followFilters(1);
  const verifiedType = typeof snapshot.verifiedType === "string"
    ? snapshot.verifiedType
    : typeof snapshot.verified_type === "string"
      ? snapshot.verified_type
      : "";
  const blue = snapshot.verified === true && verifiedType.toLowerCase() === "blue";
  if (filters.blueVerified && !blue) return { ok: false, reason: "not_blue" };
  if (snapshot.protected === true) return { ok: false, reason: "protected" };
  if (snapshot.following !== false) return { ok: false, reason: "not_unfollowed" };
  const name = typeof snapshot.name === "string" ? snapshot.name : null;
  const description = typeof snapshot.description === "string" ? snapshot.description : null;
  if (spamText([name, description])) return { ok: false, reason: "spam" };
  const lang = snapshot.lang === "zh" ? "zh" : null;
  if (filters.language && audienceMatch("zh", { tweetLang: lang, name, bio: description, tweetText: null }) !== "match") {
    return { ok: false, reason: "not_chinese" };
  }
  const lastPostAt = parsedInstant(snapshot.lastPostAt ?? snapshot.last_post_at)?.toISOString() ?? null;
  if (filters.activity) {
    if (!lastPostAt) return { ok: false, reason: "activity_unconfirmed" };
    if (Date.parse(checkedAt) - Date.parse(lastPostAt) > RECENT_ACTIVITY_MS) return { ok: false, reason: "inactive" };
  }
  const relationship = typeof snapshot.relationshipSemantics === "string"
    ? snapshot.relationshipSemantics
    : typeof snapshot.relationship_semantics === "string"
      ? snapshot.relationship_semantics
      : null;
  const followReason = preferFlb([name, description]) ? "new_flb" : "new";
  return {
    ok: true,
    followReason,
    stored: {
      verified: blue,
      verifiedType,
      following: false,
      lang: typeof snapshot.lang === "string" ? snapshot.lang : null,
      name,
      description,
      relationshipSemantics: relationship,
      lastPostAt,
    },
  };
}

function parsedInstant(value: unknown): Date | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(Date.parse(value));
}

export function approveAccount1NewFollow(input: { approvedStart: unknown; approvedEnd: unknown }, now = new Date()) {
  const startDate = parsedInstant(input.approvedStart);
  const endDate = parsedInstant(input.approvedEnd);
  if (!startDate || !endDate) throw new AppError("invalid_approval", "授权起止时间必须是可解析的时间。");
  if (endDate.getTime() <= startDate.getTime()) throw new AppError("invalid_approval", "授权结束必须晚于开始。");
  const startDay = zonedClock(startDate, ACCOUNT1_FOLLOW_ZONE).day;
  const midnight = taipeiMidnight(startDay);
  const nextMidnight = taipeiMidnight(nextTaipeiDay(startDay));
  if (startDate.getTime() < midnight.getTime() || endDate.getTime() > nextMidnight.getTime()) {
    throw new AppError("invalid_approval", "授权必须落在同一个台北日内，并且不晚于当天 24:00。");
  }
  const start = startDate.toISOString();
  const end = endDate.toISOString();
  const createdAt = now.toISOString();
  getDb().prepare(
    `INSERT INTO follow_new_approval (account_id, pool_day, approved_start, approved_end, created_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(account_id, pool_day) DO UPDATE SET
       approved_start = excluded.approved_start,
       approved_end = excluded.approved_end,
       created_at = excluded.created_at`,
  ).run(startDay, start, end, createdAt);
  return { ok: true as const, accountId: 1 as const, poolDay: startDay, approvedStart: start, approvedEnd: end };
}

type StoredAuthorization = {
  status: string;
  authorized_at: string | null;
  expires_at: string | null;
  note: string | null;
  updated_at: string;
};

function storedAuthorization(): StoredAuthorization | null {
  const row = getDb().prepare(
    "SELECT status, authorized_at, expires_at, note, updated_at FROM follow_run_authorization WHERE account_id = 1",
  ).get() as StoredAuthorization | undefined;
  return row ?? null;
}

/** Active, and before its expiry when one was set. The calendar date alone never ends it. */
function authorizationCovers(record: StoredAuthorization | null, now: Date): boolean {
  if (!record || record.status !== "active") return false;
  if (record.expires_at === null) return true;
  const end = Date.parse(record.expires_at);
  return !Number.isNaN(end) && now.getTime() < end;
}

function authorizationView(record: StoredAuthorization | null, now: Date): RunAuthorizationView {
  const raw = record?.status;
  const status: RunAuthorizationView["status"] = raw === "active" || raw === "paused" || raw === "revoked" ? raw : "none";
  return {
    accountId: 1,
    persistent: true,
    status,
    authorizedAt: record?.authorized_at ?? null,
    expiresAt: record?.expires_at ?? null,
    note: record?.note ?? null,
    updatedAt: record?.updated_at ?? null,
    active: authorizationCovers(record, now),
  };
}

export function account1RunAuthorization(now = new Date()): RunAuthorizationView {
  return authorizationView(storedAuthorization(), now);
}

function writeAuthorization(fields: {
  status: RunAuthorizationStatus;
  authorizedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  updatedAt: string;
}): void {
  getDb().prepare(
    `INSERT INTO follow_run_authorization (account_id, status, authorized_at, expires_at, note, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       status = excluded.status,
       authorized_at = excluded.authorized_at,
       expires_at = excluded.expires_at,
       note = excluded.note,
       updated_at = excluded.updated_at`,
  ).run(fields.status, fields.authorizedAt, fields.expiresAt, fields.note, fields.updatedAt);
}

function authorizationNote(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length > 200) {
    throw new AppError("invalid_authorization", "note 必须是不超过 200 个字符的字符串。");
  }
  return value.trim() || null;
}

/**
 * Persistent account 1 run authorization for kind=new. It keeps covering across Taipei midnights
 * until it is paused, revoked, or reaches the optional `expiresAt`. Daily caps still reset at the
 * saved quota-zone midnight. Legacy one-day approvals keep working as before.
 */
export function authorizeAccount1Run(input: { expiresAt?: unknown; note?: unknown } = {}, now = new Date()): RunAuthorizationView {
  let expiresAt: string | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const end = parsedInstant(input.expiresAt);
    if (!end) throw new AppError("invalid_authorization", "expiresAt 必须是可解析的时间，或省略表示不设到期。");
    if (end.getTime() <= now.getTime()) throw new AppError("invalid_authorization", "expiresAt 必须晚于现在。");
    expiresAt = end.toISOString();
  }
  const prior = storedAuthorization();
  const stamp = now.toISOString();
  writeAuthorization({
    status: "active",
    authorizedAt: stamp,
    expiresAt,
    note: authorizationNote(input.note, prior?.note ?? null),
    updatedAt: stamp,
  });
  return account1RunAuthorization(now);
}

/** Stops the persistent authorization without forgetting its grant or expiry. */
export function pauseAccount1Run(now = new Date()): RunAuthorizationView {
  const prior = storedAuthorization();
  if (!prior || prior.status === "revoked") {
    throw new AppError("authorization_missing", "账号1没有可暂停的持续授权。", 409);
  }
  writeAuthorization({
    status: "paused",
    authorizedAt: prior.authorized_at,
    expiresAt: prior.expires_at,
    note: prior.note,
    updatedAt: now.toISOString(),
  });
  return account1RunAuthorization(now);
}

/** Resumes a paused authorization with its original expiry. A revoked one must be authorized again. */
export function resumeAccount1Run(now = new Date()): RunAuthorizationView {
  const prior = storedAuthorization();
  if (!prior || prior.status !== "paused") {
    throw new AppError("authorization_missing", "账号1没有已暂停的持续授权。被撤销的授权需要重新授权。", 409);
  }
  writeAuthorization({
    status: "active",
    authorizedAt: prior.authorized_at,
    expiresAt: prior.expires_at,
    note: prior.note,
    updatedAt: now.toISOString(),
  });
  return account1RunAuthorization(now);
}

/**
 * Revokes persistent authorization. The record stays as an audit of the decision, and a same-day
 * legacy approval written before it no longer authorizes kind=new.
 */
export function revokeAccount1Run(now = new Date()): RunAuthorizationView {
  const prior = storedAuthorization();
  writeAuthorization({
    status: "revoked",
    authorizedAt: prior?.authorized_at ?? null,
    expiresAt: prior?.expires_at ?? null,
    note: prior?.note ?? null,
    updatedAt: now.toISOString(),
  });
  return account1RunAuthorization(now);
}

type DailyApproval = { pool_day: string; approved_start: string; approved_end: string; created_at: string };

function dailyApprovalRow(now: Date): DailyApproval | null {
  const day = zonedClock(now, ACCOUNT1_FOLLOW_ZONE).day;
  const row = getDb().prepare(
    "SELECT pool_day, approved_start, approved_end, created_at FROM follow_new_approval WHERE account_id = 1 AND pool_day = ?",
  ).get(day) as DailyApproval | undefined;
  return row ?? null;
}

function dailyApprovalCovers(row: DailyApproval | null, now: Date): boolean {
  if (!row) return false;
  const start = Date.parse(row.approved_start);
  const end = Date.parse(row.approved_end);
  return !Number.isNaN(start) && !Number.isNaN(end) && now.getTime() >= start && now.getTime() < end;
}

/**
 * Persistent authorization first. Otherwise a legacy same-day approval still counts, unless the
 * operator paused or revoked persistent authorization after that approval was written.
 */
export function approvalCoversAccount1New(now: Date): Account1NewApproval | null {
  const record = storedAuthorization();
  if (authorizationCovers(record, now) && record) {
    return {
      source: "persistent",
      poolDay: quotaDay(1, now),
      approvedStart: record.authorized_at ?? record.updated_at,
      approvedEnd: record.expires_at,
    };
  }
  const row = dailyApprovalRow(now);
  if (!row || !dailyApprovalCovers(row, now)) return null;
  if (record && record.status !== "active" && record.updated_at >= row.created_at) return null;
  return { source: "daily", poolDay: row.pool_day, approvedStart: row.approved_start, approvedEnd: row.approved_end };
}

export function newAdmissionView(accountId: AccountId, now: Date, executableGate: boolean): NewAdmissionView {
  if (accountId !== 1) {
    return { admitted: 0, executable: 0, succeeded: 0, approval: null, approvalSource: null, authorization: null };
  }
  const admittedRows = getDb().prepare(
    "SELECT qualification_checked_at FROM follow_new_admission WHERE account_id = 1 AND status = 'admitted'",
  ).all() as Array<{ qualification_checked_at: string }>;
  const admitted = admittedRows.length;
  const live = admittedRows.filter((row) => account1PoolInUse("new", row.qualification_checked_at, now)).length;
  const succeeded = (getDb().prepare(
    "SELECT COUNT(*) AS n FROM follow_new_admission WHERE account_id = 1 AND status = 'followed'",
  ).get() as { n: number }).n;
  const row = dailyApprovalRow(now);
  const active = approvalCoversAccount1New(now);
  return {
    admitted,
    executable: executableGate && active && live > 0 ? live : 0,
    succeeded,
    approval: row
      ? { poolDay: row.pool_day, approvedStart: row.approved_start, approvedEnd: row.approved_end, active: Boolean(active) }
      : null,
    approvalSource: active?.source ?? null,
    authorization: account1RunAuthorization(now),
  };
}

export function listNewAdmissions(limit = 200): NewAdmissionRow[] {
  const rows = getDb().prepare(
    `SELECT target_user_id, username, sequence, admitted_at, qualification_checked_at, follow_reason, status
     FROM follow_new_admission WHERE account_id = 1
     ORDER BY sequence ASC, target_user_id ASC LIMIT ?`,
  ).all(limit) as StoredAdmission[];
  return rows.map(toPublic);
}

export function pendingNewAdmissions(limit: number): NewAdmissionRow[] {
  const rows = getDb().prepare(
    `SELECT target_user_id, username, sequence, admitted_at, qualification_checked_at, follow_reason, status
     FROM follow_new_admission
     WHERE account_id = 1 AND status = 'admitted'
       AND NOT EXISTS (
         SELECT 1 FROM follow_success s
         WHERE s.account_id = 1 AND s.target_user_id = follow_new_admission.target_user_id
       )
     ORDER BY sequence ASC, target_user_id ASC
     LIMIT ?`,
  ).all(limit) as StoredAdmission[];
  return rows.map(toPublic);
}

function toPublic(row: StoredAdmission): NewAdmissionRow {
  return {
    targetUserId: row.target_user_id,
    username: row.username,
    sequence: row.sequence,
    admittedAt: row.admitted_at,
    qualificationCheckedAt: row.qualification_checked_at,
    followReason: row.follow_reason === "new_flb" ? "new_flb" : "new",
    status: row.status,
  };
}

export function admitAccount1NewFollows(
  candidates: unknown,
  now = new Date(),
): {
  accepted: Array<{ targetUserId: string; qualificationCheckedAt: string; sequence: number }>;
  existing: string[];
  rejected: Array<{ targetUserId: string; reason: string }>;
} {
  if (!Array.isArray(candidates)) throw new AppError("invalid_json", "候选必须是数组。");
  const accepted: Array<{ targetUserId: string; qualificationCheckedAt: string; sequence: number }> = [];
  const existing: string[] = [];
  const rejected: Array<{ targetUserId: string; reason: string }> = [];
  const seen = new Set<string>();
  const stamp = now.toISOString();
  const insert = getDb().prepare(
    `INSERT INTO follow_new_admission
      (account_id, target_user_id, username, sequence, admitted_at, qualification_checked_at, snapshot_json, follow_reason, status, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`,
  );
  for (const raw of candidates) {
    const record = asRecord(raw);
    const id = typeof record?.targetUserId === "string" ? record.targetUserId.trim() : "";
    if (!/^\d+$/.test(id)) {
      rejected.push({ targetUserId: id || "?", reason: "invalid_id" });
      continue;
    }
    if (seen.has(id)) {
      rejected.push({ targetUserId: id, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(id);
    if (UNFOLLOW_WHITELIST.has(id)) {
      rejected.push({ targetUserId: id, reason: "whitelist" });
      continue;
    }
    if (followBlocked(1, id)) {
      rejected.push({ targetUserId: id, reason: "unfollowed" });
      continue;
    }
    const checked = frozenInstant(record?.qualificationCheckedAt, now);
    if (!checked) {
      rejected.push({ targetUserId: id, reason: "qualification_checked_at_required" });
      continue;
    }
    const admittedAt = record?.admittedAt === undefined ? checked : frozenInstant(record.admittedAt, now);
    if (!admittedAt) {
      rejected.push({ targetUserId: id, reason: "admitted_at_invalid" });
      continue;
    }
    const snapshot = asRecord(record?.snapshot);
    if (!snapshot) {
      rejected.push({ targetUserId: id, reason: "snapshot_required" });
      continue;
    }
    const decision = qualify(snapshot, checked);
    if (!decision.ok) {
      rejected.push({ targetUserId: id, reason: decision.reason });
      continue;
    }
    const prior = getDb().prepare(
      "SELECT status, qualification_checked_at, sequence FROM follow_new_admission WHERE account_id = 1 AND target_user_id = ?",
    ).get(id) as { status: string; qualification_checked_at: string; sequence: number } | undefined;
    if (prior) {
      const replaceExpired = prior.status === "admitted" && dailyPoolOn(1) && !account1PoolInUse("new", prior.qualification_checked_at, now);
      if (!replaceExpired) {
        existing.push(id);
        continue;
      }
      const username = typeof record?.username === "string" ? record.username.slice(0, 64) : null;
      getDb().prepare(
        `UPDATE follow_new_admission
         SET username = ?, admitted_at = ?, qualification_checked_at = ?, snapshot_json = ?, follow_reason = ?, updated_at = ?
         WHERE account_id = 1 AND target_user_id = ? AND status = 'admitted'`,
      ).run(username, admittedAt, checked, JSON.stringify(decision.stored), decision.followReason, stamp, id);
      accepted.push({ targetUserId: id, qualificationCheckedAt: checked, sequence: prior.sequence });
      continue;
    }
    const followed = getDb().prepare(
      "SELECT 1 AS ok FROM follow_success WHERE account_id = 1 AND target_user_id = ?",
    ).get(id);
    if (followed) {
      rejected.push({ targetUserId: id, reason: "already_followed" });
      continue;
    }
    const sequence = ((getDb().prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS n FROM follow_new_admission WHERE account_id = 1",
    ).get() as { n: number }).n) + 1;
    const username = typeof record?.username === "string" ? record.username.slice(0, 64) : null;
    insert.run(id, username, sequence, admittedAt, checked, JSON.stringify(decision.stored), decision.followReason, stamp, stamp);
    accepted.push({ targetUserId: id, qualificationCheckedAt: checked, sequence });
  }
  return { accepted, existing, rejected };
}

export function markNewAdmission(targetUserId: string, status: "followed" | "failed", reason: string, slot: string | null, now: Date) {
  getDb().prepare(
    `UPDATE follow_new_admission
     SET status = ?, result = ?, reason = ?, slot = ?, updated_at = ?
     WHERE account_id = 1 AND target_user_id = ? AND status = 'admitted'`,
  ).run(status, status === "followed" ? "success" : "failed", reason, slot, now.toISOString(), targetUserId);
}
