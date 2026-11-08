import type { AccountId } from "@/lib/account";
import { audienceFor } from "@/lib/automation-account";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { reserveView } from "@/lib/follow-queue";
import { FOLLOW_DAILY_CAP } from "@/lib/unfollow-policy";
import { followEnabled } from "@/lib/automation-account";

/** Production shared list, kept on account 1 only. */
export const ACCOUNT1_KEYWORDS = ["AI", "人工智能", "商业", "创业", "crypto", "币圈", "dating", "约会", "两性", "情感"];

/** Same themes in English. Follow-back words are not keywords. */
export const ACCOUNT2_KEYWORDS = ["AI", "artificial intelligence", "business", "entrepreneurship", "crypto", "dating", "relationships"];

export function defaultKeywords(accountId: AccountId): string[] {
  return accountId === 1 ? [...ACCOUNT1_KEYWORDS] : [...ACCOUNT2_KEYWORDS];
}

export function ensureFollowConfig(accountId: AccountId): void {
  const existing = getDb().prepare("SELECT account_id FROM follow_account_config WHERE account_id = ?").get(accountId);
  if (existing) return;
  getDb()
    .prepare(`INSERT INTO follow_account_config (account_id, keywords_json, updated_at) VALUES (?, ?, ?)`)
    .run(accountId, JSON.stringify(defaultKeywords(accountId)), new Date().toISOString());
}

export function getFollowConfig(accountId: AccountId, now = new Date()) {
  ensureFollowConfig(accountId);
  const row = getDb()
    .prepare("SELECT keywords_json, updated_at FROM follow_account_config WHERE account_id = ?")
    .get(accountId) as { keywords_json: string; updated_at: string };
  const control = getDb()
    .prepare("SELECT paused FROM follow_control WHERE account_id = ?")
    .get(accountId) as { paused: number } | undefined;
  const reserve = reserveView(accountId, now);
  return {
    accountId,
    scope: "account" as const,
    shared: false,
    accountScoped: true,
    audience: audienceFor(accountId),
    keywords: JSON.parse(row.keywords_json) as string[],
    updatedAt: row.updated_at,
    savesDoNotStart: true,
    enabled: followEnabled(accountId),
    paused: control?.paused !== 0,
    running: followEnabled(accountId) && control?.paused === 0,
    dailyCap: FOLLOW_DAILY_CAP,
    reserve,
  };
}

export function saveFollowConfig(accountId: AccountId, keywords: unknown) {
  if (!Array.isArray(keywords) || keywords.some((item) => typeof item !== "string")) {
    throw new AppError("invalid_keywords", "关键词必须是字符串数组。");
  }
  const clean = [...new Set(keywords.map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 40))];
  if (!clean.length) throw new AppError("invalid_keywords", "至少保留一个关键词。");
  ensureFollowConfig(accountId);
  getDb()
    .prepare("UPDATE follow_account_config SET keywords_json = ?, updated_at = ? WHERE account_id = ?")
    .run(JSON.stringify(clean), new Date().toISOString(), accountId);
  return getFollowConfig(accountId);
}
