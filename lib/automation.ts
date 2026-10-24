/**
 * Read-only view + light control of the X follow/unfollow automation workers
 * (automation/*.mjs, runtime data in X_AUTOMATION_DIR, default /workspace/x-unfollow).
 * The workers run as their own Node processes; 序帖 only shows status, edits
 * automation.config.json and (re)starts daemons through their idempotent start scripts.
 * Never reads or returns credentials.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "@/lib/errors";

export const AUTOMATION_DIR = process.env.X_AUTOMATION_DIR || "/workspace/x-unfollow";
const TZ = "Asia/Shanghai";
const f = (name: string) => path.join(AUTOMATION_DIR, name);

type Json = Record<string, unknown>;
type LogEntry = { time?: string; result?: string; username?: string; id?: string; detail?: string | null; keyword?: string; pending?: boolean; followers?: number; [k: string]: unknown };

export interface AutomationConfig {
  unfollow: { enabled: boolean; perRun: number; dailyCap: number };
  followback: { enabled: boolean };
  keywordfollow: { enabled: boolean; keywords: string[]; poolSize: number; maxFollowers: number; maxSearchPages: number };
  combinedFollowDailyCap: number;
}

const DEFAULT_CONFIG: AutomationConfig = {
  unfollow: { enabled: true, perRun: 10, dailyCap: 100 },
  followback: { enabled: true },
  keywordfollow: {
    enabled: true,
    keywords: ["AI", "人工智能", "商业", "创业", "crypto", "币圈", "dating", "约会", "两性", "情感"],
    poolSize: 250, maxFollowers: 1000, maxSearchPages: 40,
  },
  combinedFollowDailyCap: 350,
};

function readJson<T = Json>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
function readJsonl(file: string): LogEntry[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as LogEntry; } catch { return null; } })
      .filter((e): e is LogEntry => !!e);
  } catch { return []; }
}
export function dayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function pidAlive(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}
function lockPid(name: string): number | null {
  try { const n = Number(fs.readFileSync(f(name), "utf8").trim()); return pidAlive(n) ? n : null; } catch { return null; }
}

export function getConfig(): AutomationConfig {
  const c = readJson<Partial<AutomationConfig>>(f("automation.config.json")) ?? {};
  return {
    ...DEFAULT_CONFIG, ...c,
    unfollow: { ...DEFAULT_CONFIG.unfollow, ...(c.unfollow ?? {}) },
    followback: { ...DEFAULT_CONFIG.followback, ...(c.followback ?? {}) },
    keywordfollow: { ...DEFAULT_CONFIG.keywordfollow, ...(c.keywordfollow ?? {}) },
  };
}

/** Only toggles and the keyword list are editable from the UI; caps stay as the agreed rules. */
export function updateConfig(patch: Json): AutomationConfig {
  const cfg = getConfig();
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const p = patch as { unfollow?: Json; followback?: Json; keywordfollow?: Json };
  const u = bool(p.unfollow?.enabled); if (u !== undefined) cfg.unfollow.enabled = u;
  const fb = bool(p.followback?.enabled); if (fb !== undefined) cfg.followback.enabled = fb;
  const kw = bool(p.keywordfollow?.enabled); if (kw !== undefined) cfg.keywordfollow.enabled = kw;
  const kws = p.keywordfollow?.keywords;
  if (kws !== undefined) {
    if (!Array.isArray(kws)) throw new AppError("invalid_keywords", "关键词格式不正确。");
    const clean = [...new Set(kws.map((k) => String(k).trim()).filter((k) => k.length > 0 && k.length <= 40 && !/["()]/.test(k)))].slice(0, 30);
    if (!clean.length) throw new AppError("invalid_keywords", "至少保留一个关键词。");
    cfg.keywordfollow.keywords = clean;
  }
  const file = f("automation.config.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return cfg;
}

const today = () => dayKey(new Date());
const okToday = (entries: LogEntry[]) => entries.filter((e) => e.result === "ok" && e.time && dayKey(new Date(e.time)) === today()).length;

export function getAutomationStatus() {
  const cfg = getConfig();
  const unfollowLog = readJsonl(f("log.jsonl"));
  const fbLog = readJsonl(f("followback.jsonl"));
  const kwLog = readJsonl(f("keywordfollow.jsonl"));
  const fbStatus = readJson(f("followback.status.json"));
  const kwStatus = readJson(f("keywordfollow.status.json"));
  const pool = readJson<{ date: string; count: number; target: number; built: string; error: unknown; perKeyword: unknown; postsRead: number; candidates: { id: string; username: string; followers_count: number; keyword: string }[] }>(f(`keyword-candidates/${today()}.json`));
  const stop = readJson<{ day: string; reason: string; by: string; time: string }>(f("follow-stop.json"));
  const counts = { unfollowed: okToday(unfollowLog), followedBack: okToday(fbLog), keywordFollowed: okToday(kwLog) };
  const kwTriedIds = new Set(kwLog.filter((e) => e.id).map((e) => e.id));
  const recent = (entries: LogEntry[], n: number) => entries.slice(-n).reverse().map((e) => ({
    time: e.time, username: e.username, result: e.result, pending: e.pending ?? false,
    detail: e.detail ?? null, keyword: e.keyword ?? null, followers: e.followers ?? null,
  }));
  let runOutTail: string[] = [];
  try { runOutTail = fs.readFileSync(f("run.out"), "utf8").split("\n").filter((l) => l.startsWith("[")).slice(-5); } catch {}
  const sinceWindow = Date.now() - 15 * 60_000;
  const windowUsed = [...fbLog, ...kwLog].filter((e) => e.time && e.result !== "skipped" && Date.parse(e.time) > sinceWindow).length;
  return {
    ok: true,
    day: today(), timezone: TZ, dir: AUTOMATION_DIR,
    config: cfg,
    caps: { combinedFollows: cfg.combinedFollowDailyCap, unfollows: cfg.unfollow.dailyCap, unfollowPerRun: cfg.unfollow.perRun, followWindow15m: 45 },
    counts: { ...counts, combinedFollows: counts.followedBack + counts.keywordFollowed },
    followWindow15m: windowUsed,
    stopForToday: stop && stop.day === today() ? stop : null,
    daemons: {
      unfollow: { running: lockPid("run.lock") !== null, pid: lockPid("run.lock"), kind: "hourly run (run.sh)", lastLines: runOutTail },
      followback: { running: lockPid("followback.lock") !== null, pid: lockPid("followback.lock"), status: fbStatus },
      keywordfollow: { running: lockPid("keywordfollow.lock") !== null, pid: lockPid("keywordfollow.lock"), status: kwStatus },
    },
    pool: pool ? { date: pool.date, count: pool.count, target: pool.target, built: pool.built, error: pool.error, postsRead: pool.postsRead,
      remaining: pool.candidates.filter((c) => !kwTriedIds.has(c.id)).length, perKeyword: pool.perKeyword,
      sample: pool.candidates.filter((c) => !kwTriedIds.has(c.id)).slice(0, 12).map((c) => ({ username: c.username, followers: c.followers_count, keyword: c.keyword })) } : null,
    recent: { unfollow: recent(unfollowLog, 15), followback: recent(fbLog, 15), keywordfollow: recent(kwLog.filter((e) => e.result !== "skipped"), 15) },
    unfollowPlan: readJson<{ updated: string; following: number; inPlan: number; nonBlueV: number; nonBlueVMutual: number; blueVNonMutual: number; mutualInPlan: number; blueVMutualNever: number; blueVRecentProtected: number; whitelisted: number; protectedTop20: number; dailyCap: number; daysAtCap: number }>(f("unfollow-plan.json")),
    rules: (() => { try { return fs.readFileSync(f("RULES.txt"), "utf8"); } catch { return ""; } })(),
  };
}

const START_SCRIPTS: Record<string, string> = { followback: "start-followback.sh", keywordfollow: "start-keywordfollow.sh" };

/** Idempotent start (the scripts exit if the daemon already runs). */
export function startDaemon(name: string): Promise<string> {
  const script = START_SCRIPTS[name];
  if (!script) throw new AppError("unknown_daemon", "未知的任务。");
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [f(script)], { cwd: AUTOMATION_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("close", () => resolve(out.trim().split("\n").pop() ?? ""));
    child.unref();
  });
}

/** Called from instrumentation: keep enabled daemons alive (every 5 min). */
let supervisor: NodeJS.Timeout | null = null;
export function startAutomationSupervisor() {
  if (supervisor || !fs.existsSync(AUTOMATION_DIR) || process.env.XUTIE_AUTOMATION_SUPERVISOR === "off") return;
  const tick = async () => {
    try {
      const cfg = getConfig();
      if (cfg.followback.enabled && lockPid("followback.lock") === null) console.log("[序帖] automation:", await startDaemon("followback"));
      if (cfg.keywordfollow.enabled && lockPid("keywordfollow.lock") === null) console.log("[序帖] automation:", await startDaemon("keywordfollow"));
    } catch (error) { console.error("[序帖] automation supervisor:", error instanceof Error ? error.message : error); }
  };
  setTimeout(tick, 15_000);
  supervisor = setInterval(tick, 5 * 60_000);
  supervisor.unref?.();
}
