/**
 * Unfollow "inactive 24h" rule (user 2026-10-29 16:55 Asia/Taipei):
 * accounts I follow with NO original posts AND NO replies in the last 24 consecutive hours
 * join the unfollow pool (after political-unfollow.txt; before existing non-blue / blue-V tiers).
 *
 * Evidence from FREE reads only (x / user-X MCP), same lookup shape as write-last-post.mjs:
 *   get_users_by_usernames ≤25/batch, user.fields=most_recent_tweet_id,
 *   expansions=most_recent_tweet_id, post.fields=created_at,referenced_tweets,in_reply_to_user_id
 *
 * "Active" = most recent tweet of ANY kind (original, reply, quote, or retweet) within windowHours.
 * Retweet-only inside the window counts as active (conservative; saves a search fallback).
 * "Inactive" = no most_recent_tweet_id, or its created_at older than windowHours at check time.
 *
 * State: DATA_DIR/following-activity.json (incremental; oldest-checked first, ~checksPerDay/day).
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_WINDOW_H = 24;
export const DEFAULT_CHECKS_PER_DAY = 300;
export const DEFAULT_MIN_FOLLOW_AGE_H = 24;
/** How long a check may age before we stop trusting it for the unfollow pool. */
export const DEFAULT_STALE_H = 72;
export const LOOKUP_BATCH = 25; // free-read max results/call (locked rule)

const DATA_DIR = process.env.X_AUTOMATION_DIR || "/workspace/x-unfollow";
export const ACTIVITY_PATH = path.join(DATA_DIR, "following-activity.json");
export const ACTIVITY_PAGES_DIR = path.join(DATA_DIR, "plugin-pages", "following-activity");

export function inactiveCfg(cfg) {
  const u = cfg?.unfollow?.inactive24h ?? {};
  const on = u.enabled !== false;
  const windowHours = Number(u.windowHours ?? DEFAULT_WINDOW_H);
  const checksPerDay = Number(u.checksPerDay ?? DEFAULT_CHECKS_PER_DAY);
  const minFollowAgeHours = Number(u.minFollowAgeHours ?? DEFAULT_MIN_FOLLOW_AGE_H);
  const staleHours = Number(u.staleHours ?? DEFAULT_STALE_H);
  return {
    enabled: on,
    windowHours: Number.isFinite(windowHours) && windowHours > 0 ? windowHours : DEFAULT_WINDOW_H,
    checksPerDay: Number.isFinite(checksPerDay) && checksPerDay > 0 ? checksPerDay : DEFAULT_CHECKS_PER_DAY,
    minFollowAgeHours: Number.isFinite(minFollowAgeHours) && minFollowAgeHours > 0 ? minFollowAgeHours : DEFAULT_MIN_FOLLOW_AGE_H,
    staleHours: Number.isFinite(staleHours) && staleHours > 0 ? staleHours : DEFAULT_STALE_H,
  };
}

export function loadActivityState() {
  try {
    const s = JSON.parse(fs.readFileSync(ACTIVITY_PATH, "utf8"));
    if (s && typeof s === "object") {
      if (!s.accounts || typeof s.accounts !== "object") s.accounts = {};
      return s;
    }
  } catch {}
  return { updated: null, windowHours: DEFAULT_WINDOW_H, accounts: {} };
}

export function saveActivityState(state) {
  state.updated = new Date().toISOString();
  const tmp = `${ACTIVITY_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, ACTIVITY_PATH);
}

const ms = (s) => { const v = Date.parse(s ?? ""); return Number.isFinite(v) ? v : null; };

/** Classify one account row from following-activity.json right now. */
export function inactiveStatus(row, cfg, now = Date.now()) {
  const { windowHours, staleHours } = inactiveCfg(cfg);
  if (!row?.checked_at) return { state: "unchecked", lastAnyAt: null, why: "not checked yet" };
  const checked = ms(row.checked_at);
  if (!checked || now - checked > staleHours * 3600_000) {
    return { state: "stale", lastAnyAt: ms(row.last_any_at), why: "check stale" };
  }
  const at = ms(row.last_any_at);
  if (at && now - at <= windowHours * 3600_000) {
    return { state: "active", lastAnyAt: at, why: `last any post/reply ${new Date(at).toISOString()}` };
  }
  return {
    state: "inactive",
    lastAnyAt: at,
    why: at ? `last any post/reply ${new Date(at).toISOString()}` : "no posts/replies found",
  };
}

/**
 * Ids currently flagged inactive-24h for the unfollow plan (fresh check, no activity in window).
 * Map id -> { username, lastAnyAt, checkedAt, why }
 */
export function loadInactive24hMap(cfg, now = Date.now()) {
  const out = new Map();
  if (!inactiveCfg(cfg).enabled) return out;
  const state = loadActivityState();
  for (const [id, row] of Object.entries(state.accounts ?? {})) {
    const st = inactiveStatus(row, cfg, now);
    if (st.state !== "inactive") continue;
    out.set(String(id), {
      username: row.username ?? "",
      lastAnyAt: st.lastAnyAt,
      checkedAt: row.checked_at,
      why: st.why,
    });
  }
  return out;
}

/** true when the post is ONLY a retweet (not original / reply / quote). */
export function isRetweetOnly(t) {
  if (!t) return false;
  const refs = Array.isArray(t.referenced_tweets) ? t.referenced_tweets : [];
  if (refs.some((r) => r?.type === "retweeted") || /^RT @/i.test(String(t.text ?? ""))) {
    // pure RT (not a quote): quotes have type "quoted"
    if (refs.some((r) => r?.type === "quoted")) return false;
    if (t.in_reply_to_user_id || refs.some((r) => r?.type === "replied_to")) return false;
    return true;
  }
  return false;
}

/** Kind label for most_recent tweet. */
export function mostRecentKind(t) {
  if (!t) return "none";
  if (isRetweetOnly(t)) return "retweet";
  const refs = Array.isArray(t.referenced_tweets) ? t.referenced_tweets : [];
  if (t.in_reply_to_user_id || refs.some((r) => r?.type === "replied_to") || /^\s*@\w/.test(String(t.text ?? ""))) return "reply";
  if (refs.some((r) => r?.type === "quoted")) return "quote";
  return "original";
}

/** ids followed within the last N hours (followback + keywordfollow logs). */
export function recentlyFollowedIds(hours = DEFAULT_MIN_FOLLOW_AGE_H, now = Date.now(), dataDir = DATA_DIR) {
  const cut = now - hours * 3600_000;
  const ids = new Set();
  for (const name of ["followback.jsonl", "keywordfollow.jsonl"]) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e?.id || e.result !== "ok" || !e.time) continue;
      const t = Date.parse(e.time);
      if (Number.isFinite(t) && t >= cut) ids.add(String(e.id));
    }
  }
  return ids;
}
