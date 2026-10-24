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
const WHITELIST_PATH = path.join(DATA_DIR, "whitelist.txt");
const LOG_PATH = path.join(DATA_DIR, "log.jsonl");
const API_BASE = "https://api.x.com";
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h
const USER_FIELDS = "verified,verified_type,public_metrics,username,protected";
const PAGE_SIZE = 1000;
const PROTECT_TOP_N = 20; // never unfollow the 20 most-recently-followed accounts
// Rules 2026-10-24: whitelist.txt + the first PROTECT_TOP_N of the following list (most recent first) are
// always untouchable. The first PROTECT_RECENT_N (400) only protect BLUE-V non-mutuals (time to follow back);
// non-blue-V accounts are unfollowed regardless of recency. Blue-V mutuals are never unfollowed.
const PROTECT_RECENT_N = 400;
// Additionally, daily snapshots of following IDs are kept; anyone present now but absent
// from the most recent snapshot of a PREVIOUS day is a new follow today -> protected.
const SNAP_DIR = path.join(DATA_DIR, "following-snapshots");
const DAILY_CAP = 50;     // max successful unfollows per calendar day (Asia/Shanghai)
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

function rateHeaders(response) {
  return {
    limit: response.headers.get("x-rate-limit-limit"),
    remaining: response.headers.get("x-rate-limit-remaining"),
    reset: response.headers.get("x-rate-limit-reset"),
  };
}

export async function xRequest(credentials, method, apiPath, query, reqBody) {
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

export async function fetchListsOrCache(credentials, userId) {
  const existing = loadCache();
  const age = existing?.timestamp ? Date.now() - Date.parse(existing.timestamp) : Infinity;
  const freshEnough = age < CACHE_MAX_AGE_MS;

  try {
    const following = await pageUsers(credentials, "following", userId);
    const followers = await pageUsers(credentials, "followers", userId);
    const cache = {
      timestamp: new Date().toISOString(),
      userId,
      following: following.users,
      followers: followers.users,
      meta: {
        followingPages: following.pages,
        followersPages: followers.pages,
        followingRate: following.rate,
        followersRate: followers.rate,
      },
    };
    saveCache(cache);
    return { ...cache, fromCache: false };
  } catch (err) {
    if ((err.status === 429 || err.status === 503) && existing && freshEnough) {
      console.error(
        `[warn] ${err.message}; reusing cache from ${existing.timestamp} (age ${Math.round(age / 60000)}m)`,
      );
      return { ...existing, fromCache: true, cacheWarning: err.message };
    }
    // Also reuse any cache younger than 6h on any rate-limit-ish failure for those endpoints
    if (err.status === 429 && existing && freshEnough) {
      return { ...existing, fromCache: true, cacheWarning: err.message };
    }
    throw err;
  }
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

// Fresh connection_status right before a DELETE: a blue-V target that now follows back is skipped.
async function freshFollowsBack(credentials, id) {
  const res = await xRequest(credentials, "GET", "/2/users", { ids: id, "user.fields": "connection_status,verified,verified_type" });
  if (!res.ok) return { ok: false, rate: res.rate };
  const u = res.body?.data?.[0];
  if (!u) return { ok: true, gone: true };
  return { ok: true, followsBack: (u.connection_status ?? []).includes("followed_by"), blueV: isBlueV(u) };
}

async function unfollowOne(credentials, sourceUserId, target) {
  const res = await xRequest(
    credentials,
    "DELETE",
    `/2/users/${encodeURIComponent(sourceUserId)}/following/${encodeURIComponent(target.id)}`,
  );
  return res;
}

function randomPauseMs() {
  // ~180s ± 20s
  return 160_000 + Math.floor(Math.random() * 40_001);
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

  // GET /2/users/me
  const meRes = await xRequest(credentials, "GET", "/2/users/me", {
    "user.fields": "id,username,name",
  });
  if (!meRes.ok) {
    const summary = {
      ok: false,
      authType: "OAuth 1.0a user context (apiKey / apiSecret / accessToken / accessTokenSecret)",
      error: `GET /2/users/me failed: HTTP ${meRes.status} ${extractErrorMessage(meRes.body)}`,
      rate: meRes.rate,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  }
  const me = meRes.body.data;
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
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      // Safety re-checks before every DELETE
      if (protectedIds.has(target.id) || whitelist.has(target.username.toLowerCase()) || (target.blueV && target.mutual)) {
        throw new Error(`safety check refused to unfollow ${target.username}`);
      }
      if (attempts >= allowed) break;
      if (countTodayUnfollows() >= DAILY_CAP) { stoppedReason = "daily_cap_reached"; break; }
      if (target.blueV) {
        // blue-V non-mutual: confirm they still don't follow back (lists may be up to 6h old)
        const fresh = await freshFollowsBack(credentials, target.id);
        if (!fresh.ok || fresh.followsBack) {
          console.error(`[info] skip blue-V ${target.username}: ${fresh.ok ? "now follows back" : "re-check failed"}`);
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
        const pause = randomPauseMs();
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
