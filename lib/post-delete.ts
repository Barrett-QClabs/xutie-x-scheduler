/**
 * Delete this account's own posts with X API v2 `DELETE /2/tweets/:id`.
 * The call is a write. This module does not perform a developer-API read,
 * and it does not touch the post queue, follow list, or unfollow list.
 *
 * `deleted` and `already_gone` are settled: a later batch skips them.
 * HTTP 404 is `already_gone` and the batch continues. A 429 or any other
 * failure is stored as `error`, then the remaining ids are left unattempted.
 */

import type { AccountId } from "@/lib/account";
import { getPostDeleteLog, upsertPostDeleteLog, type PostDeleteLogRecord, type PostDeleteLogStatus } from "@/lib/db";
import { apiMode } from "@/lib/deployment";
import { AppError } from "@/lib/errors";
import { readCredentials } from "@/lib/service";
import { XApiError, xDelete } from "@/lib/x-client";

export const POST_DELETE_INTERVAL_DEFAULT_MS = 7_000;
export const POST_DELETE_INTERVAL_MIN_MS = 5_000;
export const POST_DELETE_INTERVAL_MAX_MS = 10_000;
export const POST_DELETE_MAX_IDS = 200;

const TWEET_ID = /^[0-9]{1,25}$/;
const running = new Set<AccountId>();

export type PostDeleteStopReason = "rate_limit" | "http_error" | "not_deleted" | "network" | "aborted";

export type PostDeleteAttempt = PostDeleteLogRecord & { skipped: boolean };

export type PostDeleteBatch = {
  ok: boolean;
  accountId: AccountId;
  intervalMs: number;
  stopped: boolean;
  stopReason: PostDeleteStopReason | null;
  attempted: number;
  skipped: number;
  duplicateCount: number;
  processed: PostDeleteAttempt[];
  remaining: string[];
};

export type PostDeleteSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export type OwnPostDeleter = (accountId: AccountId, tweetId: string) => Promise<unknown>;

export function tweetIdsFromBody(body: unknown): unknown {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && "tweetIds" in body) {
    return (body as { tweetIds: unknown }).tweetIds;
  }
  throw new AppError("invalid_json", "正文需要是 tweetId 数组，或包含 tweetIds 的对象。", 400);
}

export function intervalFromBody(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("intervalMs" in body)) return undefined;
  const value = (body as { intervalMs?: unknown }).intervalMs;
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "number" ? value : Number(value);
}

export function resolvePostDeleteIntervalMs(requested?: number): number {
  const value = requested !== undefined ? requested : intervalFromEnv();
  if (!Number.isInteger(value) || value < POST_DELETE_INTERVAL_MIN_MS || value > POST_DELETE_INTERVAL_MAX_MS) {
    throw new AppError("invalid_interval", "删帖间隔需要在 5000 到 10000 毫秒之间。", 400);
  }
  return value;
}

function intervalFromEnv(): number {
  const raw = process.env.POST_DELETE_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return POST_DELETE_INTERVAL_DEFAULT_MS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new AppError("invalid_interval", "删帖间隔需要在 5000 到 10000 毫秒之间。", 400);
  }
  return Number(raw.trim());
}

export function parseTweetIdList(value: unknown): { ids: string[]; duplicateCount: number } {
  if (!Array.isArray(value)) {
    throw new AppError("invalid_json", "正文需要是 tweetId 数组，或包含 tweetIds 的对象。", 400);
  }
  if (value.length === 0) {
    throw new AppError("invalid_json", "tweetId 数组不能为空。", 400);
  }
  if (value.length > POST_DELETE_MAX_IDS) {
    throw new AppError("invalid_json", `一次最多 ${POST_DELETE_MAX_IDS} 条。`, 400);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const item of value) {
    if (typeof item !== "string" || !TWEET_ID.test(item)) {
      throw new AppError("invalid_json", "tweetId 必须是不超过 25 位的数字字符串。", 400);
    }
    if (seen.has(item)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(item);
    ids.push(item);
  }
  return { ids, duplicateCount };
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function isDeletedBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  if (record.deleted === true) return true;
  const data = record.data;
  if (!data || typeof data !== "object") return false;
  return (data as Record<string, unknown>).deleted === true;
}

function assertRunnerInterval(intervalMs: number): void {
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > POST_DELETE_INTERVAL_MAX_MS) {
    throw new AppError("invalid_interval", "删帖间隔需要在 5000 到 10000 毫秒之间。", 400);
  }
}

/** OAuth 1.0a user context for this account only. `xDelete` itself refuses mock mode. */
async function deleteTweetOnX(accountId: AccountId, tweetId: string): Promise<Record<string, unknown>> {
  const credentials = readCredentials(accountId);
  if (!credentials) throw new AppError("credentials_missing", "请先为这个账号保存凭据。", 400);
  return xDelete(credentials, `/2/tweets/${encodeURIComponent(tweetId)}`);
}

