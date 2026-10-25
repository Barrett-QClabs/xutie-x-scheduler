/**
 * Shared helpers for every script that FOLLOWS on X (followback.mjs + keywordfollow.mjs).
 *  - combined daily follow cap (Asia/Shanghai day), counted from both logs
 *  - ONE shared work/rest pace: ≤10 successful follows total (keyword + follow-back) per work window,
 *    then a shared rest of 10–15 min (random) with ZERO follows from either daemon, then repeat.
 *    Follow-back of blue-V followers gets priority for the 10 slots; keyword new people fill what is left
 *    in the same window (priority swapped 2026-10-24 21:04 Asia/Taipei).
 *  - shared X 15-minute window for POST /2/users/:id/following (X limit 50/15 min, we stop at 45)
 *  - a cross-process mutex so the check-cap -> follow -> log step is atomic between daemons
 *  - a shared "stop following for today" flag (set on account-level 403 follow limits)
 *  - automation.config.json (on/off toggles, keywords, caps) edited by the 序帖 UI
 * Never touches credentials directly (that stays in unfollow.mjs: loadCredentials).
 */
import fs from "node:fs";
import path from "node:path";
import { dayKey, sleep, isBlueV, loadAlreadyUnfollowedIds } from "./unfollow.mjs";

export const DATA_DIR = process.env.X_AUTOMATION_DIR || "/workspace/x-unfollow";
export const FB_LOG = path.join(DATA_DIR, "followback.jsonl");
export const KW_LOG = path.join(DATA_DIR, "keywordfollow.jsonl");
export const FB_STATUS = path.join(DATA_DIR, "followback.status.json");
export const KW_STATUS = path.join(DATA_DIR, "keywordfollow.status.json");
export const CONFIG_PATH = path.join(DATA_DIR, "automation.config.json");
const MUTEX = path.join(DATA_DIR, "follow.mutex");
const STOP_FLAG = path.join(DATA_DIR, "follow-stop.json");

export const WINDOW_MS = 15 * 60_000;
export const WINDOW_MAX = 45; // X allows 50 follows / 15 min per user; keep 5 spare

export const DEFAULT_CONFIG = {
  unfollow: { enabled: true, perRun: 10, dailyCap: 100 },
  followback: { enabled: true },
  keywordfollow: {
    enabled: true,
    keywords: ["AI", "人工智能", "ChatGPT", "大模型", "AIGC", "Claude", "商业", "创业", "赚钱", "副业", "投资", "电商", "两性", "恋爱", "婚姻", "情感", "男女", "约会"],
    categories: ["AI", "商业", "两性"],
    poolSize: 250,
    maxFollowers: 1000, // inclusive: followers_count ≤ maxFollowers (user rule 2026-10-25)
    maxSearchPages: 40,
  },
  combinedFollowDailyCap: 350,
};

export function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch {}
  const out = {
    ...DEFAULT_CONFIG, ...c,
    unfollow: { ...DEFAULT_CONFIG.unfollow, ...(c.unfollow ?? {}) },
    followback: { ...DEFAULT_CONFIG.followback, ...(c.followback ?? {}) },
    keywordfollow: { ...DEFAULT_CONFIG.keywordfollow, ...(c.keywordfollow ?? {}) },
  };
  if (!fs.existsSync(CONFIG_PATH)) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2)); } catch {} }
  return out;
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/** Successful follows today (Asia/Shanghai) per source + combined. */
export function followCountsToday() {
  const today = dayKey(new Date());
  const n = (f) => readJsonl(f).filter((e) => e.result === "ok" && e.time && dayKey(new Date(e.time)) === today).length;
  const followback = n(FB_LOG), keyword = n(KW_LOG);
  return { followback, keyword, combined: followback + keyword };
}

/** Follow POST attempts in the last 15 min across both daemons, and the earliest moment a slot frees up. */
export function windowState() {
  const since = Date.now() - WINDOW_MS;
  const times = [...readJsonl(FB_LOG), ...readJsonl(KW_LOG)]
    .filter((e) => e.time && e.result !== "skipped" && Date.parse(e.time) > since)
    .map((e) => Date.parse(e.time)).sort((a, b) => a - b);
  // honour the most recent rate header / 429 seen by either daemon
  let resetAt = 0;
  for (const e of [...readJsonl(FB_LOG).slice(-5), ...readJsonl(KW_LOG).slice(-5)]) {
    const reset = Number(e.rate?.reset) * 1000;
    const rem = Number(e.rate?.remaining);
    if (Number.isFinite(reset) && reset > Date.now() && (e.result === "HTTP 429" || (Number.isFinite(rem) && rem <= 2))) resetAt = Math.max(resetAt, reset + 5_000);
  }
  const freeAt = times.length >= WINDOW_MAX ? times[times.length - WINDOW_MAX] + WINDOW_MS + 5_000 : 0;
  return { used: times.length, waitUntil: Math.max(freeAt, resetAt) };
}

