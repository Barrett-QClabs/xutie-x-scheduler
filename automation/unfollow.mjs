#!/usr/bin/env node
/**
 * Unfollow plan (rules 2026-10-24): ALL non-blue-V accounts the user follows (mutual or not) + blue-V accounts
 * that do not follow back (except the 400 most recent follows). Blue-V mutuals are never unfollowed.
 * Uses OAuth 1.0a credentials
 * stored (encrypted) by 序帖 at /workspace/xutie-x-scheduler.
 *
 * Usage:
 *   node unfollow.mjs [--dry-run] [N]
 *   N defaults to 15.
 *
 * Never prints secret credential values.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Runtime data (logs, cache, locks, whitelist) live in DATA_DIR, code may live elsewhere (序帖 repo automation/).
const DATA_DIR = process.env.X_AUTOMATION_DIR || "/workspace/x-unfollow";
const SCHEDULER_ROOT = process.env.XUTIE_ROOT || "/workspace/xutie-x-scheduler";
const ENV_PATH = path.join(SCHEDULER_ROOT, ".env.local");
const DB_PATH = path.join(SCHEDULER_ROOT, "data", "xqueue.sqlite");
const CACHE_PATH = path.join(DATA_DIR, "cache.json");
const ME_CACHE_PATH = path.join(DATA_DIR, "me-cache.json");
const WHITELIST_PATH = path.join(DATA_DIR, "whitelist.txt");
const LOG_PATH = path.join(DATA_DIR, "log.jsonl");
const FB_LOG_PATH = path.join(DATA_DIR, "followback.jsonl");
const KW_LOG_PATH = path.join(DATA_DIR, "keywordfollow.jsonl");
const API_BASE = "https://api.x.com";
/** Full following+followers refresh at most once per 7 days; otherwise deltas + headFollowers. */
export const FULL_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Reuse cache on 429/503 if younger than this. */
const CACHE_FALLBACK_MS = 6 * 60 * 60 * 1000;
const USER_FIELDS = "verified,verified_type,public_metrics,username,protected";
const PAGE_SIZE = 1000;
/** Pre-action user lookups (follow re-check / unfollow blue-V re-check) batch this many ids per GET /2/users. */
export const USER_LOOKUP_BATCH = 14;
const PROTECT_TOP_N = 0; // 2026-10-24: removed at user request (400-most-recent blue-V guard covers new follows)
// Rules 2026-10-24: whitelist.txt + the first PROTECT_TOP_N of the following list (most recent first) are
// always untouchable. The first PROTECT_RECENT_N (400) only protect BLUE-V non-mutuals (time to follow back);
// non-blue-V accounts are unfollowed regardless of recency. Blue-V mutuals are never unfollowed.
const PROTECT_RECENT_N = 400;
// Additionally, daily snapshots of following IDs are kept; anyone present now but absent
// from the most recent snapshot of a PREVIOUS day is a new follow today -> protected.
const SNAP_DIR = path.join(DATA_DIR, "following-snapshots");
const DAILY_CAP = 100;    // max successful unfollows per calendar day (Asia/Shanghai)
const CAP_TZ = "Asia/Shanghai";

// --- CLI ---
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const nArg = args.find((a) => a !== "--dry-run" && /^\d+$/.test(a));
const LIMIT = nArg ? Number(nArg) : 15;

// --- env / crypto (mirror 序帖 lib/crypto.ts) ---
function loadEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function passphrase(env) {
  const value = (env.CREDENTIALS_ENCRYPTION_KEY ?? "").trim();
  if (value.length < 16) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY missing or too short in .env.local");
  }
  return value;
}

