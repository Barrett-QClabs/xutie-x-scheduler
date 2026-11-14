import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACCOUNT_IDS, type AccountId } from "@/lib/account";
import { DEFAULT_RANDOM_MAX_SECONDS, DEFAULT_RANDOM_MIN_SECONDS } from "@/lib/schedule";
import type { DelayReason, QueueSettings, Tweet, TweetExtra, TweetStatus } from "@/lib/types";

let database: DatabaseSync | null = null;

export function databasePath(): string {
  return process.env.DATABASE_PATH || path.join(process.cwd(), "data", "xqueue.sqlite");
}

export function getDb(): DatabaseSync {
  if (database) return database;
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  database = db;
  return db;
}

export function reopenDatabase(): DatabaseSync {
  database?.close();
  database = null;
  return getDb();
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
      ciphertext TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      user_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_settings (
      id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
      interval_minutes INTEGER NOT NULL DEFAULT 15,
      jitter_minutes INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 1,
      pause_reason TEXT,
      rate_limit_until TEXT,
      last_error TEXT,
      lock_until TEXT,
      timeline_checked_at TEXT,
      timeline_latest_at TEXT,
      timeline_latest_id TEXT,
      timeline_ok INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      weighted_length INTEGER NOT NULL,
      status TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      posted_at TEXT,
      tweet_id TEXT,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL,
      delay_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tweets_status_sched ON tweets(status, scheduled_at);
  `);
  ensureColumn(db, "queue_settings", "lock_until", "ALTER TABLE queue_settings ADD COLUMN lock_until TEXT");
  ensureColumn(db, "queue_settings", "timeline_checked_at", "ALTER TABLE queue_settings ADD COLUMN timeline_checked_at TEXT");
  ensureColumn(db, "queue_settings", "timeline_latest_at", "ALTER TABLE queue_settings ADD COLUMN timeline_latest_at TEXT");
  ensureColumn(db, "queue_settings", "timeline_latest_id", "ALTER TABLE queue_settings ADD COLUMN timeline_latest_id TEXT");
  ensureColumn(db, "queue_settings", "anchored_manual_id", "ALTER TABLE queue_settings ADD COLUMN anchored_manual_id TEXT");
  ensureColumn(db, "queue_settings", "timeline_ok", "ALTER TABLE queue_settings ADD COLUMN timeline_ok INTEGER");
  ensureColumn(
    db,
    "queue_settings",
    "random_min_seconds",
    "ALTER TABLE queue_settings ADD COLUMN random_min_seconds INTEGER NOT NULL DEFAULT 60",
  );
  ensureColumn(
    db,
    "queue_settings",
    "random_max_seconds",
    "ALTER TABLE queue_settings ADD COLUMN random_max_seconds INTEGER NOT NULL DEFAULT 120",
  );
  ensureColumn(db, "tweets", "delay_reason", "ALTER TABLE tweets ADD COLUMN delay_reason TEXT");
  ensureColumn(db, "tweets", "extra_json", "ALTER TABLE tweets ADD COLUMN extra_json TEXT");
  ensureColumn(db, "tweets", "error_kind", "ALTER TABLE tweets ADD COLUMN error_kind TEXT");
  ensureColumn(db, "queue_settings", "last_tick_at", "ALTER TABLE queue_settings ADD COLUMN last_tick_at TEXT");
  ensureColumn(db, "queue_settings", "last_tick_action", "ALTER TABLE queue_settings ADD COLUMN last_tick_action TEXT");
  widenAccountTables(db);
  ensureColumn(db, "tweets", "account_id", "ALTER TABLE tweets ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tweets_account_sched ON tweets(account_id, status, scheduled_at)");
  ensureAutomationTables(db);
  ensurePostDeleteLog(db);
  const now = new Date().toISOString();
  for (const id of ACCOUNT_IDS) {
    db.prepare(
      `INSERT OR IGNORE INTO queue_settings
        (id, interval_minutes, jitter_minutes, paused, pause_reason, updated_at)
       VALUES (?, 15, 0, 1, 'safe_start', ?)`,
    ).run(id, now);
  }
}

type CredentialRow = {
  ciphertext: string;
  username: string | null;
  display_name: string | null;
  user_id: string | null;
};

type TweetRow = {
  id: string;
  account_id?: number | null;
  text: string;
  weighted_length: number;
  status: string;
  scheduled_at: string;
  posted_at: string | null;
  tweet_id: string | null;
  error_message: string | null;
  error_kind?: string | null;
  attempt_count: number;
  sort_order: number;
  delay_reason: string | null;
  extra_json?: string | null;
  created_at: string;
  updated_at: string;
};

function ensureAutomationTables(db: DatabaseSync): void {
  const legacy = tableSql(db, "unfollow_batches");
  if (legacy && !/IN \(1,\s*2\)/i.test(legacy)) {
    db.exec(`
      CREATE TABLE unfollow_control_new (
        account_id INTEGER PRIMARY KEY CHECK (account_id IN (1, 2)),
        paused INTEGER NOT NULL DEFAULT 1,
        pause_reason TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO unfollow_control_new (account_id, paused, pause_reason, updated_at)
      SELECT account_id, paused, pause_reason, updated_at FROM unfollow_control;
      DROP TABLE unfollow_control;
      ALTER TABLE unfollow_control_new RENAME TO unfollow_control;

      CREATE TABLE unfollow_candidates_new (
        account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
        target_user_id TEXT NOT NULL,
        username TEXT,
        tier TEXT NOT NULL,
        first_recorded_at TEXT,
        followed_at TEXT,
        following_rank INTEGER,
        status TEXT NOT NULL,
        batch_slot TEXT,
        result TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, target_user_id)
      );
      INSERT INTO unfollow_candidates_new
        (account_id, target_user_id, username, tier, first_recorded_at, followed_at, status, batch_slot, result, reason, created_at, updated_at)
      SELECT account_id, target_user_id, username, tier, first_recorded_at, NULL, status, batch_slot, result, reason, created_at, updated_at
      FROM unfollow_candidates;
      DROP TABLE unfollow_candidates;
      ALTER TABLE unfollow_candidates_new RENAME TO unfollow_candidates;

      CREATE TABLE unfollow_batches_new (
        account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
        slot TEXT NOT NULL,
        status TEXT NOT NULL,
        submitted INTEGER NOT NULL DEFAULT 0,
        unfollowed INTEGER NOT NULL DEFAULT 0,
        results_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (account_id, slot)
      );
      INSERT INTO unfollow_batches_new
        (account_id, slot, status, submitted, unfollowed, results_json, started_at, finished_at)
      SELECT account_id, slot, status, submitted, unfollowed, results_json, started_at, finished_at FROM unfollow_batches;
      DROP TABLE unfollow_batches;
      ALTER TABLE unfollow_batches_new RENAME TO unfollow_batches;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS unfollow_control (
      account_id INTEGER PRIMARY KEY CHECK (account_id IN (1, 2)),
      paused INTEGER NOT NULL DEFAULT 1,
      pause_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unfollow_candidates (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      target_user_id TEXT NOT NULL,
      username TEXT,
      tier TEXT NOT NULL,
      first_recorded_at TEXT,
      followed_at TEXT,
      following_rank INTEGER,
      status TEXT NOT NULL,
      batch_slot TEXT,
      result TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, target_user_id)
    );
    CREATE TABLE IF NOT EXISTS unfollow_batches (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      slot TEXT NOT NULL,
      status TEXT NOT NULL,
      submitted INTEGER NOT NULL DEFAULT 0,
      unfollowed INTEGER NOT NULL DEFAULT 0,
      results_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY (account_id, slot)
    );
    CREATE TABLE IF NOT EXISTS follow_account_config (
      account_id INTEGER PRIMARY KEY CHECK (account_id IN (1, 2)),
      keywords_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follow_control (
      account_id INTEGER PRIMARY KEY CHECK (account_id IN (1, 2)),
      paused INTEGER NOT NULL DEFAULT 1,
      pause_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follow_reserve (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      target_user_id TEXT NOT NULL,
      username TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      followers_count INTEGER,
      last_post_at TEXT,
      prefer_flb INTEGER,
      result TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, target_user_id)
    );
    CREATE TABLE IF NOT EXISTS follow_batches (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      slot TEXT NOT NULL,
      status TEXT NOT NULL,
      submitted INTEGER NOT NULL DEFAULT 0,
      followed INTEGER NOT NULL DEFAULT 0,
      results_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY (account_id, slot)
    );
    CREATE TABLE IF NOT EXISTS evidence_subjects (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      source_user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      source_namespace TEXT NOT NULL,
      actual_source_namespace TEXT NOT NULL,
      normalized_source TEXT NOT NULL,
      source_tool TEXT NOT NULL,
      pagination_complete INTEGER NOT NULL,
      next_token TEXT,
      activity_window_complete INTEGER NOT NULL,
      claimed_activity_window_complete INTEGER NOT NULL,
      errors_json TEXT NOT NULL,
      verified INTEGER,
      verified_type TEXT,
      connection_status_json TEXT,
      connection_explicit INTEGER NOT NULL,
      connection_omission_empty INTEGER NOT NULL DEFAULT 0,
      followers_count INTEGER,
      last_post_at TEXT,
      tweet_lang TEXT,
      name TEXT,
      bio TEXT,
      username TEXT,
      tweet_text TEXT,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (account_id, target_user_id, source_tool, observed_at)
    );
    CREATE TABLE IF NOT EXISTS evidence_pages (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      source_user_id TEXT NOT NULL,
      source_namespace TEXT NOT NULL,
      actual_source_namespace TEXT NOT NULL,
      normalized_source TEXT NOT NULL,
      source_tool TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      pagination_complete INTEGER NOT NULL,
      next_token TEXT,
      activity_window_complete INTEGER NOT NULL,
      claimed_activity_window_complete INTEGER NOT NULL,
      subject_count INTEGER NOT NULL,
      errors_json TEXT NOT NULL,
      request_fields TEXT NOT NULL,
      PRIMARY KEY (account_id, source_tool, observed_at)
    );
    CREATE TABLE IF NOT EXISTS follow_success (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      target_user_id TEXT NOT NULL,
      username TEXT,
      kind TEXT NOT NULL,
      succeeded_at TEXT NOT NULL,
      slot TEXT NOT NULL,
      london_day TEXT NOT NULL,
      PRIMARY KEY (account_id, target_user_id)
    );
    CREATE TABLE IF NOT EXISTS follow_reserve_audit (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      target_user_id TEXT NOT NULL,
      username TEXT,
      kind TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      followers_count INTEGER,
      last_post_at TEXT,
      prefer_flb INTEGER,
      prior_status TEXT,
      prior_result TEXT,
      prior_reason TEXT,
      parked_reason TEXT NOT NULL,
      evidence_reason TEXT,
      terminal INTEGER NOT NULL DEFAULT 0,
      parked_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (account_id, target_user_id, parked_at)
    );
  `);
  ensureColumn(db, "evidence_subjects", "actual_source_namespace", "ALTER TABLE evidence_subjects ADD COLUMN actual_source_namespace TEXT");
  ensureColumn(db, "evidence_subjects", "normalized_source", "ALTER TABLE evidence_subjects ADD COLUMN normalized_source TEXT");
  ensureColumn(db, "evidence_subjects", "claimed_activity_window_complete", "ALTER TABLE evidence_subjects ADD COLUMN claimed_activity_window_complete INTEGER");
  ensureColumn(
    db,
    "evidence_subjects",
    "connection_omission_empty",
    "ALTER TABLE evidence_subjects ADD COLUMN connection_omission_empty INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(db, "evidence_pages", "actual_source_namespace", "ALTER TABLE evidence_pages ADD COLUMN actual_source_namespace TEXT");
  ensureColumn(db, "evidence_pages", "normalized_source", "ALTER TABLE evidence_pages ADD COLUMN normalized_source TEXT");
  ensureColumn(db, "evidence_pages", "claimed_activity_window_complete", "ALTER TABLE evidence_pages ADD COLUMN claimed_activity_window_complete INTEGER");
  ensureColumn(db, "unfollow_candidates", "following_rank", "ALTER TABLE unfollow_candidates ADD COLUMN following_rank INTEGER");
  ensureNewAdmissionTables(db);
  const now = new Date().toISOString();
  for (const id of [1, 2]) {
    db.prepare(
      `INSERT OR IGNORE INTO unfollow_control (account_id, paused, pause_reason, updated_at) VALUES (?, 1, 'safe_start', ?)`,
    ).run(id, now);
    db.prepare(
      `INSERT OR IGNORE INTO follow_control (account_id, paused, pause_reason, updated_at) VALUES (?, 1, 'safe_start', ?)`,
    ).run(id, now);
  }
}

function tableSql(db: DatabaseSync, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { sql: string }
    | undefined;
  return row?.sql ?? "";
}

/** Older databases allowed only credentials/queue id 1. Rebuild those tables so 账号2 can have its own row. */
function widenAccountTables(db: DatabaseSync): void {
  if (!/IN \(1,\s*2\)/i.test(tableSql(db, "credentials"))) {
    db.exec(`
      CREATE TABLE credentials_new (
        id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
        ciphertext TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        user_id TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO credentials_new (id, ciphertext, username, display_name, user_id, updated_at)
      SELECT id, ciphertext, username, display_name, user_id, updated_at FROM credentials;
      DROP TABLE credentials;
      ALTER TABLE credentials_new RENAME TO credentials;
    `);
  }
  if (/IN \(1,\s*2\)/i.test(tableSql(db, "queue_settings"))) return;
  const existing = db.prepare("PRAGMA table_info(queue_settings)").all() as Array<{ name: string }>;
  db.exec(`
    CREATE TABLE queue_settings_new (
      id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
      interval_minutes INTEGER NOT NULL DEFAULT 15,
      jitter_minutes INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 1,
      pause_reason TEXT,
      rate_limit_until TEXT,
      last_error TEXT,
      lock_until TEXT,
      timeline_checked_at TEXT,
      timeline_latest_at TEXT,
      timeline_latest_id TEXT,
      timeline_ok INTEGER,
      anchored_manual_id TEXT,
      random_min_seconds INTEGER NOT NULL DEFAULT 60,
      random_max_seconds INTEGER NOT NULL DEFAULT 120,
      last_tick_at TEXT,
      last_tick_action TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const target = new Set(
    (db.prepare("PRAGMA table_info(queue_settings_new)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  const shared = existing.map((column) => column.name).filter((name) => target.has(name));
  db.exec(
    `INSERT INTO queue_settings_new (${shared.join(", ")}) SELECT ${shared.join(", ")} FROM queue_settings`,
  );
  db.exec("DROP TABLE queue_settings");
  db.exec("ALTER TABLE queue_settings_new RENAME TO queue_settings");
}

/** Local results for DELETE /2/tweets/:id. Independent of the post queue. */
function ensureNewAdmissionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS follow_new_admission (
      account_id INTEGER NOT NULL CHECK (account_id = 1),
      target_user_id TEXT NOT NULL,
      username TEXT,
      sequence INTEGER NOT NULL,
      admitted_at TEXT NOT NULL,
      qualification_checked_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      follow_reason TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      reason TEXT,
      slot TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, target_user_id)
    );
    CREATE TABLE IF NOT EXISTS follow_new_approval (
      account_id INTEGER NOT NULL CHECK (account_id = 1),
      pool_day TEXT NOT NULL,
      approved_start TEXT NOT NULL,
      approved_end TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, pool_day)
    );
  `);
}

function ensurePostDeleteLog(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_delete_log (
      account_id INTEGER NOT NULL CHECK (account_id IN (1, 2)),
      tweet_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('deleted', 'already_gone', 'error')),
      http_status INTEGER,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (account_id, tweet_id)
    );
  `);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(ddl);
}

function one<T>(sql: string, ...params: unknown[]): T | null {
  const row = getDb().prepare(sql).get(...params);
  return (row as T | undefined) ?? null;
}

export function getCredentialsRow(accountId: AccountId = 1): CredentialRow | null {
  return one<CredentialRow>(
    "SELECT ciphertext, username, display_name, user_id FROM credentials WHERE id = ?",
    accountId,
  );
}

export function upsertCredentials(accountId: AccountId, ciphertext: string): void {
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO credentials (id, ciphertext, username, display_name, user_id, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         username = NULL,
         display_name = NULL,
         user_id = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(accountId, ciphertext, updatedAt);
}

export function updateAccount(
  accountId: AccountId,
  account: { username: string; displayName: string; userId: string },
): void {
  getDb()
    .prepare(
      `UPDATE credentials
       SET username = ?, display_name = ?, user_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(account.username, account.displayName, account.userId, new Date().toISOString(), accountId);
}

export function deleteCredentials(accountId: AccountId): void {
  getDb().prepare("DELETE FROM credentials WHERE id = ?").run(accountId);
}

export function getQueueSettings(accountId: AccountId = 1): QueueSettings {
  const row = one<{
    interval_minutes: number;
    random_min_seconds: number | null;
    random_max_seconds: number | null;
    paused: number;
    pause_reason: string | null;
    rate_limit_until: string | null;
    last_error: string | null;
    last_tick_at: string | null;
    last_tick_action: string | null;
  }>(
    `SELECT interval_minutes, random_min_seconds, random_max_seconds, paused, pause_reason, rate_limit_until, last_error,
            last_tick_at, last_tick_action
     FROM queue_settings WHERE id = ?`,
    accountId,
  );
  if (!row) {
    return {
      intervalMinutes: 15,
      randomMinSeconds: DEFAULT_RANDOM_MIN_SECONDS,
      randomMaxSeconds: DEFAULT_RANDOM_MAX_SECONDS,
      paused: false,
      pauseReason: null,
      rateLimitUntil: null,
      lastError: null,
      lastTickAt: null,
      lastTickAction: null,
    };
  }
  return {
    intervalMinutes: row.interval_minutes,
    randomMinSeconds: row.random_min_seconds ?? DEFAULT_RANDOM_MIN_SECONDS,
    randomMaxSeconds: row.random_max_seconds ?? DEFAULT_RANDOM_MAX_SECONDS,
    paused: row.paused === 1,
    pauseReason: row.pause_reason,
    rateLimitUntil: row.rate_limit_until,
    lastError: row.last_error,
    lastTickAt: row.last_tick_at,
    lastTickAction: row.last_tick_action,
  };
}

export function patchQueueSettings(
  accountId: AccountId,
  fields: Partial<{
    intervalMinutes: number;
    randomMinSeconds: number;
    randomMaxSeconds: number;
    paused: boolean;
    pauseReason: string | null;
    rateLimitUntil: string | null;
    lastError: string | null;
    lastTickAt: string | null;
    lastTickAction: string | null;
  }>,
): void {
  const map: Record<string, string> = {
    intervalMinutes: "interval_minutes",
    randomMinSeconds: "random_min_seconds",
    randomMaxSeconds: "random_max_seconds",
    paused: "paused",
    pauseReason: "pause_reason",
    rateLimitUntil: "rate_limit_until",
    lastError: "last_error",
    lastTickAt: "last_tick_at",
    lastTickAction: "last_tick_action",
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (!(key in fields)) continue;
    const value = fields[key as keyof typeof fields];
    sets.push(`${column} = ?`);
    params.push(key === "paused" ? (value ? 1 : 0) : value);
  }
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  getDb().prepare(`UPDATE queue_settings SET ${sets.join(", ")} WHERE id = ?`).run(...params, accountId);
}

export function tryAcquireLock(accountId: AccountId, now: Date, holdMs = 30_000): boolean {
  const until = new Date(now.getTime() + holdMs).toISOString();
  const result = getDb()
    .prepare(
      `UPDATE queue_settings
       SET lock_until = ?
       WHERE id = ? AND (lock_until IS NULL OR lock_until < ?)`,
    )
    .run(until, accountId, now.toISOString());
  return result.changes > 0;
}

export function releaseLock(accountId: AccountId): void {
  getDb().prepare("UPDATE queue_settings SET lock_until = NULL WHERE id = ?").run(accountId);
}

export type TimelineCache = {
  checkedAt: string | null;
  latestAt: string | null;
  latestId: string | null;
  ok: boolean;
};

export function getTimelineCache(accountId: AccountId): TimelineCache {
  const row = one<{
    timeline_checked_at: string | null;
    timeline_latest_at: string | null;
    timeline_latest_id: string | null;
    timeline_ok: number | null;
  }>(
    `SELECT timeline_checked_at, timeline_latest_at, timeline_latest_id, timeline_ok
     FROM queue_settings WHERE id = ?`,
    accountId,
  );
  return {
    checkedAt: row?.timeline_checked_at ?? null,
    latestAt: row?.timeline_latest_at ?? null,
    latestId: row?.timeline_latest_id ?? null,
    ok: row?.timeline_ok === 1,
  };
}

export function setTimelineCache(accountId: AccountId, cache: TimelineCache): void {
  getDb()
    .prepare(
      `UPDATE queue_settings
       SET timeline_checked_at = ?, timeline_latest_at = ?, timeline_latest_id = ?, timeline_ok = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      cache.checkedAt,
      cache.latestAt,
      cache.latestId,
      cache.ok ? 1 : 0,
      new Date().toISOString(),
      accountId,
    );
}

/** Id of the manual X post the queue was last re-anchored to (so each manual post anchors once). */
export function getAnchoredManualId(accountId: AccountId): string | null {
  return (
    one<{ anchored_manual_id: string | null }>("SELECT anchored_manual_id FROM queue_settings WHERE id = ?", accountId)
      ?.anchored_manual_id ?? null
  );
}

export function setAnchoredManualId(accountId: AccountId, id: string | null): void {
  getDb().prepare("UPDATE queue_settings SET anchored_manual_id = ? WHERE id = ?").run(id, accountId);
}

function parseExtra(raw: string | null | undefined): TweetExtra | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as TweetExtra;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function mapTweet(row: TweetRow): Tweet {
  return {
    id: row.id,
    text: row.text,
    weightedLength: row.weighted_length,
    status: row.status as TweetStatus,
    scheduledAt: row.scheduled_at,
    postedAt: row.posted_at,
    tweetId: row.tweet_id,
    errorMessage: row.error_message,
    errorKind: row.error_kind ?? null,
    attemptCount: row.attempt_count,
    sortOrder: row.sort_order,
    delayReason: row.delay_reason === "manual" ? "manual" : null,
    accountId: row.account_id === 2 ? 2 : 1,
    extra: parseExtra(row.extra_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTweets(accountId: AccountId = 1): Tweet[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tweets
       WHERE account_id = ?
       ORDER BY scheduled_at ASC, sort_order ASC, created_at ASC`,
    )
    .all(accountId) as TweetRow[];
  return rows.map(mapTweet);
}

export function getTweet(id: string, accountId: AccountId = 1): Tweet | null {
  const row = one<TweetRow>("SELECT * FROM tweets WHERE id = ? AND account_id = ?", id, accountId);
  return row ? mapTweet(row) : null;
}

export function nextSortOrder(accountId: AccountId = 1): number {
  const row = one<{ max: number | null }>("SELECT MAX(sort_order) AS max FROM tweets WHERE account_id = ?", accountId);
  return (row?.max ?? 0) + 1;
}

export function insertTweets(rows: Tweet[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const statement = db.prepare(
    `INSERT INTO tweets (
      id, account_id, text, weighted_length, status, scheduled_at, posted_at, tweet_id,
      error_message, attempt_count, sort_order, delay_reason, extra_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      statement.run(
        row.id,
        row.accountId,
        row.text,
        row.weightedLength,
        row.status,
        row.scheduledAt,
        row.postedAt,
        row.tweetId,
        row.errorMessage,
        row.attemptCount,
        row.sortOrder,
        row.delayReason,
        row.extra ? JSON.stringify(row.extra) : null,
        row.createdAt,
        row.updatedAt,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const TWEET_COLUMNS: Record<string, string> = {
  text: "text",
  weightedLength: "weighted_length",
  status: "status",
  scheduledAt: "scheduled_at",
  postedAt: "posted_at",
  tweetId: "tweet_id",
  errorMessage: "error_message",
  errorKind: "error_kind",
  attemptCount: "attempt_count",
  sortOrder: "sort_order",
  delayReason: "delay_reason",
  extra: "extra_json",
};

export function patchTweet(
  id: string,
  accountId: AccountId,
  fields: Partial<{
    text: string;
    weightedLength: number;
    status: TweetStatus;
    scheduledAt: string;
    postedAt: string | null;
    tweetId: string | null;
    errorMessage: string | null;
    errorKind: string | null;
    attemptCount: number;
    sortOrder: number;
    delayReason: DelayReason;
    extra: TweetExtra | null;
  }>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(TWEET_COLUMNS)) {
    if (!(key in fields)) continue;
    sets.push(`${column} = ?`);
    const value = fields[key as keyof typeof fields];
    params.push(key === "extra" ? (value ? JSON.stringify(value) : null) : value);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  params.push(new Date().toISOString(), id, accountId);
  getDb().prepare(`UPDATE tweets SET ${sets.join(", ")} WHERE id = ? AND account_id = ?`).run(...params);
}

export function deleteTweet(id: string, accountId: AccountId): boolean {
  const result = getDb().prepare("DELETE FROM tweets WHERE id = ? AND account_id = ?").run(id, accountId);
  return result.changes > 0;
}

export type PostDeleteLogStatus = "deleted" | "already_gone" | "error";

export type PostDeleteLogRecord = {
  tweetId: string;
  status: PostDeleteLogStatus;
  httpStatus: number | null;
  at: string;
};

type PostDeleteLogRow = {
  tweet_id: string;
  status: string;
  http_status: number | null;
  recorded_at: string;
};

function postDeleteLogRecord(row: PostDeleteLogRow): PostDeleteLogRecord | null {
  if (row.status !== "deleted" && row.status !== "already_gone" && row.status !== "error") return null;
  return {
    tweetId: row.tweet_id,
    status: row.status,
    httpStatus: row.http_status,
    at: row.recorded_at,
  };
}

export function getPostDeleteLog(accountId: AccountId, tweetId: string): PostDeleteLogRecord | null {
  const row = one<PostDeleteLogRow>(
    `SELECT tweet_id, status, http_status, recorded_at
     FROM post_delete_log WHERE account_id = ? AND tweet_id = ?`,
    accountId,
    tweetId,
  );
  return row ? postDeleteLogRecord(row) : null;
}

export function listPostDeleteLog(accountId: AccountId): PostDeleteLogRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT tweet_id, status, http_status, recorded_at
       FROM post_delete_log WHERE account_id = ?
       ORDER BY recorded_at ASC, tweet_id ASC`,
    )
    .all(accountId) as PostDeleteLogRow[];
  return rows.flatMap((row) => {
    const record = postDeleteLogRecord(row);
    return record ? [record] : [];
  });
}

export function upsertPostDeleteLog(accountId: AccountId, record: PostDeleteLogRecord): void {
  getDb()
    .prepare(
      `INSERT INTO post_delete_log (account_id, tweet_id, status, http_status, recorded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, tweet_id) DO UPDATE SET
         status = excluded.status,
         http_status = excluded.http_status,
         recorded_at = excluded.recorded_at`,
    )
    .run(accountId, record.tweetId, record.status, record.httpStatus, record.at);
}

/** Test helper. Production first boot stays paused; this puts the fixture queue back into the unpaused path. */
export function resetAllData(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.exec(`
    DELETE FROM tweets;
    DELETE FROM post_delete_log;
    DELETE FROM credentials;
    DELETE FROM unfollow_candidates;
    DELETE FROM unfollow_batches;
    DELETE FROM follow_reserve;
    DELETE FROM follow_reserve_audit;
    DELETE FROM follow_batches;
    DELETE FROM follow_success;
    DELETE FROM follow_new_admission;
    DELETE FROM follow_new_approval;
    DELETE FROM evidence_subjects;
    DELETE FROM evidence_pages;
  `);
  db.prepare(`UPDATE unfollow_control SET paused = 1, pause_reason = 'safe_start', updated_at = ?`).run(now);
  db.prepare(`UPDATE follow_control SET paused = 1, pause_reason = 'safe_start', updated_at = ?`).run(now);
  const reset = (accountId: AccountId, paused: number, reason: string | null) => {
    db.prepare(
      `UPDATE queue_settings SET
        interval_minutes = 15,
        jitter_minutes = 0,
        random_min_seconds = 60,
        random_max_seconds = 120,
        paused = ?,
        pause_reason = ?,
        rate_limit_until = NULL,
        last_error = NULL,
        last_tick_at = NULL,
        last_tick_action = NULL,
        lock_until = NULL,
        timeline_checked_at = NULL,
        timeline_latest_at = NULL,
        timeline_latest_id = NULL,
        timeline_ok = NULL,
        anchored_manual_id = NULL,
        updated_at = ?
       WHERE id = ?`,
    ).run(paused, reason, now, accountId);
  };
  reset(1, 0, null);
  reset(2, 1, "safe_start");
}