export function msUntilNextShanghaiMidnight() {
  const now = Date.now();
  const sh = new Date(now + 8 * 3600_000);
  return Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() + 1) - 8 * 3600_000 - now + 60_000;
}

export function stopFlagToday() {
  const f = readJson(STOP_FLAG);
  return f && f.day === dayKey(new Date()) ? f : null;
}
export function setStopFlag(by, reason) {
  fs.writeFileSync(STOP_FLAG, JSON.stringify({ day: dayKey(new Date()), time: new Date().toISOString(), by, reason }, null, 2));
}

function pidAlive(pid) { try { return pid > 0 && (process.kill(pid, 0), true); } catch { return false; } }

/** Cross-process mutex around "check cap -> POST follow -> append log". */
export async function withFollowMutex(fn) {
  const deadline = Date.now() + 5 * 60_000;
  while (true) {
    try {
      const fd = fs.openSync(MUTEX, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() })); fs.closeSync(fd);
      break;
    } catch {
      const m = readJson(MUTEX);
      if (!m || !pidAlive(m.pid) || Date.now() - m.t > 3 * 60_000) { try { fs.unlinkSync(MUTEX); } catch {} continue; }
      if (Date.now() > deadline) throw new Error("follow mutex timeout");
      await sleep(1_000);
    }
  }
  try { return await fn(); }
  finally { try { if (readJson(MUTEX)?.pid === process.pid) fs.unlinkSync(MUTEX); } catch {} }
}

/** Wait (outside the mutex) until the shared 15-min window has room. */
export async function waitForWindow(onWait) {
  while (true) {
    const w = windowState();
    if (w.waitUntil <= Date.now()) return;
    onWait?.(w);
    await sleep(Math.min(w.waitUntil - Date.now(), 5 * 60_000));
  }
}

// ---------------------------------------------------------------------------------------------
// Priority (since 2026-10-24 21:04 Asia/Taipei): FOLLOW-BACK of blue-V followers goes first;
// keyword follow of new people (250 pool) gets the rest. (Before that, keyword had priority.)
// ---------------------------------------------------------------------------------------------
// Shared follow pace (since 2026-10-24): both daemons share ONE work/rest cycle.
//   work: ≤ PACE_CYCLE successful follows total (follow-back first, keyword fills), ~75–105 s apart
//   rest: PACE_REST_MIN–PACE_REST_MAX minutes with ZERO follows of any kind, then repeat
// Follow-back reserves daily room via followbackReserve so keyword cannot starve pending follow-backs.
// ---------------------------------------------------------------------------------------------
export const PACE_CYCLE = 10;
export const PACE_REST_MS = () => 10 * 60_000 + Math.floor(Math.random() * 5 * 60_000); // 10–15 min
export const PACE_GAP_MS = () => 75_000 + Math.floor(Math.random() * 30_001); // ~90s ±15s
export const FB_PACE_MS = 30 * 60_000; // for daily followbackReserve time budget (~10 / 30 min)
export const POOL_DIR = path.join(DATA_DIR, "keyword-candidates");
const PACE_FILE = path.join(DATA_DIR, "follow-pace.json");

function pidAliveOf(status) { return !!status?.pid && pidAlive(status.pid); }

function writePace(o) {
  try { fs.writeFileSync(PACE_FILE, JSON.stringify(o, null, 2)); } catch {}
}

/** Count successful follows (both logs) since `sinceMs` (exclusive of rest). */
function okFollowsSince(sinceMs) {
  const n = (file) => readJsonl(file).filter((e) => e.result === "ok" && e.time && Date.parse(e.time) > sinceMs).length;
  return n(FB_LOG) + n(KW_LOG);
}

/**
 * Shared work/rest state.
 *  - phase "rest": both daemons must sleep until waitUntil (no follows).
 *  - phase "work": remaining slots in this window (0..PACE_CYCLE).
 * Starts a rest the first time used hits PACE_CYCLE (or when beginSharedRest is called).
 */
export function sharedPace() {
  const pace = readJson(PACE_FILE) || {};
  const restUntil = pace.restUntil ? Date.parse(pace.restUntil) : 0;
  if (restUntil > Date.now()) {
    return { phase: "rest", used: PACE_CYCLE, remaining: 0, waitUntil: restUntil, workStartedAt: pace.workStartedAt ?? null };
  }
  // After rest ends (or first boot): open a fresh work window so we do NOT count older follows.
  if (!pace.workStartedAt || (pace.restUntil && Date.parse(pace.workStartedAt) <= restUntil)) {
    const started = new Date().toISOString();
    writePace({ workStartedAt: started, restUntil: null });
    return { phase: "work", used: 0, remaining: PACE_CYCLE, waitUntil: 0, workStartedAt: started };
  }
  const used = okFollowsSince(Date.parse(pace.workStartedAt));
  if (used >= PACE_CYCLE) {
    return { phase: "full", used, remaining: 0, waitUntil: 0, workStartedAt: pace.workStartedAt };
  }
  return { phase: "work", used, remaining: PACE_CYCLE - used, waitUntil: 0, workStartedAt: pace.workStartedAt };
}

