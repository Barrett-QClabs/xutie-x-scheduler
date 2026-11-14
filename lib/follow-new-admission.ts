import type { AccountId } from "@/lib/account";
import { audienceMatch, preferFlb, spamText } from "@/lib/audience";
import { UNFOLLOW_WHITELIST } from "@/lib/automation-account";
import { ACCOUNT1_FOLLOW_ZONE } from "@/lib/follow-cadence";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { zonedClock } from "@/lib/london";

const SKEW_MS = 5 * 60 * 1000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export type NewAdmissionSnapshot = {
  verified: boolean;
  verifiedType: string;
  following: false;
  lang: "zh";
  name: string | null;
  description: string | null;
  relationshipSemantics: string | null;
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
  approval: { poolDay: string; approvedStart: string; approvedEnd: string; active: boolean } | null;
};

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

function qualify(snapshot: Record<string, unknown>): { ok: true; stored: NewAdmissionSnapshot; followReason: "new" | "new_flb" } | { ok: false; reason: string } {
  const verifiedType = typeof snapshot.verifiedType === "string"
    ? snapshot.verifiedType
    : typeof snapshot.verified_type === "string"
      ? snapshot.verified_type
      : "";
  const blue = snapshot.verified === true && verifiedType.toLowerCase() === "blue";
  if (!blue) return { ok: false, reason: "not_blue" };
  if (snapshot.protected === true) return { ok: false, reason: "protected" };
  if (snapshot.following !== false) return { ok: false, reason: "not_unfollowed" };
  const name = typeof snapshot.name === "string" ? snapshot.name : null;
  const description = typeof snapshot.description === "string" ? snapshot.description : null;
  if (spamText([name, description])) return { ok: false, reason: "spam" };
  const lang = snapshot.lang === "zh" ? "zh" : null;
  if (audienceMatch("zh", { tweetLang: lang, name, bio: description, tweetText: null }) !== "match") {
    return { ok: false, reason: "not_chinese" };
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
    stored: { verified: true, verifiedType, following: false, lang: "zh", name, description, relationshipSemantics: relationship },
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

export function approvalCoversAccount1New(now: Date): { poolDay: string; approvedStart: string; approvedEnd: string } | null {
  const day = zonedClock(now, ACCOUNT1_FOLLOW_ZONE).day;
  const row = getDb().prepare(
    "SELECT pool_day, approved_start, approved_end FROM follow_new_approval WHERE account_id = 1 AND pool_day = ?",
  ).get(day) as { pool_day: string; approved_start: string; approved_end: string } | undefined;
  if (!row) return null;
  const start = Date.parse(row.approved_start);
  const end = Date.parse(row.approved_end);
  if (Number.isNaN(start) || Number.isNaN(end) || now.getTime() < start || now.getTime() >= end) return null;
  return { poolDay: row.pool_day, approvedStart: row.approved_start, approvedEnd: row.approved_end };
}

export function newAdmissionView(accountId: AccountId, now: Date, executableGate: boolean): NewAdmissionView {
  if (accountId !== 1) return { admitted: 0, executable: 0, succeeded: 0, approval: null };
  const admitted = (getDb().prepare(
    "SELECT COUNT(*) AS n FROM follow_new_admission WHERE account_id = 1 AND status = 'admitted'",
  ).get() as { n: number }).n;
  const succeeded = (getDb().prepare(
    "SELECT COUNT(*) AS n FROM follow_new_admission WHERE account_id = 1 AND status = 'followed'",
  ).get() as { n: number }).n;
  const day = zonedClock(now, ACCOUNT1_FOLLOW_ZONE).day;
  const row = getDb().prepare(
    "SELECT pool_day, approved_start, approved_end FROM follow_new_approval WHERE account_id = 1 AND pool_day = ?",
  ).get(day) as { pool_day: string; approved_start: string; approved_end: string } | undefined;
  const active = approvalCoversAccount1New(now);
  return {
    admitted,
    executable: executableGate && active && admitted > 0 ? admitted : 0,
    succeeded,
    approval: row
      ? { poolDay: row.pool_day, approvedStart: row.approved_start, approvedEnd: row.approved_end, active: Boolean(active) }
      : null,
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
    const decision = qualify(snapshot);
    if (!decision.ok) {
      rejected.push({ targetUserId: id, reason: decision.reason });
      continue;
    }
    const prior = getDb().prepare(
      "SELECT status, qualification_checked_at FROM follow_new_admission WHERE account_id = 1 AND target_user_id = ?",
    ).get(id) as { status: string; qualification_checked_at: string } | undefined;
    if (prior) {
      existing.push(id);
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
