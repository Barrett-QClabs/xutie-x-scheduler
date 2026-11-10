import crypto from "node:crypto";
import fs from "node:fs";
import { decryptString, encryptString } from "@/lib/crypto";
import {
  deleteCredentials,
  deleteTweet as deleteTweetRow,
  getCredentialsRow,
  getQueueSettings,
  getTweet,
  insertTweets,
  listTweets,
  nextSortOrder,
  patchQueueSettings,
  patchTweet,
  updateAccount,
  upsertCredentials,
} from "@/lib/db";
import { MAX_IMPORT_BATCH, MAX_IMPORT_SOURCE_CHARS } from "@/lib/constants";
import { buildActivity, classifyStoredFailure } from "@/lib/diagnostics";
import { AppError } from "@/lib/errors";
import { parseImport } from "@/lib/parse-import";
import {
  assertSchedule,
  assertStartAt,
  computeSchedule,
  nextGapMs,
  pushChain,
  randomExtraMs,
  type SchedulePace,
} from "@/lib/schedule";
import type { Credentials, ImportMode, InvalidTweet, PublicState, PublicTweet, Tweet } from "@/lib/types";
import { inspectTweet, MAX_LONG_POST_LENGTH, MAX_WEIGHTED_LENGTH } from "@/lib/weighted-length";
import { ACCOUNT_IDS, ACCOUNT_LABEL, parseAccountId, type AccountId } from "@/lib/account";
import { deploymentPosture } from "@/lib/deployment";
import { createXClient, isMockMode, XApiError } from "@/lib/x-client";

export function readCredentials(accountId: AccountId): Credentials | null {
  const row = getCredentialsRow(accountId);
  if (!row) return null;
  const plain = decryptString(row.ciphertext);
  let parsed: Partial<Credentials>;
  try {
    parsed = JSON.parse(plain) as Partial<Credentials>;
  } catch {
    throw new AppError("decrypt_failed", "已保存的凭据无法读取，请重新填写。", 500);
  }
  if (!parsed.apiKey || !parsed.apiSecret || !parsed.accessToken || !parsed.accessTokenSecret) {
    throw new AppError("decrypt_failed", "已保存的凭据不完整，请重新填写。", 500);
  }
  return {
    apiKey: parsed.apiKey,
    apiSecret: parsed.apiSecret,
    accessToken: parsed.accessToken,
    accessTokenSecret: parsed.accessTokenSecret,
  };
}