export async function deleteOwnPosts(input: {
  accountId: AccountId;
  tweetIds: unknown;
  intervalMs: number;
  signal?: AbortSignal;
  now?: () => string;
  sleep?: PostDeleteSleep;
  deleteOnX?: OwnPostDeleter;
}): Promise<PostDeleteBatch> {
  const { ids, duplicateCount } = parseTweetIdList(input.tweetIds);
  assertRunnerInterval(input.intervalMs);
  if (!input.deleteOnX) {
    if (apiMode() !== "live") throw new AppError("mock_mode", "模拟模式不会请求 X。", 400);
    if (!readCredentials(input.accountId)) throw new AppError("credentials_missing", "请先为这个账号保存凭据。", 400);
  }
  if (running.has(input.accountId)) {
    throw new AppError("delete_in_progress", "这个账号正在删除帖子，请等这一批结束。", 409);
  }
  running.add(input.accountId);
  try {
    return await runBatch({
      accountId: input.accountId,
      ids,
      duplicateCount,
      intervalMs: input.intervalMs,
      signal: input.signal,
      now: input.now ?? (() => new Date().toISOString()),
      sleep: input.sleep ?? delay,
      deleteOnX: input.deleteOnX ?? deleteTweetOnX,
    });
  } finally {
    running.delete(input.accountId);
  }
}

async function runBatch(input: {
  accountId: AccountId;
  ids: string[];
  duplicateCount: number;
  intervalMs: number;
  signal?: AbortSignal;
  now: () => string;
  sleep: PostDeleteSleep;
  deleteOnX: OwnPostDeleter;
}): Promise<PostDeleteBatch> {
  const processed: PostDeleteAttempt[] = [];
  let attempted = 0;
  let skipped = 0;
  let stopReason: PostDeleteStopReason | null = null;
  let remaining: string[] = [];

  for (let index = 0; index < input.ids.length; index += 1) {
    if (input.signal?.aborted) {
      stopReason = "aborted";
      remaining = input.ids.slice(index);
      break;
    }
    const tweetId = input.ids[index];
    const existing = getPostDeleteLog(input.accountId, tweetId);
    if (existing && isSettled(existing.status)) {
      processed.push({ ...existing, skipped: true });
      skipped += 1;
      continue;
    }
    if (attempted > 0 && input.intervalMs > 0) {
      await input.sleep(input.intervalMs, input.signal);
      if (input.signal?.aborted) {
        stopReason = "aborted";
        remaining = input.ids.slice(index);
        break;
      }
    }
    const outcome = await attemptDelete(input.accountId, tweetId, input.now(), input.deleteOnX);
    attempted += 1;
    processed.push({ ...outcome.record, skipped: false });
    if (outcome.stopReason) {
      stopReason = outcome.stopReason;
      remaining = input.ids.slice(index + 1);
      break;
    }
  }

  return {
    ok: stopReason === null,
    accountId: input.accountId,
    intervalMs: input.intervalMs,
    stopped: stopReason !== null,
    stopReason,
    attempted,
    skipped,
    duplicateCount: input.duplicateCount,
    processed,
    remaining,
  };
}

function isSettled(status: PostDeleteLogStatus): boolean {
  return status === "deleted" || status === "already_gone";
}

async function attemptDelete(
  accountId: AccountId,
  tweetId: string,
  at: string,
  deleteOnX: OwnPostDeleter,
): Promise<{ record: PostDeleteLogRecord; stopReason: PostDeleteStopReason | null }> {
  try {
    const body = await deleteOnX(accountId, tweetId);
    if (!isDeletedBody(body)) {
      const record: PostDeleteLogRecord = { tweetId, status: "error", httpStatus: 200, at };
      upsertPostDeleteLog(accountId, record);
      return { record, stopReason: "not_deleted" };
    }
    const record: PostDeleteLogRecord = { tweetId, status: "deleted", httpStatus: 200, at };
    upsertPostDeleteLog(accountId, record);
    return { record, stopReason: null };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof XApiError && error.status === 404) {
      const record: PostDeleteLogRecord = { tweetId, status: "already_gone", httpStatus: error.status, at };
      upsertPostDeleteLog(accountId, record);
      return { record, stopReason: null };
    }
    const httpStatus = error instanceof XApiError ? error.status : null;
    const record: PostDeleteLogRecord = { tweetId, status: "error", httpStatus, at };
    upsertPostDeleteLog(accountId, record);
    return { record, stopReason: stopReasonFor(error) };
  }
}

function stopReasonFor(error: unknown): PostDeleteStopReason {
  if (error instanceof XApiError) {
    if (error.status === 429) return "rate_limit";
    if (error.status === 0) return "network";
    return "http_error";
  }
  return "network";
}
