import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DelayReason, QueueSettings, Tweet, TweetStatus } from "@/lib/types";

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
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ciphertext TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      user_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      interval_minutes INTEGER NOT NULL DEFAULT 15,
      jitter_minutes INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
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
  ensureColumn(db, "queue_settings", "timeline_ok", "ALTER TABLE queue_settings ADD COLUMN timeline_ok INTEGER");
  ensureColumn(db, "tweets", "delay_reason", "ALTER TABLE tweets ADD COLUMN delay_reason TEXT");
  db.prepare(
    `INSERT OR IGNORE INTO queue_settings
      (id, interval_minutes, jitter_minutes, paused, updated_at)
     VALUES (1, 15, 0, 0, ?)`,
  ).run(new Date().toISOString());
}

type CredentialRow = {
  ciphertext: string;
  username: string | null;
  display_name: string | null;
  user_id: string | null;
};

type TweetRow = {
  id: string;
  text: string;
  weighted_length: number;
  status: string;
  scheduled_at: string;
  posted_at: string | null;
  tweet_id: string | null;
  error_message: string | null;
  attempt_count: number;
  sort_order: number;
  delay_reason: string | null;
  created_at: string;
  updated_at: string;
};

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(ddl);
}

function one<T>(sql: string, ...params: unknown[]): T | null {
  const row = getDb().prepare(sql).get(...params);
  return (row as T | undefined) ?? null;
}

export function getCredentialsRow(): CredentialRow | null {
  return one<CredentialRow>(
    "SELECT ciphertext, username, display_name, user_id FROM credentials WHERE id = 1",
  );
}

