/**
 * Shared helpers for every script that FOLLOWS on X (followback.mjs + keywordfollow.mjs).
 *  - combined daily follow cap (Asia/Shanghai day), counted from both logs
 *  - shared 15-minute window for POST /2/users/:id/following (X limit 50/15 min, we stop at 45)
 *  - a cross-process mutex so the check-cap -> follow -> log step is atomic between daemons
 *  - a shared "stop following for today" flag (set on account-level 403 follow limits)
 *  - automation.config.json (on/off toggles, keywords, caps) edited by the 序帖 UI
 * Never touches credentials directly (that stays in unfollow.mjs: loadCredentials).
 */
import fs from "node:fs";
import path from "node:path";
import { dayKey, sleep } from "./unfollow.mjs";

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
  unfollow: { enabled: true, perRun: 15, dailyCap: 50 },
  followback: { enabled: true },
  keywordfollow: {
    enabled: true,
    keywords: ["AI", "人工智能", "商业", "创业", "crypto", "币圈", "dating", "约会", "两性", "情感"],
    poolSize: 250,
    maxFollowers: 1000,
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