function cleanCredential(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function credentialsFromInput(input: Partial<Credentials> | null | undefined): Credentials {
  const credentials = {
    apiKey: cleanCredential(input?.apiKey),
    apiSecret: cleanCredential(input?.apiSecret),
    accessToken: cleanCredential(input?.accessToken),
    accessTokenSecret: cleanCredential(input?.accessTokenSecret),
  };
  if (Object.values(credentials).some((value) => value.length === 0)) {
    throw new AppError("credentials_incomplete", "请填齐 API Key、API Secret、Access Token、Access Token Secret。");
  }
  if (Object.values(credentials).some((value) => value.length > 500)) {
    throw new AppError("credentials_incomplete", "某一项凭据长得不像 X 的密钥。");
  }
  return credentials;
}

export function saveCredentials(accountId: AccountId, input: Partial<Credentials>): { ok: true } {
  const credentials = credentialsFromInput(input);
  upsertCredentials(accountId, encryptString(JSON.stringify(credentials)));
  return { ok: true };
}

export function clearCredentials(accountId: AccountId): { ok: true } {
  deleteCredentials(accountId);
  return { ok: true };
}

export async function testCredentials(accountId: AccountId, input?: Partial<Credentials>): Promise<{
  ok: true;
  username: string;
  displayName: string;
  userId: string;
  saved: boolean;
}> {
  const provided = [input?.apiKey, input?.apiSecret, input?.accessToken, input?.accessTokenSecret].map(cleanCredential);
  const usingStored = provided.every((value) => value.length === 0);
  const credentials = usingStored ? readCredentials(accountId) : credentialsFromInput(input);
  if (!credentials) {
    throw new AppError("credentials_missing", "还没有保存凭据。");
  }
  if (!isMockMode()) {
    const stored = getCredentialsRow(accountId);
    if (usingStored && stored?.user_id && stored.username) {
      return {
        ok: true,
        username: stored.username,
        displayName: stored.display_name || stored.username,
        userId: stored.user_id,
        saved: false,
      };
    }
    throw new AppError(
      "identity_reconfirm_blocked",
      "不能用用户自己的 X 读额度重新确认身份。请由免费供给写入身份证据；本次不会改已保存的身份。",
      409,
    );
  }
  try {
    const user = await createXClient(credentials).verify();
    if (usingStored) {
      updateAccount(accountId, { username: user.username, displayName: user.name, userId: user.id });
    }
    return {
      ok: true,
      username: user.username,
      displayName: user.name,
      userId: user.id,
      saved: usingStored,
    };
  } catch (error) {
    if (error instanceof XApiError) {
      const prefix = error.kind === "auth" ? "凭据被 X 拒绝。" : "X 接口返回错误。";
      throw new AppError(error.kind === "auth" ? "x_auth" : "x_error", `${prefix}${error.message}`, 400);
    }
    if (error instanceof AppError) throw error;
    throw new AppError("x_network", "连不上 X 的服务器。请检查这台机器的网络。", 502);
  }
}

function toPublicTweet(tweet: Tweet, username: string | null): PublicTweet {
  return {
    ...tweet,
    isLong: tweet.weightedLength > MAX_WEIGHTED_LENGTH,
    tweetUrl: tweet.tweetId
      ? username
        ? `https://x.com/${username}/status/${tweet.tweetId}`
        : `https://x.com/i/web/status/${tweet.tweetId}`
      : null,
    failureClass:
      tweet.errorMessage || tweet.errorKind ? classifyStoredFailure(tweet.errorKind, tweet.errorMessage) : null,
  };
}

export function getPublicState(now = new Date(), accountId: AccountId = 1): PublicState {
  const row = getCredentialsRow(accountId);
  const tweets = listTweets(accountId);
  const queue = getQueueSettings(accountId);
  const activity = buildActivity({ now, queue, tweets });
  const slots = ACCOUNT_IDS.map((id) => {
    const cred = getCredentialsRow(id);
    const settings = getQueueSettings(id);
    return {
      id,
      label: ACCOUNT_LABEL[id],
      credentialsConfigured: Boolean(cred),
      paused: settings.paused,
      username: cred?.username ?? null,
    };
  });
  return {
    mockMode: isMockMode(),
    accountId,
    accountLabel: ACCOUNT_LABEL[accountId],
    slots,
    deployment: deploymentPosture({
      paused: queue.paused,
      pauseReason: queue.pauseReason,
      credentialsConfigured: Boolean(row),
    }),
    credentialsConfigured: Boolean(row),
    account:
      row?.username && row.user_id
        ? {
            username: row.username,
            displayName: row.display_name || row.username,
            userId: row.user_id,
          }
        : null,
    queue,
    counts: { pending: activity.pending, posted: activity.posted, failed: activity.failed },
    activity,
    tweets: tweets.map((tweet) => toPublicTweet(tweet, row?.username ?? null)),
  };
}

export function importTweets(input: {
  accountId: unknown;
  source: string;
  format: "text" | "csv";
  startAt: string;
  intervalMinutes: number;
  randomMinSeconds?: number;
  randomMaxSeconds?: number;
  random?: () => number;
}): {
  ok: true;
  mode: ImportMode;
  queuedCount: number;
  queued: PublicTweet[];
  invalid: InvalidTweet[];
  longCount: number;
  omittedCount: number;
  batchLimit: number;
} {
  if (typeof input.source !== "string") {
    throw new AppError("invalid_text", "没有收到要导入的文本。");
  }
  const accountId = parseAccountId(input.accountId);
  if (input.source.length > MAX_IMPORT_SOURCE_CHARS) {
    throw new AppError("too_many", "文本太长，请分成几批导入。");
  }
  const format = input.format === "csv" ? "csv" : "text";
  const saved = getQueueSettings(accountId);
  const randomMinSeconds = input.randomMinSeconds ?? saved.randomMinSeconds;
  const randomMaxSeconds = input.randomMaxSeconds ?? saved.randomMaxSeconds;
  assertSchedule(input.intervalMinutes, randomMinSeconds, randomMaxSeconds);
  const start = assertStartAt(input.startAt);
  const parsed = parseImport(input.source, format);
  const valid: Array<{ text: string; weightedLength: number }> = [];
  const invalid: InvalidTweet[] = [];
  parsed.tweets.forEach((text, index) => {
    const inspected = inspectTweet(text);
    if (!inspected.valid) {
      invalid.push({
        index,
        text: inspected.text || text.trim(),
        weightedLength: inspected.weightedLength,
        reason: inspected.reason || "empty",
      });
      return;
    }
    valid.push({ text: inspected.text, weightedLength: inspected.weightedLength });
  });
  const omittedCount = Math.max(0, valid.length - MAX_IMPORT_BATCH);
  const accepted = valid.slice(0, MAX_IMPORT_BATCH);
  const times = computeSchedule({
    count: accepted.length,
    startAt: start,
    intervalMinutes: input.intervalMinutes,
    randomMinSeconds,
    randomMaxSeconds,
    random: input.random,
  });
  const now = new Date().toISOString();
  let order = nextSortOrder(accountId);
  const rows: Tweet[] = accepted.map((item, index) => ({
    id: crypto.randomUUID(),
    accountId,
    text: item.text,
    weightedLength: item.weightedLength,
    status: "pending",
    scheduledAt: times[index].toISOString(),
    postedAt: null,
    tweetId: null,
    errorMessage: null,
    errorKind: null,
    attemptCount: 0,
    sortOrder: order++,
    delayReason: null,
    createdAt: now,
    updatedAt: now,
  }));
  insertTweets(rows);
  patchQueueSettings(accountId, {
    intervalMinutes: input.intervalMinutes,
    randomMinSeconds,
    randomMaxSeconds,
  });
  const username = getCredentialsRow(accountId)?.username ?? null;
  return {
    ok: true,
    mode: parsed.mode,
    queuedCount: rows.length,
    queued: rows.map((row) => toPublicTweet(row, username)),
    invalid,
    longCount: rows.filter((row) => row.weightedLength > MAX_WEIGHTED_LENGTH).length,
    omittedCount,
    batchLimit: MAX_IMPORT_BATCH,
  };
}

export function updateTweetText(accountId: AccountId, id: string, text: unknown): PublicTweet {
  if (typeof text !== "string") throw new AppError("invalid_text", "帖子内容不能为空。");
  const existing = getTweet(id, accountId);
  if (!existing) throw new AppError("not_found", "这条帖子不在这个账号的队列里。", 404);
  if (existing.status === "posted") {
    throw new AppError("invalid_status", "已经发出的帖子不能再改。");
  }
  const inspected = inspectTweet(text);
  if (!inspected.valid) {
    throw new AppError(
      inspected.reason === "too_long" ? "too_long" : "invalid_text",
      inspected.reason === "too_long" ? `超过 ${MAX_LONG_POST_LENGTH} 字上限（现为 ${inspected.weightedLength}）。` : "帖子内容不能为空。",
    );
  }
  patchTweet(id, accountId, { text: inspected.text, weightedLength: inspected.weightedLength, errorMessage: null });
  const updated = getTweet(id, accountId);
  if (!updated) throw new AppError("not_found", "这条帖子不在这个账号的队列里。", 404);
  return toPublicTweet(updated, getCredentialsRow(accountId)?.username ?? null);
}

export function removeTweet(accountId: AccountId, id: string): { ok: true } {
  if (!deleteTweetRow(id, accountId)) throw new AppError("not_found", "这条帖子不在这个账号的队列里。", 404);
  return { ok: true };
}

export function retryTweet(accountId: AccountId, id: string, now = new Date()): PublicTweet {
  const existing = getTweet(id, accountId);
  if (!existing) throw new AppError("not_found", "这条帖子不在这个账号的队列里。", 404);
  if (existing.status !== "failed") {
    throw new AppError("invalid_status", "只有失败的帖子需要重试。");
  }
  patchTweet(id, accountId, {
    status: "pending",
    scheduledAt: now.toISOString(),
    errorMessage: null,
    errorKind: null,
    attemptCount: 0,
  });
  const updated = getTweet(id, accountId);
  if (!updated) throw new AppError("not_found", "这条帖子不在这个账号的队列里。", 404);
  return toPublicTweet(updated, getCredentialsRow(accountId)?.username ?? null);
}

export function retryAllFailed(accountId: AccountId, now = new Date(), random = Math.random): { ok: true; count: number } {
  const failed = listTweets(accountId).filter((tweet) => tweet.status === "failed");
  if (failed.length === 0) return { ok: true, count: 0 };
  const settings = getQueueSettings(accountId);
  const times = computeSchedule({
    count: failed.length,
    startAt: now,
    intervalMinutes: settings.intervalMinutes,
    randomMinSeconds: settings.randomMinSeconds,
    randomMaxSeconds: settings.randomMaxSeconds,
    random,
  });
  failed.forEach((tweet, index) => {
    patchTweet(tweet.id, accountId, {
      status: "pending",
      scheduledAt: times[index].toISOString(),
      errorMessage: null,
      errorKind: null,
      attemptCount: 0,
    });
  });
  return { ok: true, count: failed.length };
}

export function pendingInOrder(accountId: AccountId): Tweet[] {
  return listTweets(accountId)
    .filter((tweet) => tweet.status === "pending")
    .sort(compareTweets);
}

/** After a duplicate-content failure, fill that slot with the next pending tweet of the same account. */
export function promoteNextPendingToSlot(accountId: AccountId, slot: Date): string | null {
  const next = pendingInOrder(accountId)[0];
  if (!next) return null;
  const current = new Date(next.scheduledAt).getTime();
  const target = slot.getTime();
  if (Number.isNaN(current) || Number.isNaN(target)) return null;
  if (current <= target) return next.id;
  patchTweet(next.id, accountId, { scheduledAt: slot.toISOString(), delayReason: null });
  return next.id;
}

export function reorderTweet(accountId: AccountId, id: string, direction: "up" | "down"): { ok: true; moved: boolean } {
  if (direction !== "up" && direction !== "down") {
    throw new AppError("invalid_status", "只能上移或下移。");
  }
  const pending = pendingInOrder(accountId);
  const index = pending.findIndex((tweet) => tweet.id === id);
  if (index < 0) throw new AppError("invalid_status", "只能调整还没发出的帖子。");
  const neighbor = direction === "up" ? index - 1 : index + 1;
  if (neighbor < 0 || neighbor >= pending.length) return { ok: true, moved: false };
  const current = pending[index];
  const other = pending[neighbor];
  patchTweet(current.id, accountId, { scheduledAt: other.scheduledAt, sortOrder: other.sortOrder });
  patchTweet(other.id, accountId, { scheduledAt: current.scheduledAt, sortOrder: current.sortOrder });
  return { ok: true, moved: true };
}

export function pauseQueue(accountId: AccountId, reason = "manual"): { ok: true } {
  patchQueueSettings(accountId, { paused: true, pauseReason: reason });
  return { ok: true };
}

export function resumeQueue(accountId: AccountId): { ok: true } {
  const current = getQueueSettings(accountId);
  patchQueueSettings(accountId, {
    paused: false,
    pauseReason: null,
    ...(current.lastError === "auth" ? { lastError: null } : {}),
  });
  return { ok: true };
}

export function updateScheduleSettings(input: {
  accountId: unknown;
  intervalMinutes: number;
  randomMinSeconds?: number;
  randomMaxSeconds?: number;
  reschedule?: boolean;
  startAt?: string;
  random?: () => number;
}): { ok: true } {
  const accountId = parseAccountId(input.accountId);
  const current = getQueueSettings(accountId);
  const randomMinSeconds = input.randomMinSeconds ?? current.randomMinSeconds;
  const randomMaxSeconds = input.randomMaxSeconds ?? current.randomMaxSeconds;
  assertSchedule(input.intervalMinutes, randomMinSeconds, randomMaxSeconds);
  patchQueueSettings(accountId, {
    intervalMinutes: input.intervalMinutes,
    randomMinSeconds,
    randomMaxSeconds,
  });
  if (input.reschedule) {
    const pending = pendingInOrder(accountId);
    const start = input.startAt ? assertStartAt(input.startAt) : new Date();
    const times = computeSchedule({
      count: pending.length,
      startAt: start,
      intervalMinutes: input.intervalMinutes,
      randomMinSeconds,
      randomMaxSeconds,
      random: input.random,
    });
    pending.forEach((tweet, index) => {
      patchTweet(tweet.id, accountId, { scheduledAt: times[index].toISOString(), delayReason: null });
    });
  }
  return { ok: true };
}

function currentPace(accountId: AccountId): SchedulePace {
  const settings = getQueueSettings(accountId);
  return {
    intervalMinutes: settings.intervalMinutes,
    randomMinSeconds: settings.randomMinSeconds,
    randomMaxSeconds: settings.randomMaxSeconds,
  };
}

/** Move a chain of pending posts later (never earlier); returns true when anything moved. */
function applyChain(
  accountId: AccountId,
  tweets: Tweet[],
  firstMinAt: Date,
  random: () => number,
  extra?: Partial<Pick<Tweet, "delayReason">>,
): boolean {
  if (tweets.length === 0) return false;
  const originals = tweets.map((tweet) => new Date(tweet.scheduledAt));
  const times = pushChain({ originals, firstMinAt, pace: currentPace(accountId), random });
  let moved = false;
  tweets.forEach((tweet, index) => {
    if (times[index].getTime() === originals[index].getTime()) return;
    moved = true;
    patchTweet(tweet.id, accountId, { scheduledAt: times[index].toISOString(), ...(extra ?? {}) });
  });
  return moved;
}

export function delayPendingForRecentPost(
  accountId: AccountId,
  lastPostAt: Date,
  manual: boolean,
  random: () => number = Math.random,
): Date | null {
  const pending = pendingInOrder(accountId);
  if (pending.length === 0) return null;
  const pace = currentPace(accountId);
  const firstAt = new Date(pending[0].scheduledAt).getTime();
  if (Number.isNaN(firstAt) || firstAt >= lastPostAt.getTime() + pace.intervalMinutes * 60_000) return null;
  const target = new Date(lastPostAt.getTime() + nextGapMs(pace, random));
  applyChain(accountId, pending, target, random, manual ? { delayReason: "manual" } : undefined);
  return new Date(pendingInOrder(accountId)[0].scheduledAt);
}

export function reanchorPendingToManual(
  accountId: AccountId,
  manualAt: Date,
  random: () => number = Math.random,
): Date | null {
  const pending = pendingInOrder(accountId);
  if (pending.length === 0) return null;
  const pace = currentPace(accountId);
  const times = computeSchedule({
    count: pending.length,
    startAt: new Date(Math.ceil((manualAt.getTime() + nextGapMs(pace, random)) / 1000) * 1000),
    ...pace,
    random,
  });
  pending.forEach((tweet, index) => {
    patchTweet(tweet.id, accountId, { scheduledAt: times[index].toISOString(), delayReason: "manual" });
  });
  return times[0];
}

export function delayPendingForRateLimit(accountId: AccountId, until: Date, random: () => number = Math.random): void {
  const pending = pendingInOrder(accountId);
  applyChain(accountId, pending, new Date(until.getTime() + randomExtraMs(currentPace(accountId), random)), random);
}

export function latestLocalPost(accountId: AccountId): { id: string; at: Date } | null {
  const posted = listTweets(accountId).filter((tweet) => tweet.status === "posted" && tweet.postedAt);
  if (posted.length === 0) return null;
  posted.sort((left, right) => right.postedAt!.localeCompare(left.postedAt!));
  const newest = posted[0];
  const at = new Date(newest.postedAt!);
  if (Number.isNaN(at.getTime())) return null;
  return { id: newest.tweetId ?? "", at };
}

export function deferExtraOverdue(accountId: AccountId, now: Date, random = Math.random): void {
  const pending = pendingInOrder(accountId);
  const overdue = pending.filter((tweet) => new Date(tweet.scheduledAt).getTime() <= now.getTime());
  if (overdue.length <= 1) return;
  applyChain(accountId, pending.slice(1), new Date(now.getTime() + nextGapMs(currentPace(accountId), random)), random);
}

export function nextDueTweet(accountId: AccountId, now: Date): Tweet | null {
  return (
    listTweets(accountId)
      .filter((tweet) => tweet.status === "pending" && new Date(tweet.scheduledAt).getTime() <= now.getTime())
      .sort(compareTweets)[0] ?? null
  );
}

function compareTweets(a: Tweet, b: Tweet): number {
  const time = a.scheduledAt.localeCompare(b.scheduledAt);
  if (time !== 0) return time;
  return a.sortOrder - b.sortOrder;
}

/** Queue a thread (head + replies, optional images per post) as ONE queue item at `startAt`. */
export function queueThread(input: { accountId: unknown; posts: unknown; startAt: string }): { ok: true; queued: PublicTweet } {
  const accountId = parseAccountId(input.accountId);
  if (!Array.isArray(input.posts) || input.posts.length === 0 || input.posts.length > 25) {
    throw new AppError("invalid_text", "线程需要 1 到 25 条帖子。");
  }
  const posts = input.posts.map((raw, index) => {
    const item = (raw ?? {}) as { text?: unknown; media?: unknown };
    if (typeof item.text !== "string") throw new AppError("invalid_text", `第 ${index + 1} 条没有文字。`);
    const inspected = inspectTweet(item.text);
    if (!inspected.valid) {
      throw new AppError("invalid_text", `第 ${index + 1} 条不合规（${inspected.reason}，${inspected.weightedLength}）。`);
    }
    const media = Array.isArray(item.media) ? item.media.filter((m): m is string => typeof m === "string") : [];
    if (media.length > 4) throw new AppError("invalid_text", `第 ${index + 1} 条媒体超过 4 个。`);
    const allowedMedia = /\.(jpe?g|png|webp|gif|mp4|mov)$/i;
    for (const file of media) {
      if (!file.startsWith("/") || !fs.existsSync(file)) throw new AppError("invalid_text", `找不到媒体文件：${file}`);
      if (!allowedMedia.test(file)) throw new AppError("invalid_text", `不支持的媒体格式：${file}`);
    }
    return { text: inspected.text, weightedLength: inspected.weightedLength, media };
  });
  const start = assertStartAt(input.startAt);
  const [head, ...rest] = posts;
  const now = new Date().toISOString();
  const row: Tweet = {
    id: crypto.randomUUID(),
    accountId,
    text: head.text,
    weightedLength: head.weightedLength,
    status: "pending",
    scheduledAt: start.toISOString(),
    postedAt: null,
    tweetId: null,
    errorMessage: null,
    errorKind: null,
    attemptCount: 0,
    sortOrder: nextSortOrder(accountId),
    delayReason: null,
    extra: {
      media: head.media,
      thread: rest.map((post) => ({ text: post.text, media: post.media, tweetId: null })),
      headTweetId: null,
    },
    createdAt: now,
    updatedAt: now,
  };
  insertTweets([row]);
  return { ok: true, queued: toPublicTweet(row, getCredentialsRow(accountId)?.username ?? null) };
}
