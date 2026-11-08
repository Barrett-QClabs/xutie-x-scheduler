import type { AccountId } from "@/lib/account";
import { ACCOUNT_USER_ID } from "@/lib/automation-account";
import { getCredentialsRow, getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { FollowProfile } from "@/lib/follow-queue";
import type { FreshProfile } from "@/lib/unfollow-queue";

export const EVIDENCE_SCHEMA_VERSION = 1;
const ALLOWED_NAMESPACES = new Set(["user-X", "x-public"]);
const ALLOWED_TOOLS = new Set([
  "get_users_me",
  "get_users_me_followers",
  "get_users_me_following",
  "get_users_posts",
  "get_user",
]);

export type EvidenceSubjectView = {
  targetUserId: string;
  observedAt: string;
  expiresAt: string;
  sourceTool: string;
  fresh: boolean;
  blue: boolean | null;
  following: boolean | null;
  followsBack: boolean | null;
  connectionExplicit: boolean;
  paginationComplete: boolean;
  activityWindowComplete: boolean;
  lastPostAt: string | null;
  tweetLang: string | null;
  followersCount: number | null;
  name: string | null;
  bio: string | null;
  username: string | null;
  tweetText: string | null;
};

type SubjectRow = {
  target_user_id: string;
  observed_at: string;
  expires_at: string;
  source_tool: string;
  pagination_complete: number;
  activity_window_complete: number;
  verified: number | null;
  verified_type: string | null;
  connection_explicit: number;
  connection_status_json: string | null;
  followers_count: number | null;
  last_post_at: string | null;
  tweet_lang: string | null;
  name: string | null;
  bio: string | null;
  username: string | null;
  tweet_text: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function blueFrom(verified: unknown, verifiedType: unknown): { known: boolean; blue: boolean | null; verifiedFlag: number | null; verifiedType: string | null } {
  const type = typeof verifiedType === "string" ? verifiedType : null;
  const flag = typeof verified === "boolean" ? verified : null;
  if (flag === null || type === null) return { known: false, blue: null, verifiedFlag: flag === null ? null : flag ? 1 : 0, verifiedType: type };
  const blue = flag === true && type.toLowerCase() === "blue";
  return { known: true, blue, verifiedFlag: flag ? 1 : 0, verifiedType: type };
}

function newestPost(posts: unknown): { at: string | null; lang: string | null; text: string | null } {
  if (!Array.isArray(posts)) return { at: null, lang: null, text: null };
  let at: string | null = null;
  let lang: string | null = null;
  let body: string | null = null;
  for (const item of posts) {
    const record = asRecord(item);
    const created = text(record?.created_at);
    if (!created) continue;
    if (!at || created > at) {
      at = created;
      lang = text(record?.lang);
      body = text(record?.text);
    }
  }
  return { at, lang, text: body };
}

export function importEvidence(slot: AccountId, envelope: Record<string, unknown>, now = new Date()) {
  if (envelope.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    throw new AppError("invalid_evidence", "证据 schema_version 必须是 1。");
  }
  const namespace = text(envelope.source_namespace);
  const tool = text(envelope.source_tool);
  if (!namespace || !ALLOWED_NAMESPACES.has(namespace) || !tool || !ALLOWED_TOOLS.has(tool)) {
    throw new AppError("invalid_evidence", "证据来源必须是 user-X 或 x-public 的已列出工具。");
  }
  const sourceUserId = text(envelope.account_id);
  if (sourceUserId !== ACCOUNT_USER_ID[slot]) {
    throw new AppError("evidence_account_mismatch", "证据里的账号 id 不属于这个槽。", 403);
  }
  const observedAt = text(envelope.observed_at);
  const expiresAt = text(envelope.expires_at);
  if (!observedAt || Number.isNaN(Date.parse(observedAt)) || !expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    throw new AppError("invalid_evidence", "observed_at 和 expires_at 都必须是可解析的时间。");
  }
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new AppError("invalid_evidence", "expires_at 必须晚于 observed_at。");
  }
  if (!Array.isArray(envelope.request_fields) || !envelope.request_fields.every((item) => typeof item === "string")) {
    throw new AppError("invalid_evidence", "request_fields 必须是字符串数组。");
  }
  const coverage = asRecord(envelope.coverage);
  if (!coverage || typeof coverage.pagination_complete !== "boolean") {
    throw new AppError("invalid_evidence", "coverage.pagination_complete 必须是布尔值。");
  }
  if (!Array.isArray(envelope.errors) || !Array.isArray(envelope.subjects)) {
    throw new AppError("invalid_evidence", "errors 和 subjects 必须是数组。");
  }
  const activityWindowComplete = coverage.activity_window_complete === true && coverage.pagination_complete === true && envelope.errors.length === 0 && (!Array.isArray(coverage.excluded) || coverage.excluded.length === 0);
  const paginationComplete = coverage.pagination_complete === true;
  const nextToken = text(coverage.next_token);
  const db = getDb();
  const insertPage = db.prepare(
    `INSERT OR REPLACE INTO evidence_pages
      (account_id, source_user_id, source_namespace, source_tool, observed_at, expires_at, pagination_complete, next_token, activity_window_complete, subject_count, errors_json, request_fields)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSubject = db.prepare(
    `INSERT OR REPLACE INTO evidence_subjects
      (account_id, source_user_id, target_user_id, observed_at, expires_at, source_namespace, source_tool, pagination_complete, next_token, activity_window_complete, errors_json, verified, verified_type, connection_status_json, connection_explicit, followers_count, last_post_at, tweet_lang, name, bio, username, tweet_text, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stored = getCredentialsRow(slot);
  let identityUpdated = false;
  const accepted: string[] = [];
  for (const item of envelope.subjects) {
    const subject = asRecord(item);
    const id = text(subject?.id);
    if (!subject || !id || !/^\d+$/.test(id)) continue;
    const connectionExplicit = Array.isArray(subject.connection_status);
    const blue = blueFrom(subject.verified, subject.verified_type);
    const metrics = asRecord(subject.public_metrics);
    const followers = metrics && typeof metrics.followers_count === "number" ? Math.trunc(metrics.followers_count) : null;
    const posts = newestPost(subject.posts);
    const lang = text(subject.lang) ?? posts.lang;
    insertSubject.run(
      slot,
      sourceUserId,
      id,
      observedAt,
      expiresAt,
      namespace,
      tool,
      paginationComplete ? 1 : 0,
      nextToken,
      activityWindowComplete ? 1 : 0,
      JSON.stringify(envelope.errors),
      blue.verifiedFlag,
      blue.verifiedType,
      connectionExplicit ? JSON.stringify(subject.connection_status) : null,
      connectionExplicit ? 1 : 0,
      followers,
      posts.at,
      lang,
      text(subject.name),
      text(subject.description),
      text(subject.username),
      posts.text ?? text(subject.text),
      JSON.stringify(subject),
    );
    accepted.push(id);
    if (tool === "get_users_me" && id === sourceUserId && text(subject.username) && (!stored || stored.user_id === sourceUserId || !stored.user_id)) {
      db.prepare(
        `UPDATE credentials SET username = ?, display_name = ?, user_id = ?, updated_at = ? WHERE id = ? AND (user_id IS NULL OR user_id = ?)`,
      ).run(text(subject.username), text(subject.name) ?? text(subject.username), id, now.toISOString(), slot, id);
      identityUpdated = true;
    }
  }
  insertPage.run(
    slot,
    sourceUserId,
    namespace,
    tool,
    observedAt,
    expiresAt,
    paginationComplete ? 1 : 0,
    nextToken,
    activityWindowComplete ? 1 : 0,
    accepted.length,
    JSON.stringify(envelope.errors),
    JSON.stringify(envelope.request_fields),
  );
  return {
    ok: true as const,
    accountId: slot,
    sourceUserId,
    sourceTool: tool,
    accepted,
    identityUpdated,
    userDeveloperGets: 0,
    paginationComplete,
    nextToken,
    activityWindowComplete,
  };
}

function latestRows(slot: AccountId, targetUserId: string, now: Date): SubjectRow[] {
  return getDb()
    .prepare(
      `SELECT target_user_id, observed_at, expires_at, source_tool, pagination_complete, activity_window_complete, verified, verified_type, connection_explicit, connection_status_json, followers_count, last_post_at, tweet_lang, name, bio, username, tweet_text
       FROM evidence_subjects
       WHERE account_id = ? AND source_user_id = ? AND target_user_id = ? AND expires_at > ?
       ORDER BY observed_at DESC`,
    )
    .all(slot, ACCOUNT_USER_ID[slot], targetUserId, now.toISOString()) as SubjectRow[];
}

function interpret(rows: SubjectRow[], now: Date): EvidenceSubjectView | null {
  if (!rows.length) return null;
  const newest = rows[0];
  let blue: boolean | null = null;
  let following: boolean | null = null;
  let followsBack: boolean | null = null;
  let connectionExplicit = false;
  let paginationComplete = false;
  let activityWindowComplete = false;
  let lastPostAt: string | null = null;
  let tweetLang: string | null = null;
  let followersCount: number | null = null;
  let name: string | null = null;
  let bio: string | null = null;
  let username: string | null = null;
  let tweetText: string | null = null;
  for (const row of rows) {
    if (row.verified !== null && row.verified_type && blue === null) {
      blue = row.verified === 1 && row.verified_type.toLowerCase() === "blue";
    }
    if (row.connection_explicit && !connectionExplicit) {
      connectionExplicit = true;
      paginationComplete = row.pagination_complete === 1;
      const list = row.connection_status_json ? (JSON.parse(row.connection_status_json) as string[]) : [];
      following = list.includes("following");
      followsBack = list.includes("followed_by");
    }
    if (row.activity_window_complete === 1) activityWindowComplete = true;
    if (row.last_post_at && (!lastPostAt || row.last_post_at > lastPostAt)) lastPostAt = row.last_post_at;
    tweetLang = tweetLang ?? row.tweet_lang;
    followersCount = followersCount ?? row.followers_count;
    name = name ?? row.name;
    bio = bio ?? row.bio;
    username = username ?? row.username;
    tweetText = tweetText ?? row.tweet_text;
  }
  return {
    targetUserId: newest.target_user_id,
    observedAt: newest.observed_at,
    expiresAt: newest.expires_at,
    sourceTool: newest.source_tool,
    fresh: Date.parse(newest.expires_at) > now.getTime(),
    blue,
    following: connectionExplicit ? following : null,
    followsBack: connectionExplicit ? followsBack : null,
    connectionExplicit,
    paginationComplete,
    activityWindowComplete,
    lastPostAt,
    tweetLang,
    followersCount,
    name,
    bio,
    username,
    tweetText,
  };
}

export function readEvidence(slot: AccountId, targetUserId: string, now = new Date()): EvidenceSubjectView | null {
  return interpret(latestRows(slot, targetUserId, now), now);
}

export function evidenceFollowProfile(slot: AccountId, targetUserId: string, now = new Date()): FollowProfile {
  const evidence = readEvidence(slot, targetUserId, now);
  if (!evidence) {
    return {
      blue: null, following: null, followsBack: null, followers: null, name: null, bio: null, username: null,
      tweetLang: null, tweetText: null, lastPostAt: null, lastPostKnown: false,
    };
  }
  return {
    blue: evidence.blue,
    following: evidence.following,
    followsBack: evidence.followsBack,
    followers: evidence.followersCount,
    name: evidence.name,
    bio: evidence.bio,
    username: evidence.username,
    tweetLang: evidence.tweetLang,
    tweetText: evidence.tweetText,
    lastPostAt: evidence.lastPostAt,
    lastPostKnown: evidence.activityWindowComplete,
  };
}

export function evidenceUnfollowProfile(slot: AccountId, targetUserId: string, now = new Date()): FreshProfile {
  const evidence = readEvidence(slot, targetUserId, now);
  if (!evidence) return { following: null, blue: null, followsBack: null, lastPostAt: null, lastPostKnown: false };
  const recent = evidence.lastPostAt ? Date.parse(evidence.lastPostAt) > now.getTime() - 48 * 60 * 60 * 1000 : false;
  return {
    following: evidence.following,
    blue: evidence.blue,
    followsBack: evidence.followsBack,
    lastPostAt: evidence.lastPostAt,
    lastPostKnown: evidence.activityWindowComplete || recent,
  };
}

export function evidenceCoverage(slot: AccountId, now = new Date()) {
  const rows = getDb()
    .prepare(
      `SELECT source_tool, observed_at, expires_at, pagination_complete, next_token, activity_window_complete, subject_count, errors_json
       FROM evidence_pages WHERE account_id = ? AND source_user_id = ? ORDER BY observed_at DESC LIMIT 20`,
    )
    .all(slot, ACCOUNT_USER_ID[slot]) as Array<{
    source_tool: string;
    observed_at: string;
    expires_at: string;
    pagination_complete: number;
    next_token: string | null;
    activity_window_complete: number;
    subject_count: number;
    errors_json: string;
  }>;
  return {
    accountId: slot,
    sourceUserId: ACCOUNT_USER_ID[slot],
    userDeveloperGets: 0,
    supply: "external_free_evidence_only",
    supplierLimits: { perMinute: 30, perDay: 1000, enforcedHere: false },
    pages: rows.map((row) => ({
      sourceTool: row.source_tool,
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
      fresh: Date.parse(row.expires_at) > now.getTime(),
      paginationComplete: row.pagination_complete === 1,
      nextToken: row.next_token,
      activityWindowComplete: row.activity_window_complete === 1,
      subjectCount: row.subject_count,
      errors: JSON.parse(row.errors_json) as unknown[],
    })),
  };
}