/** Start the shared rest (10–15 min). Idempotent if already resting. */
export function beginSharedRest(by = "unknown") {
  const cur = readJson(PACE_FILE) || {};
  if (cur.restUntil && Date.parse(cur.restUntil) > Date.now()) {
    return { restUntil: cur.restUntil, ms: Date.parse(cur.restUntil) - Date.now() };
  }
  const ms = PACE_REST_MS();
  const restUntil = new Date(Date.now() + ms).toISOString();
  writePace({ workStartedAt: cur.workStartedAt ?? null, restUntil, restStartedAt: new Date().toISOString(), restMs: ms, by });
  return { restUntil, ms };
}

/** Open a new work window after rest (or on first start). */
export function beginSharedWork() {
  const started = new Date().toISOString();
  writePace({ workStartedAt: started, restUntil: null });
  return { workStartedAt: started };
}

/** Sleep through shared rest; when rest ends, start a fresh work window. */
export async function waitForSharedWork(onWait) {
  while (true) {
    let p = sharedPace();
    if (p.phase === "full") {
      const r = beginSharedRest("pace-full");
      p = { phase: "rest", used: PACE_CYCLE, remaining: 0, waitUntil: Date.parse(r.restUntil) };
    }
    if (p.phase === "rest") {
      onWait?.(p);
      await sleep(Math.min(Math.max(1_000, p.waitUntil - Date.now()), 5 * 60_000));
      continue;
    }
    // work phase — if rest just ended and workStartedAt is still old, roll a new window
    const pace = readJson(PACE_FILE) || {};
    if (pace.restUntil && Date.parse(pace.restUntil) <= Date.now() && pace.workStartedAt && Date.parse(pace.workStartedAt) < Date.parse(pace.restUntil)) {
      beginSharedWork();
      return sharedPace();
    }
    return p;
  }
}

/**
 * Follow-back targets still waiting, computed from cache.json the same way followback.mjs does:
 * followers I do not follow, blue-V only, never unfollowed by us (log.jsonl), not already followed
 * (ok/pending) by follow-back or keyword follow.
 */
export function followbackTargetsFromCache() {
  // Prefer plugin-produced followback-targets.json (zero paid reads). Fall back to cache.json.
  const gone = new Set();
  for (const id of loadAlreadyUnfollowedIds()) gone.add(id);
  for (const e of readJsonl(FB_LOG)) if (e.id && (e.result === "ok" || e.pending)) gone.add(e.id);
  for (const e of readJsonl(KW_LOG)) if (e.id && (e.result === "ok" || e.pending)) gone.add(e.id);
  const file = readJson(path.join(DATA_DIR, "followback-targets.json"));
  const fileList = Array.isArray(file) ? file : (Array.isArray(file?.targets) ? file.targets : null);
  if (fileList) {
    return fileList.filter((u) => u?.id && !gone.has(u.id) && (isBlueV(u) || u.verified_type === "blue" || u.verified === true || (!u.verified_type && !("verified" in (u ?? {}))))).length;
  }
  const cache = readJson(path.join(DATA_DIR, "cache.json"));
  if (!cache?.followers) return null;
  for (const u of cache.following ?? []) gone.add(u.id);
  return cache.followers.filter((u) => u?.id && !gone.has(u.id) && isBlueV(u)).length;
}

/**
 * Daily room reserved for follow-back = what follow-back can still do today:
 *   min(blue-V follow-back targets still waiting (cache.json, capped by the daemon's own
 *       targetsRemaining when its status is fresh), 10 per 30 min until Shanghai midnight).
 * 0 when follow-back is off, stopped, or not running.
 */
export function followbackReserve(cfg = loadConfig()) {
  const counts = followCountsToday();
  if (!cfg.followback.enabled || stopFlagToday()) return { reserve: 0, why: cfg.followback.enabled ? "stopped for day" : "follow-back off", counts };
  const st = readJson(FB_STATUS);
  if (!st || !pidAliveOf(st)) return { reserve: 0, why: "follow-back not running", counts };
  if (["stopped_auth", "fatal", "disabled"].includes(st.state)) return { reserve: 0, why: `follow-back ${st.state}`, counts };
  let targets = followbackTargetsFromCache() ?? 0;
  const fresh = st.updated && Date.now() - Date.parse(st.updated) < 90 * 60_000;
  if (fresh && Number.isFinite(st.targetsRemaining)) targets = Math.min(targets, st.targetsRemaining);
  const byTime = Math.ceil(msUntilNextShanghaiMidnight() / FB_PACE_MS) * 10;
  return { reserve: Math.max(0, Math.min(targets, byTime)), targets, byTime, counts };
}