export function upsertCredentials(ciphertext: string): void {
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO credentials (id, ciphertext, username, display_name, user_id, updated_at)
       VALUES (1, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         username = NULL,
         display_name = NULL,
         user_id = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(ciphertext, updatedAt);
}

export function updateAccount(account: { username: string; displayName: string; userId: string }): void {
  getDb()
    .prepare(
      `UPDATE credentials
       SET username = ?, display_name = ?, user_id = ?, updated_at = ?
       WHERE id = 1`,
    )
    .run(account.username, account.displayName, account.userId, new Date().toISOString());
}

export function deleteCredentials(): void {
  getDb().prepare("DELETE FROM credentials WHERE id = 1").run();
}

export function getQueueSettings(): QueueSettings {
  const row = one<{
    interval_minutes: number;
    jitter_minutes: number;
    paused: number;
    pause_reason: string | null;
    rate_limit_until: string | null;
    last_error: string | null;
  }>(
    `SELECT interval_minutes, jitter_minutes, paused, pause_reason, rate_limit_until, last_error
     FROM queue_settings WHERE id = 1`,
  );
  if (!row) {
    return {
      intervalMinutes: 15,
      jitterMinutes: 0,
      paused: false,
      pauseReason: null,
      rateLimitUntil: null,
      lastError: null,
    };
  }
  return {
    intervalMinutes: row.interval_minutes,
    jitterMinutes: row.jitter_minutes,
    paused: row.paused === 1,
    pauseReason: row.pause_reason,
    rateLimitUntil: row.rate_limit_until,
    lastError: row.last_error,
  };
}

export function patchQueueSettings(
  fields: Partial<{
    intervalMinutes: number;
    jitterMinutes: number;
    paused: boolean;
    pauseReason: string | null;
    rateLimitUntil: string | null;
    lastError: string | null;
  }>,
): void {
  const map: Record<string, string> = {
    intervalMinutes: "interval_minutes",
    jitterMinutes: "jitter_minutes",
    paused: "paused",
    pauseReason: "pause_reason",
    rateLimitUntil: "rate_limit_until",
    lastError: "last_error",
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
  getDb().prepare(`UPDATE queue_settings SET ${sets.join(", ")} WHERE id = 1`).run(...params);
}

export function tryAcquireLock(now: Date, holdMs = 30_000): boolean {
  const until = new Date(now.getTime() + holdMs).toISOString();
  const result = getDb()
    .prepare(
      `UPDATE queue_settings
       SET lock_until = ?
       WHERE id = 1 AND (lock_until IS NULL OR lock_until < ?)`,
    )
    .run(until, now.toISOString());
  return result.changes > 0;
}

export function releaseLock(): void {
  getDb().prepare("UPDATE queue_settings SET lock_until = NULL WHERE id = 1").run();
}

export type TimelineCache = {
  checkedAt: string | null;
  latestAt: string | null;
  latestId: string | null;
  ok: boolean;
};

export function getTimelineCache(): TimelineCache {
  const row = one<{
    timeline_checked_at: string | null;
    timeline_latest_at: string | null;
    timeline_latest_id: string | null;
    timeline_ok: number | null;
  }>(
    `SELECT timeline_checked_at, timeline_latest_at, timeline_latest_id, timeline_ok
     FROM queue_settings WHERE id = 1`,
  );
  return {
    checkedAt: row?.timeline_checked_at ?? null,
    latestAt: row?.timeline_latest_at ?? null,
    latestId: row?.timeline_latest_id ?? null,
    ok: row?.timeline_ok === 1,
  };
}

export function setTimelineCache(cache: TimelineCache): void {
  getDb()
    .prepare(
      `UPDATE queue_settings
       SET timeline_checked_at = ?, timeline_latest_at = ?, timeline_latest_id = ?, timeline_ok = ?, updated_at = ?
       WHERE id = 1`,
    )
    .run(
      cache.checkedAt,
      cache.latestAt,
      cache.latestId,
      cache.ok ? 1 : 0,
      new Date().toISOString(),
    );
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
    attemptCount: row.attempt_count,
    sortOrder: row.sort_order,
    delayReason: row.delay_reason === "manual" ? "manual" : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTweets(): Tweet[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tweets
       ORDER BY scheduled_at ASC, sort_order ASC, created_at ASC`,
    )
    .all() as TweetRow[];
  return rows.map(mapTweet);
}

export function getTweet(id: string): Tweet | null {
  const row = one<TweetRow>("SELECT * FROM tweets WHERE id = ?", id);
  return row ? mapTweet(row) : null;
}

export function nextSortOrder(): number {
  const row = one<{ max: number | null }>("SELECT MAX(sort_order) AS max FROM tweets");
  return (row?.max ?? 0) + 1;
}

export function insertTweets(rows: Tweet[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const statement = db.prepare(
    `INSERT INTO tweets (
      id, text, weighted_length, status, scheduled_at, posted_at, tweet_id,
      error_message, attempt_count, sort_order, delay_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      statement.run(
        row.id,
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
  attemptCount: "attempt_count",
  sortOrder: "sort_order",
  delayReason: "delay_reason",
};

export function patchTweet(
  id: string,
  fields: Partial<{
    text: string;
    weightedLength: number;
    status: TweetStatus;
    scheduledAt: string;
    postedAt: string | null;
    tweetId: string | null;
    errorMessage: string | null;
    attemptCount: number;
    sortOrder: number;
    delayReason: DelayReason;
  }>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(TWEET_COLUMNS)) {
    if (!(key in fields)) continue;
    sets.push(`${column} = ?`);
    params.push(fields[key as keyof typeof fields]);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  params.push(new Date().toISOString(), id);
  getDb().prepare(`UPDATE tweets SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function deleteTweet(id: string): boolean {
  const result = getDb().prepare("DELETE FROM tweets WHERE id = ?").run(id);
  return result.changes > 0;
}

export function resetAllData(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.exec("DELETE FROM tweets; DELETE FROM credentials;");
  db.prepare(
    `UPDATE queue_settings SET
      interval_minutes = 15,
      jitter_minutes = 0,
      paused = 0,
      pause_reason = NULL,
      rate_limit_until = NULL,
      last_error = NULL,
      lock_until = NULL,
      timeline_checked_at = NULL,
      timeline_latest_at = NULL,
      timeline_latest_id = NULL,
      timeline_ok = NULL,
      updated_at = ?
     WHERE id = 1`,
  ).run(now);
}