function decryptString(payload, secret) {
  const buffer = Buffer.from(payload, "base64");
  if (buffer.length < 16 + 12 + 16 + 1) throw new Error("ciphertext too short");
  const salt = buffer.subarray(0, 16);
  const iv = buffer.subarray(16, 28);
  const tag = buffer.subarray(28, 44);
  const encrypted = buffer.subarray(44);
  const key = crypto.scryptSync(secret, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function loadCredentials() {
  const env = loadEnv(ENV_PATH);
  const secret = passphrase(env);
  const db = new DatabaseSync(DB_PATH);
  const row = db.prepare("SELECT ciphertext, username, user_id FROM credentials WHERE id = 1").get();
  db.close();
  if (!row?.ciphertext) throw new Error("No credentials row in 序帖 SQLite");
  const plain = JSON.parse(decryptString(row.ciphertext, secret));
  for (const k of ["apiKey", "apiSecret", "accessToken", "accessTokenSecret"]) {
    if (typeof plain[k] !== "string" || !plain[k]) {
      throw new Error(`Decrypted credentials missing field: ${k}`);
    }
  }
  return {
    credentials: plain,
    storedUsername: row.username ?? null,
    storedUserId: row.user_id ?? null,
  };
}

// --- OAuth 1.0a (mirror 序帖 lib/oauth.ts) ---
export function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function buildAuthorizationHeader({ method, url, credentials, extraParams }) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const oauth = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };
  const signed = { ...oauth, ...(extraParams ?? {}) };
  const parameterString = Object.keys(signed)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(signed[key])}`)
    .join("&");
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(parameterString)].join("&");
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  const headerParams = { ...oauth, oauth_signature: signature };
  const header = `OAuth ${Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(", ")}`;
  return header;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 402 (credits depleted): back off 5–10 min instead of retrying every minute. */
export function creditsBackoffMs() {
  return 5 * 60_000 + Math.floor(Math.random() * 5 * 60_000);
}

/** Cached GET /2/users/me (user id rarely changes). Falls back to storedUserId from credentials. */
export async function getMe(credentials, stored = {}) {
  try {
    const cached = JSON.parse(fs.readFileSync(ME_CACHE_PATH, "utf8"));
    if (cached?.id && cached?.username && Date.now() - Date.parse(cached.fetchedAt || 0) < 7 * 86400_000) {
      return { id: cached.id, username: cached.username, fromCache: true };
    }
  } catch {}
  if (stored.storedUserId && stored.storedUsername) {
    // Prefer live confirm once; if that fails later, still usable.
  }
  const meRes = await xRequest(credentials, "GET", "/2/users/me", { "user.fields": "id,username,name" });
  if (!meRes.ok) {
    if (stored.storedUserId && stored.storedUsername) {
      return { id: stored.storedUserId, username: stored.storedUsername, fromCache: true, stale: true };
    }
    const err = new Error(`GET /2/users/me failed: HTTP ${meRes.status} ${extractErrorMessage(meRes.body)}`);
    err.status = meRes.status;
    throw err;
  }
  const me = meRes.body.data;
  try { fs.writeFileSync(ME_CACHE_PATH, JSON.stringify({ id: me.id, username: me.username, name: me.name, fetchedAt: new Date().toISOString() })); } catch {}
  return { id: me.id, username: me.username, name: me.name, fromCache: false };
}

/**
 * Batch GET /2/users?ids=... (up to USER_LOOKUP_BATCH). Returns Map id -> user, or null on failure.
 * user.fields defaults include connection_status for follow/unfollow re-checks.
 */
export async function lookupUsers(credentials, ids, userFields = "connection_status,verified,verified_type,public_metrics,protected,username,name,description") {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const out = new Map();
  for (let i = 0; i < unique.length; i += USER_LOOKUP_BATCH) {
    const batch = unique.slice(i, i + USER_LOOKUP_BATCH);
    const res = await xRequest(credentials, "GET", "/2/users", { ids: batch.join(","), "user.fields": userFields });
    if (!res.ok) {
      const err = new Error(`GET /2/users failed: HTTP ${res.status} ${extractErrorMessage(res.body)}`);
      err.status = res.status;
      err.rate = res.rate;
      throw err;
    }
    for (const u of res.body?.data ?? []) out.set(u.id, u);
  }
  return out;
}

function readJsonlLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Apply follow/unfollow logs since cache.deltaThrough onto following list (idempotent). */
export function applyListDeltas(cache) {
  if (!cache || !Array.isArray(cache.following)) return cache;
  const since = cache.deltaThrough ? Date.parse(cache.deltaThrough) : 0;
  const following = cache.following.slice();
  const byId = new Map(following.map((u, i) => [u.id, i]));
  let changed = false;
  for (const file of [FB_LOG_PATH, KW_LOG_PATH]) {
    for (const e of readJsonlLines(file)) {
      if (!e?.id || e.result !== "ok" || e.pending) continue;
      const t = e.time ? Date.parse(e.time) : 0;
      if (t && t <= since) continue;
      if (byId.has(e.id)) continue;
      const u = { id: e.id, username: e.username ?? "", verified: true, verified_type: e.verified_type ?? "blue",
        public_metrics: { followers_count: e.followers ?? 0 }, protected: !!e.protected };
      following.unshift(u);
      byId.set(e.id, 0);
      changed = true;
    }
  }
  for (const e of readJsonlLines(LOG_PATH)) {
    if (!e?.id || e.result !== "ok") continue;
    const t = e.time ? Date.parse(e.time) : 0;
    if (t && t <= since) continue;
    const idx = byId.get(e.id);
    if (idx === undefined) continue;
    following[idx] = null;
    byId.delete(e.id);
    changed = true;
  }
  if (changed) cache.following = following.filter(Boolean);
  cache.deltaThrough = new Date().toISOString();
  return cache;
}

/**
 * Fetch newest followers pages (100 each) until we hit a known follower id, then merge new ones at front.
 * Stops early so we don't re-read the whole followers list every cycle.
 */
export async function pageFollowersHead(credentials, userId, knownFollowerIds, maxPages = 5) {
  const known = knownFollowerIds instanceof Set ? knownFollowerIds : new Set(knownFollowerIds ?? []);
  const newest = [];
  let paginationToken = undefined;
  let pages = 0;
  let lastRate = null;
  let hitKnown = false;
  // Empty known set: fetch a single page as a seed (caller should full-refresh instead when possible).
  const pageLimit = known.size === 0 ? 1 : maxPages;
  while (pages < pageLimit && !hitKnown) {
    const query = { max_results: "100", "user.fields": USER_FIELDS };
    if (paginationToken) query.pagination_token = paginationToken;
    const res = await xRequest(credentials, "GET", `/2/users/${encodeURIComponent(userId)}/followers`, query);
    lastRate = res.rate;
    if (!res.ok) {
      const err = new Error(`followers head fetch failed: HTTP ${res.status} ${extractErrorMessage(res.body)}`);
      err.status = res.status; err.rate = res.rate; err.body = res.body; throw err;
    }
    pages += 1;
    const page = Array.isArray(res.body?.data) ? res.body.data : [];
    for (const u of page) {
      if (known.has(u.id)) { hitKnown = true; break; }
      newest.push(u);
    }
    if (known.size === 0) { hitKnown = true; break; }
    paginationToken = res.body?.meta?.next_token;
    if (!paginationToken) { hitKnown = true; break; }
    await sleep(300);
  }
  return { newest, pages, rate: lastRate, hitKnown };
}


function rateHeaders(response) {
  return {
    limit: response.headers.get("x-rate-limit-limit"),
    remaining: response.headers.get("x-rate-limit-remaining"),
    reset: response.headers.get("x-rate-limit-reset"),
  };
}

export async function xRequest(credentials, method, apiPath, query, reqBody) {
  // Hard guard for followback (and any process that sets NO_PAID_READS=1): block all
  // paid developer API GETs. Writes (POST follow / DELETE unfollow / posting) remain OK.
  if (process.env.NO_PAID_READS === "1" && String(method).toUpperCase() === "GET") {
    const err = new Error(`NO_PAID_READS: blocked paid GET ${apiPath} (use free X plugin / file targets)`);
    err.status = 0;
    err.code = "NO_PAID_READS";
    throw err;
  }
  const url = `${API_BASE}${apiPath}`;
  const header = buildAuthorizationHeader({
    method,
    url,
    credentials,
    extraParams: query,
  });
  const queryString = query
    ? `?${Object.entries(query)
        .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
        .join("&")}`
    : "";
  const response = await fetch(`${url}${queryString}`, {
    method,
    headers: {
      Authorization: header,
      Accept: "application/json",
      "User-Agent": "x-unfollow/0.1",
      ...(reqBody ? { "Content-Type": "application/json" } : {}),
    },
    body: reqBody ? JSON.stringify(reqBody) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
    rate: rateHeaders(response),
  };
}

export function extractErrorMessage(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.detail === "string") return body.detail;
  if (typeof body.title === "string") return body.title;
  if (Array.isArray(body.errors) && body.errors[0]) {
    const e = body.errors[0];
    if (typeof e.message === "string") return e.message;
    if (typeof e.detail === "string") return e.detail;
  }
  return JSON.stringify(body).slice(0, 300);
}

export function isBlueV(user) {
  // Strict: ANY verification signal counts as blue-V and is never unfollowed.
  const vt = (user.verified_type ?? "").toLowerCase();
  if (user.verified === true) return true;
  if (vt && vt !== "none") return true;
  return false;
}

export function dayKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAP_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function countTodayUnfollows() {
  if (!fs.existsSync(LOG_PATH)) return 0;
  const today = dayKey(new Date());
  let n = 0;
  for (const line of fs.readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.result === "ok" && dayKey(new Date(e.time)) === today) n += 1; } catch {}
  }
  return n;
}

export function loadAlreadyUnfollowedIds() {
  const ids = new Set();
  if (!fs.existsSync(LOG_PATH)) return ids;
  for (const line of fs.readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.result === "ok" && e.id) ids.add(e.id); } catch {}
  }
  return ids;
}

export function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return new Set();
  return new Set(
    fs
      .readFileSync(WHITELIST_PATH, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
  );
}

export function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function saveCache(cache) {
  // atomic write: unfollow + followback may both refresh the shared cache
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_PATH);
}

function appendLog(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
}

export async function pageUsers(credentials, kind, userId) {
  // kind: "following" | "followers"
  const users = [];
  let paginationToken = undefined;
  let pages = 0;
  let lastRate = null;
  while (true) {
    const query = {
      max_results: String(PAGE_SIZE),
      "user.fields": USER_FIELDS,
    };
    if (paginationToken) query.pagination_token = paginationToken;
    const res = await xRequest(
      credentials,
      "GET",
      `/2/users/${encodeURIComponent(userId)}/${kind}`,
      query,
    );
    lastRate = res.rate;
    if (!res.ok) {
      const err = new Error(
        `${kind} fetch failed: HTTP ${res.status} ${extractErrorMessage(res.body)}`,
      );
      err.status = res.status;
      err.rate = res.rate;
      err.body = res.body;
      throw err;
    }
    pages += 1;
    if (Array.isArray(res.body?.data)) {
      for (const u of res.body.data) users.push(u);
    }
    paginationToken = res.body?.meta?.next_token;
    if (!paginationToken) break;
    // brief pause between pages to be gentle
    await sleep(500);
  }
  return { users, pages, rate: lastRate };
}

/**
 * Shared following+followers cache for unfollow + follow-back.
 * Full refresh at most once per 7 days; otherwise apply local deltas from follow/unfollow logs.
 * opts.headFollowers: also pull newest follower pages until a known id (for follow-back).
 * opts.forceFull: force a full refresh now.
 */
export async function fetchListsOrCache(credentials, userId, opts = {}) {
  const existing = loadCache();
  let cache = existing && existing.userId === userId ? { ...existing, following: [...(existing.following ?? [])], followers: [...(existing.followers ?? [])] } : null;
  if (cache) applyListDeltas(cache);

  const fullAt = cache?.fullRefreshAt ? Date.parse(cache.fullRefreshAt) : 0;
  const needFull = opts.forceFull || !cache || !cache.following?.length || !cache.followers?.length || (Date.now() - fullAt) >= FULL_REFRESH_MS;

  if (needFull) {
    try {
      const following = await pageUsers(credentials, "following", userId);
      const followers = await pageUsers(credentials, "followers", userId);
      cache = {
        timestamp: new Date().toISOString(),
        fullRefreshAt: new Date().toISOString(),
        deltaThrough: new Date().toISOString(),
        userId,
        following: following.users,
        followers: followers.users,
        meta: {
          followingPages: following.pages,
          followersPages: followers.pages,
          followingRate: following.rate,
          followersRate: followers.rate,
          mode: "full",
        },
      };
      saveCache(cache);
      return { ...cache, fromCache: false, mode: "full" };
    } catch (err) {
      const age = existing?.timestamp ? Date.now() - Date.parse(existing.timestamp) : Infinity;
      if (existing && age < CACHE_FALLBACK_MS && (err.status === 429 || err.status === 503 || err.status === 402)) {
        console.error(`[warn] ${err.message}; reusing cache from ${existing.timestamp} (age ${Math.round(age / 60000)}m)`);
        const reused = { ...existing };
        applyListDeltas(reused);
        saveCache(reused);
        return { ...reused, fromCache: true, cacheWarning: err.message, mode: "fallback" };
      }
      throw err;
    }
  }

  // Incremental: optional head-of-followers for new follow-backs
  if (opts.headFollowers) {
    try {
      const known = new Set((cache.followers ?? []).map((u) => u.id));
      const head = await pageFollowersHead(credentials, userId, known);
      if (head.newest.length) {
        const seen = new Set();
        const merged = [];
        for (const u of [...head.newest, ...(cache.followers ?? [])]) {
          if (!u?.id || seen.has(u.id)) continue;
          seen.add(u.id);
          merged.push(u);
        }
        cache.followers = merged;
        cache.timestamp = new Date().toISOString();
        cache.meta = { ...(cache.meta ?? {}), lastHeadPages: head.pages, lastHeadNew: head.newest.length, mode: "delta+head" };
      } else {
        cache.meta = { ...(cache.meta ?? {}), lastHeadPages: head.pages, lastHeadNew: 0, mode: "delta" };
      }
    } catch (err) {
      if (err.status === 402 || err.status === 429 || err.status === 503) {
        console.error(`[warn] followers head: ${err.message}; continuing with delta-only cache`);
        cache.cacheWarning = err.message;
      } else throw err;
    }
  }

  cache.timestamp = cache.timestamp ?? new Date().toISOString();
  saveCache(cache);
  return { ...cache, fromCache: true, mode: cache.meta?.mode ?? "delta" };
}

export function newTodayIds(following) {
  // Save today's snapshot (first write of the day wins as the "start of day" baseline is
  // the previous day's file; we overwrite today's file to keep it current).
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const today = dayKey(new Date());
  const ids = following.map((u) => u.id);
  const prev = fs.readdirSync(SNAP_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < `${today}.json`).sort().pop();
  const out = new Set();
  if (prev) {
    const old = new Set(JSON.parse(fs.readFileSync(path.join(SNAP_DIR, prev), "utf8")));
    for (const id of ids) if (!old.has(id)) out.add(id);
  }
  // Union with existing today snapshot so earlier-today follows stay recorded
  const todayPath = path.join(SNAP_DIR, `${today}.json`);
  let merged = ids;
  if (fs.existsSync(todayPath)) { try { merged = [...new Set([...JSON.parse(fs.readFileSync(todayPath, "utf8")), ...ids])]; } catch {} }
  fs.writeFileSync(todayPath, JSON.stringify(merged));
  return { ids: out, baseline: prev ?? null };
}

export function protectedRecentIds(following, _newIds) {
  // Always-untouchable set: first PROTECT_TOP_N (20). (Snapshots still written, no longer used for protection.)
  return new Set(following.slice(0, PROTECT_TOP_N).map((u) => u.id));
}

// Plan = (A) every non-blue-V followed account (mutual or not, recent or not)
//      + (B) blue-V accounts that do NOT follow back, outside the first PROTECT_RECENT_N follows.
// Blue-V mutuals never. Order: all of A oldest-first, then B oldest-first.
function classifyNonMutual(following, followers, whitelist, skipIds, protectedTop) {
  const followerIds = new Set(followers.map((u) => u.id));
  const recentBlueGuard = new Set(following.slice(0, PROTECT_RECENT_N).map((u) => u.id));
  const nonBlue = [];
  const blueNonMutual = [];
  let blueMutual = 0;
  let blueRecentProtected = 0;
  let whitelisted = 0;
  let mutualInPlan = 0;
  let protectedCount = 0;
  for (const u of following) {
    if (!u?.id) continue;
    if (protectedTop.has(u.id)) { protectedCount += 1; continue; }
    if (skipIds.has(u.id)) continue; // already unfollowed per log (matters when using cache)
    if (whitelist.has((u.username ?? "").toLowerCase())) { whitelisted += 1; continue; }
    const mutual = followerIds.has(u.id);
    const base = { id: u.id, username: u.username ?? "", mutual, verified: !!u.verified, verified_type: u.verified_type ?? null };
    if (isBlueV(u)) {
      if (mutual) { blueMutual += 1; continue; }                          // blue-V mutual: NEVER
      if (recentBlueGuard.has(u.id)) { blueRecentProtected += 1; continue; } // recent: time to follow back
      blueNonMutual.push({ ...base, blueV: true });
    } else {
      if (mutual) mutualInPlan += 1;
      nonBlue.push({ ...base, blueV: false });
    }
  }
  // following list is reverse-chronological -> reverse for oldest-followed first
  nonBlue.reverse();
  blueNonMutual.reverse();
  return { ordered: [...nonBlue, ...blueNonMutual], nonBlueCount: nonBlue.length, blueNonMutualCount: blueNonMutual.length,
    blueMutual, blueRecentProtected, whitelisted, mutualInPlan, protectedCount };
}

// Fresh connection_status for up to USER_LOOKUP_BATCH blue-V targets before DELETEs.
async function freshFollowsBackBatch(credentials, ids) {
  try {
    const map = await lookupUsers(credentials, ids, "connection_status,verified,verified_type,username");
    const out = new Map();
    for (const id of ids) {
      const u = map.get(id);
      if (!u) out.set(id, { ok: true, gone: true });
      else out.set(id, { ok: true, followsBack: (u.connection_status ?? []).includes("followed_by"), blueV: isBlueV(u), user: u });
    }
    return { ok: true, map: out };
  } catch (err) {
    return { ok: false, status: err.status, error: err.message };
  }
}

async function unfollowOne(credentials, sourceUserId, target) {
  const res = await xRequest(
    credentials,
    "DELETE",
    `/2/users/${encodeURIComponent(sourceUserId)}/following/${encodeURIComponent(target.id)}`,
  );
  return res;
}

// Random batch pacing (user rule 2026-10-25 14:16): within each hourly run, unfollows go out
// in random batches of 3-5 (never more than 5 per batch), random 25-70s gaps inside a batch,
// random 6-14 min rest between batches; at most 10 per hour (whole run fits in ~55 min).
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const BATCH_ENDS = (() => {
  const ends = new Set(); let total = 0;
  while (total < 10) { total += Math.min(rnd(3, 5), 10 - total); ends.add(total); }
  return ends;
})();
function randomPauseMs(doneSoFar) {
  if (BATCH_ENDS.has(doneSoFar)) return rnd(6 * 60_000, 14 * 60_000); // rest between batches
  return rnd(25_000, 70_000); // gap inside a batch
}

const LOCK_PATH = path.join(DATA_DIR, "run.lock");
function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const pid = Number(fs.readFileSync(LOCK_PATH, "utf8").trim());
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
    if (alive) return false;
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  const release = () => { try { if (fs.readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) fs.unlinkSync(LOCK_PATH); } catch {} };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { release(); process.exit(130); });
  return true;
}

async function main() {
  if (!dryRun && !acquireLock()) {
    console.log(JSON.stringify({ ok: true, skipped: "another run is still in progress (run.lock)" }));
    return;
  }
  const { credentials, storedUsername, storedUserId } = loadCredentials();

  let me;
  try {
    me = await getMe(credentials, { storedUserId, storedUsername });
  } catch (err) {
    console.log(JSON.stringify({ ok: false, authType: "OAuth 1.0a user context", error: err.message }, null, 2));
    process.exit(1);
  }
  const userId = me.id;
  if (storedUsername && me.username && storedUsername.toLowerCase() !== me.username.toLowerCase()) {
    console.error(`[warn] stored username ${storedUsername} != me ${me.username}`);
  }

  const lists = await fetchListsOrCache(credentials, userId);
  const whitelist = loadWhitelist();
  const newToday = newTodayIds(lists.following);
  const protectedIds = protectedRecentIds(lists.following, newToday.ids);
  const { ordered, nonBlueCount, blueNonMutualCount, blueMutual, blueRecentProtected, whitelisted, mutualInPlan, protectedCount } = classifyNonMutual(
    lists.following,
    lists.followers,
    whitelist,
    loadAlreadyUnfollowedIds(),
    protectedIds,
  );

  const todayCount = countTodayUnfollows();
  try {
    const inPlan = nonBlueCount + blueNonMutualCount;
    fs.writeFileSync(path.join(DATA_DIR, "unfollow-plan.json"), JSON.stringify({
      updated: new Date().toISOString(),
      rule: "all non-blue-V (mutual or not) + blue-V non-mutual outside the 400 most recent; blue-V mutual never",
      cacheTimestamp: lists.timestamp, following: lists.following.length, inPlan,
      nonBlueV: nonBlueCount, nonBlueVMutual: mutualInPlan, blueVNonMutual: blueNonMutualCount,
      mutualInPlan, blueVMutualNever: blueMutual, blueVRecentProtected: blueRecentProtected, whitelisted,
      protectedTop20: protectedCount, dailyCap: DAILY_CAP, daysAtCap: Math.ceil(inPlan / DAILY_CAP),
    }, null, 2));
  } catch {}
  const allowed = Math.max(0, Math.min(LIMIT, DAILY_CAP - todayCount));
  // a few spares so a skipped blue-V (now follows back) doesn't shrink the run; DELETE attempts stay <= allowed
  const targets = ordered.slice(0, allowed > 0 ? allowed + 10 : 0);
  let attempts = 0;
  const unfollowed = [];
  const errors = [];
  let lastDeleteRate = null;
  let stoppedReason = null;

  if (!dryRun) {
    // Prefetch blue-V re-checks in batches of USER_LOOKUP_BATCH; act at normal ~3 min pace.
    let freshCache = new Map(); // id -> {ok, followsBack, gone, blueV}
    let freshPrefetchIdx = 0;
    async function ensureFresh(fromIdx) {
      const need = [];
      for (let j = fromIdx; j < targets.length && need.length < USER_LOOKUP_BATCH; j++) {
        const t = targets[j];
        if (!t.blueV) continue;
        if (freshCache.has(t.id)) continue;
        need.push(t.id);
      }
      if (!need.length) return true;
      const batch = await freshFollowsBackBatch(credentials, need);
      if (!batch.ok) {
        if (batch.status === 402) {
          const w = creditsBackoffMs();
          console.error(`[warn] blue-V re-check 402; backing off ${Math.round(w / 1000)}s`);
          await sleep(w);
        }
        return false;
      }
      for (const [id, v] of batch.map) freshCache.set(id, v);
      return true;
    }
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      // Safety re-checks before every DELETE
      if (protectedIds.has(target.id) || whitelist.has(target.username.toLowerCase()) || (target.blueV && target.mutual)) {
        throw new Error(`safety check refused to unfollow ${target.username}`);
      }
      if (attempts >= allowed) break;
      if (countTodayUnfollows() >= DAILY_CAP) { stoppedReason = "daily_cap_reached"; break; }
      if (target.blueV) {
        if (!freshCache.has(target.id)) {
          const ok = await ensureFresh(i);
          if (!ok) { stoppedReason = "recheck_failed"; break; }
        }
        const fresh = freshCache.get(target.id);
        if (!fresh || fresh.followsBack || fresh.gone) {
          console.error(`[info] skip blue-V ${target.username}: ${!fresh ? "re-check missing" : fresh.gone ? "gone" : "now follows back"}`);
          continue;
        }
      }
      attempts += 1;
      const res = await unfollowOne(credentials, userId, target);
      lastDeleteRate = res.rate;
      const entry = {
        time: new Date().toISOString(),
        username: target.username,
        id: target.id,
        blueV: target.blueV,
        mutual: !!target.mutual,
        result: res.ok ? "ok" : `HTTP ${res.status}`,
        detail: res.ok ? null : extractErrorMessage(res.body),
        rate: res.rate,
      };
      appendLog(entry);
      console.error(`[${entry.time}] ${target.username} -> ${entry.result} (rate remaining ${res.rate.remaining}/${res.rate.limit}, reset ${res.rate.reset})`);

      if (res.ok) {
        // DELETE following returns { data: { following: false } } on success
        unfollowed.push({ username: target.username, id: target.id, blueV: target.blueV, mutual: target.mutual });
      } else if (res.status === 401 || res.status === 403 || res.status === 429) {
        errors.push({
          username: target.username,
          id: target.id,
          status: res.status,
          message: extractErrorMessage(res.body),
          rate: res.rate,
          body: res.body,
        });
        stoppedReason =
          res.status === 429
            ? "rate_limit"
            : res.status === 401
              ? "unauthorized"
              : "forbidden";
        break;
      } else {
        errors.push({
          username: target.username,
          id: target.id,
          status: res.status,
          message: extractErrorMessage(res.body),
          rate: res.rate,
        });
        // continue on other errors (e.g. already unfollowed)
      }

      if (i < targets.length - 1 && attempts < allowed) {
        const pause = randomPauseMs(attempts);
        console.error(`[info] paused ${Math.round(pause / 1000)}s before next unfollow`);
        await sleep(pause);
      }
    }
  }

  // Remaining after this run (approximate: subtract successful unfollows)
  const unfollowedIds = new Set(unfollowed.map((u) => u.id));
  const remainingOrdered = ordered.filter((u) => !unfollowedIds.has(u.id));
  const remainingNonBlue = remainingOrdered.filter((u) => !u.blueV).length;
  const remainingBlue = remainingOrdered.filter((u) => u.blueV).length;

  const summary = {
    ok: errors.length === 0 || (unfollowed.length > 0 && stoppedReason !== "unauthorized" && stoppedReason !== "forbidden"),
    dryRun,
    authType: "OAuth 1.0a user context (apiKey, apiSecret, accessToken, accessTokenSecret from 序帖 encrypted SQLite)",
    me: { id: userId, username: me.username, name: me.name },
    stored: { username: storedUsername, userId: storedUserId },
    fromCache: !!lists.fromCache,
    cacheTimestamp: lists.timestamp,
    cacheWarning: lists.cacheWarning ?? null,
    counts: {
      following: lists.following.length,
      followers: lists.followers.length,
      planTotal: nonBlueCount + blueNonMutualCount,
      planNonBlueV: nonBlueCount,
      planNonBlueVMutual: mutualInPlan,
      planBlueVNonMutual: blueNonMutualCount,
      blueVMutual_neverUnfollowed: blueMutual,
      blueVNonMutual_recent400Protected: blueRecentProtected,
      whitelisted,
      protectedTop20: protectedCount,
      whitelistSize: whitelist.size,
    },
    remainingAfterRun: {
      nonBlueV: remainingNonBlue,
      blueVNonMutual: remainingBlue,
    },
    plannedThisRun: targets.slice(0, allowed).map((t) => ({
      username: t.username,
      id: t.id,
      blueV: t.blueV,
      mutual: !!t.mutual,
    })),
    unfollowedThisRun: unfollowed,
    errors,
    stoppedReason,
    deleteRateLimit: lastDeleteRate,
    limit: LIMIT,
    dailyCap: { cap: DAILY_CAP, tz: CAP_TZ, doneTodayBeforeRun: todayCount, allowedThisRun: allowed },
    protectTopN: PROTECT_TOP_N,
    protectRecentN: PROTECT_RECENT_N,
    newFollowsTodaySeen: newToday.ids.size,
    snapshotBaseline: newToday.baseline,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (stoppedReason === "forbidden" || stoppedReason === "unauthorized") {
    process.exit(2);
  }
}

export { CACHE_PATH, LOG_PATH, CAP_TZ, PROTECT_TOP_N };

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main().catch((err) => {
  const summary = {
    ok: false,
    fatal: true,
    error: err.message,
    status: err.status ?? null,
    rate: err.rate ?? null,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
});