/**
 * May keyword follow take a slot in the current shared work window?
 * Follow-back has priority: keyword yields while follow-back still has blue-V targets and is
 * actively following / about to follow. Follow-back writes "window_yield" / "idle" when it has
 * nothing more for this window. During shared rest both wait via waitForSharedWork.
 */
export function followbackYieldsSlot(cfg = loadConfig()) {
  if (!cfg.followback.enabled) return { ok: true, why: "follow-back off" };
  if (stopFlagToday()) return { ok: true, why: "stopped" };
  const st = readJson(FB_STATUS);
  if (!st || !pidAliveOf(st)) return { ok: true, why: "follow-back not running" };
  if (["idle", "daily_cap", "disabled", "stopped_for_day", "fatal", "stopped_auth"].includes(st.state)) {
    return { ok: true, why: `follow-back ${st.state}` };
  }
  // Follow-back finished its share of this window (no more targets right now)
  if (st.state === "window_yield") return { ok: true, why: "follow-back window_yield" };
  // Nothing left for follow-back to do today
  if (followbackReserve(cfg).reserve <= 0) return { ok: true, why: "no follow-back targets" };
  // Still resting: waitForSharedWork handles it (rest ends for both at once; follow-back then goes first)
  if (st.state === "shared_rest" && st.resumeAt && Date.parse(st.resumeAt) > Date.now()) return { ok: true, why: "follow-back shared_rest" };
  // Stale status (daemon stuck somewhere without updating) — don't block keyword forever
  if (st.updated && Date.now() - Date.parse(st.updated) > 20 * 60_000) return { ok: true, why: `follow-back status stale (${st.state})` };
  // Actively following / rest just ended / waiting on X window → follow-back still wants slots
  return { ok: false, why: `follow-back ${st.state}`, retryAt: Date.now() + 45_000 };
}

// ---------------------------------------------------------------------------------------------
// CHINESE-ZONE (中文区) ONLY for keyword follow (rule 2026-10-24 23:11 Asia/Taipei:
// "250个，必须是中文区的，英文区的不关注"). Follow-back is NOT affected.
//
// A field (display name / bio / tweet text) "is Chinese" when, after removing @mentions, URLs and
// #hashtags' '#', it has ≥ 2 CJK Unified Ideographs (U+4E00–9FFF, Ext-A U+3400–4DBF, compat
// U+F900–FAFF) AND fewer than half as many Japanese kana (U+3040–30FF, U+31F0–31FF, U+FF66–FF9F)
// as ideographs — so Japanese names/bios (kana-heavy, or kana only) do not count.
// A candidate is Chinese-zone only if ALL of:
//   (1) the matched tweet's X language tag is "zh" (search also uses lang:zh), AND
//   (2) display name OR bio is Chinese (rule above); OR, only when name and bio contain NO CJK
//       ideographs at all, the matched tweet text is Chinese with ≥ 4 ideographs (fallback).
// Name/bio with ideographs or kana that fail the rule (Japanese, incl. kana-only) are rejected — no fallback.
// ---------------------------------------------------------------------------------------------
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu;
const KANA_RE = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/gu;
const clean = (s) => String(s ?? "").replace(/https?:\/\/\S+/g, " ").replace(/@\w+/g, " ");
export function cjkStats(s) {
  const t = clean(s);
  return { han: (t.match(HAN_RE) ?? []).length, kana: (t.match(KANA_RE) ?? []).length };
}
export function isChineseText(s, minHan = 2) {
  const { han, kana } = cjkStats(s);
  return han >= minHan && kana * 2 < han;
}
/** @returns {{ ok: boolean, why: string }} */
export function chineseZoneCheck({ tweetLang, name, bio, tweetText }) {
  if (tweetLang !== "zh") return { ok: false, why: `tweet lang ${tweetLang ?? "unknown"} != zh` };
  if (isChineseText(name)) return { ok: true, why: "name chinese" };
  if (isChineseText(bio)) return { ok: true, why: "bio chinese" };
  const n = cjkStats(name), b = cjkStats(bio);
  if (n.han + b.han + n.kana + b.kana > 0) return { ok: false, why: "name/bio CJK/kana but not chinese (japanese)" };
  if (isChineseText(tweetText, 4)) return { ok: true, why: "tweet text chinese (name/bio no CJK)" };
  return { ok: false, why: "no chinese in name/bio/tweet" };
}
