import type { AccountId } from "@/lib/account";
import { DAY_MINUTES, SETTINGS_LIMITS } from "@/lib/automation-settings-limits";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { canonicalTimeZone, shiftCivilDay, zonedClock, zonedDayRange } from "@/lib/zoned-clock";

export { SETTINGS_LIMITS };

/**
 * Persisted per-account automation settings. Execution reads these values; the compiled numbers
 * survive only as defaults for an account that has never saved settings.
 *
 * Windows are minute-of-day ranges in `scheduleTimezone`. `end < start` wraps past midnight and
 * `{ start: 0, end: 1440 }` is the whole day. A lane's work/rest grid restarts at `anchorMinute`
 * every civil day. A slot opens only on a grid start inside an allowed window and closes when the
 * work minutes end or the window closes, whichever comes first.
 */

export type TimeWindow = { start: number; end: number };

export type LaneCadence = {
  batchSize: number;
  workMinutes: number;
  restMinutes: number;
  anchorMinute: number;
  windows: TimeWindow[];
};

export type FollowLaneSettings = LaneCadence & { dailyCap: number };

/** `dailyCap: null` means the lane has no daily unfollow cap. */
export type UnfollowLaneSettings = LaneCadence & { dailyCap: number | null; directPool: boolean };

export type FollowFilters = {
  /** Require Blue Verified before any follow. */
  blueVerified: boolean;
  /** Require the account audience language (账号1 Chinese, 账号2 English) before a new follow. */
  language: boolean;
  /** Require a newest public post inside the recent-activity window before a new follow. */
  activity: boolean;
};

export type AutomationSettings = {
  /** Zone for windows, anchors, and slot keys. */
  scheduleTimezone: string;
  /** Zone whose midnight resets daily quotas and the daily stats counters. */
  quotaTimezone: string;
  /** When on, follow and unfollow windows must not overlap, and neither lane runs inside the other's window. */
  mutualExclusion: boolean;
  follow: FollowLaneSettings;
  unfollow: UnfollowLaneSettings;
  filters: FollowFilters;
};

export type AutomationLane = "follow" | "unfollow";

/** Today's compiled behavior. 账号1 runs on Taipei; 账号2 keeps the Taipei slot grid and the London quota day. */
function defaults(accountId: AccountId): AutomationSettings {
  if (accountId === 1) {
    return {
      scheduleTimezone: "Asia/Taipei",
      quotaTimezone: "Asia/Taipei",
      mutualExclusion: true,
      follow: { batchSize: 13, dailyCap: 350, workMinutes: 15, restMinutes: 18, anchorMinute: 540, windows: [{ start: 540, end: 300 }] },
      unfollow: { batchSize: 10, dailyCap: 80, directPool: false, workMinutes: 30, restMinutes: 0, anchorMinute: 15, windows: [{ start: 300, end: 540 }] },
      filters: { blueVerified: true, language: true, activity: false },
    };
  }
  return {
    scheduleTimezone: "Asia/Taipei",
    quotaTimezone: "Europe/London",
    mutualExclusion: false,
    follow: { batchSize: 10, dailyCap: 380, workMinutes: 15, restMinutes: 15, anchorMinute: 0, windows: [{ start: 0, end: DAY_MINUTES }] },
    unfollow: { batchSize: 10, dailyCap: null, directPool: false, workMinutes: 30, restMinutes: 0, anchorMinute: 15, windows: [{ start: 300, end: 540 }] },
    filters: { blueVerified: true, language: true, activity: false },
  };
}

export function defaultAutomationSettings(accountId: AccountId): AutomationSettings {
  return defaults(accountId);
}

type Issue = { field: string; message: string };

const TOP_KEYS = new Set(["timezone", "scheduleTimezone", "quotaTimezone", "mutualExclusion", "follow", "unfollow", "filters"]);
const LANE_KEYS = new Set(["batchSize", "dailyCap", "directPool", "workMinutes", "restMinutes", "anchorMinute", "windows"]);
const FILTER_KEYS = new Set(["blueVerified", "language", "activity"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Integer minutes, or "HH:MM". `24:00` / 1440 is accepted only as a window end. */
function minuteOfDay(value: unknown, endOfDay: boolean): number | null {
  if (typeof value === "number") return intIn(value, 0, endOfDay ? DAY_MINUTES : DAY_MINUTES - 1);
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return null;
  if (hour === 24 && minute === 0 && endOfDay) return DAY_MINUTES;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

function parseWindow(value: unknown): TimeWindow | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== "start" && key !== "end")) return null;
  const start = minuteOfDay(value.start, false);
  const end = minuteOfDay(value.end, true);
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

function cloneLane<T extends LaneCadence>(lane: T): T {
  return { ...lane, windows: lane.windows.map((range) => ({ ...range })) };
}

function cloneSettings(settings: AutomationSettings): AutomationSettings {
  return {
    ...settings,
    follow: cloneLane(settings.follow),
    unfollow: cloneLane(settings.unfollow),
    filters: { ...settings.filters },
  };
}

function patchLane<T extends LaneCadence & { dailyCap: number | null; directPool?: boolean }>(
  lane: AutomationLane,
  base: T,
  input: unknown,
  issues: Issue[],
): T {
  const next = cloneLane(base);
  if (input === undefined) return next;
  if (!isRecord(input)) {
    issues.push({ field: lane, message: "必须是对象。" });
    return next;
  }
  for (const key of Object.keys(input)) {
    if (!LANE_KEYS.has(key) || (lane === "follow" && key === "directPool")) issues.push({ field: `${lane}.${key}`, message: "不是可保存的字段。" });
  }
  if (lane === "unfollow" && "directPool" in input) {
    if (typeof input.directPool !== "boolean") issues.push({ field: "unfollow.directPool", message: "必须是布尔值。" });
    else next.directPool = input.directPool;
  }
  if ("batchSize" in input) {
    const value = intIn(input.batchSize, SETTINGS_LIMITS.batchSize.min, SETTINGS_LIMITS.batchSize.max);
    if (value === null) issues.push({ field: `${lane}.batchSize`, message: "必须是 1 到 50 的整数。" });
    else next.batchSize = value;
  }
  if ("dailyCap" in input) {
    if (lane === "unfollow" && input.dailyCap === null) next.dailyCap = null;
    else {
      const limit = lane === "follow" ? SETTINGS_LIMITS.followDailyCap : SETTINGS_LIMITS.unfollowDailyCap;
      const value = intIn(input.dailyCap, limit.min, limit.max);
      if (value === null) {
        issues.push({
          field: `${lane}.dailyCap`,
          message: lane === "follow" ? "必须是 0 到 400 的整数。" : "必须是 0 到 400 的整数，或 null 表示不设日上限。",
        });
      } else next.dailyCap = value;
    }
  }
  if ("workMinutes" in input) {
    const value = intIn(input.workMinutes, SETTINGS_LIMITS.workMinutes.min, SETTINGS_LIMITS.workMinutes.max);
    if (value === null) issues.push({ field: `${lane}.workMinutes`, message: "必须是 1 到 720 的整数分钟。" });
    else next.workMinutes = value;
  }
  if ("restMinutes" in input) {
    const value = intIn(input.restMinutes, SETTINGS_LIMITS.restMinutes.min, SETTINGS_LIMITS.restMinutes.max);
    if (value === null) issues.push({ field: `${lane}.restMinutes`, message: "必须是 0 到 720 的整数分钟。" });
    else next.restMinutes = value;
  }
  if ("anchorMinute" in input) {
    const value = minuteOfDay(input.anchorMinute, false);
    if (value === null) issues.push({ field: `${lane}.anchorMinute`, message: "必须是 0 到 1439 的整数分钟，或 HH:MM。" });
    else next.anchorMinute = value;
  }
  if ("windows" in input) {
    const raw = input.windows;
    if (!Array.isArray(raw) || raw.length < SETTINGS_LIMITS.windows.min || raw.length > SETTINGS_LIMITS.windows.max) {
      issues.push({ field: `${lane}.windows`, message: "必须是 1 到 12 个时间窗。" });
    } else {
      const windows: TimeWindow[] = [];
      raw.forEach((item, index) => {
        const range = parseWindow(item);
        if (!range) {
          issues.push({
            field: `${lane}.windows[${index}]`,
            message: "必须是 { start, end }：start 为 0–1439 分钟或 HH:MM，end 为 0–1440 分钟或 HH:MM（24:00 表示午夜），两者不能相同；end 小于 start 表示跨过午夜。",
          });
        } else windows.push(range);
      });
      if (windows.length === raw.length) next.windows = windows;
    }
  }
  return next;
}

function windowMask(windows: TimeWindow[]): boolean[] {
  const mask = new Array<boolean>(DAY_MINUTES).fill(false);
  for (const range of windows) {
    if (range.end > range.start) {
      for (let minute = range.start; minute < range.end; minute += 1) mask[minute] = true;
    } else {
      for (let minute = range.start; minute < DAY_MINUTES; minute += 1) mask[minute] = true;
      for (let minute = 0; minute < range.end; minute += 1) mask[minute] = true;
    }
  }
  return mask;
}

function hhmm(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function crossCheck(settings: AutomationSettings, issues: Issue[]): void {
  for (const lane of ["follow", "unfollow"] as const) {
    const cadence = settings[lane];
    if (cadence.workMinutes + cadence.restMinutes > SETTINGS_LIMITS.cycleMinutes.max) {
      issues.push({ field: `${lane}.restMinutes`, message: "工作加休息不能超过 1440 分钟。" });
    }
  }
  if (settings.mutualExclusion) {
    const follow = windowMask(settings.follow.windows);
    const unfollow = windowMask(settings.unfollow.windows);
    const overlap = follow.findIndex((open, minute) => open && unfollow[minute]);
    if (overlap >= 0) {
      issues.push({
        field: "mutualExclusion",
        message: `互斥开启时关注窗和取关窗不能重叠（${hhmm(overlap)} 同时落在两边）。请调整窗口，或关闭 mutualExclusion。`,
      });
    }
  }
}

/** Applies `input` on top of `base`. Invalid fields keep the base value and are reported. */
function applyPatch(base: AutomationSettings, input: Record<string, unknown>): { settings: AutomationSettings; issues: Issue[] } {
  const issues: Issue[] = [];
  const next = cloneSettings(base);
  for (const key of Object.keys(input)) {
    if (!TOP_KEYS.has(key)) issues.push({ field: key, message: "不是可保存的字段。" });
  }
  if ("timezone" in input && ("scheduleTimezone" in input || "quotaTimezone" in input)) {
    issues.push({ field: "timezone", message: "timezone 是同时设置两个时区的简写，不能和 scheduleTimezone 或 quotaTimezone 一起提交。" });
  } else if ("timezone" in input) {
    const zone = canonicalTimeZone(input.timezone);
    if (!zone) issues.push({ field: "timezone", message: "必须是有效的 IANA 时区名，例如 Asia/Taipei 或 Europe/London。" });
    else {
      next.scheduleTimezone = zone;
      next.quotaTimezone = zone;
    }
  }
  for (const key of ["scheduleTimezone", "quotaTimezone"] as const) {
    if (!(key in input)) continue;
    const zone = canonicalTimeZone(input[key]);
    if (!zone) issues.push({ field: key, message: "必须是有效的 IANA 时区名，例如 Asia/Taipei 或 Europe/London。" });
    else next[key] = zone;
  }
  if ("mutualExclusion" in input) {
    if (typeof input.mutualExclusion !== "boolean") issues.push({ field: "mutualExclusion", message: "必须是布尔值。" });
    else next.mutualExclusion = input.mutualExclusion;
  }
  const follow = patchLane("follow", base.follow, input.follow, issues);
  next.follow = { ...follow, dailyCap: follow.dailyCap ?? base.follow.dailyCap };
  next.unfollow = patchLane("unfollow", base.unfollow, input.unfollow, issues);
  if ("filters" in input) {
    const filters = input.filters;
    if (!isRecord(filters)) issues.push({ field: "filters", message: "必须是对象。" });
    else {
      for (const key of Object.keys(filters)) {
        if (!FILTER_KEYS.has(key)) {
          issues.push({ field: `filters.${key}`, message: "不是可保存的字段。" });
          continue;
        }
        const value = filters[key];
        if (typeof value !== "boolean") issues.push({ field: `filters.${key}`, message: "必须是布尔值。" });
        else next.filters[key as keyof FollowFilters] = value;
      }
    }
  }
  crossCheck(next, issues);
  return { settings: next, issues };
}

function formatIssues(issues: Issue[]): string {
  return `自动化设置无效：${issues.map((issue) => `${issue.field} ${issue.message}`).join("；")}`;
}

/**
 * 账号1 saved `ops_json` before this table existed. Only values that execution honored are carried:
 * the unfollow cap always (clamped to the old 0–80 ceiling), batch sizes only while the daily pool was on.
 */
function legacyAccount1Patch(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.dailyPool !== "boolean") return null;
  const savedFollowback = parsed.followback;
  const savedUnfollow = parsed.unfollow;
  if (!isRecord(savedFollowback) || !isRecord(savedUnfollow) || !isRecord(parsed.newFollow)) return null;
  const unfollow: Record<string, unknown> = { dailyCap: intIn(savedUnfollow.dailyCap, 0, 80) ?? 80 };
  const patch: Record<string, unknown> = { unfollow };
  if (parsed.dailyPool) {
    patch.follow = { batchSize: intIn(savedFollowback.batchSize, 1, 20) ?? 13 };
    unfollow.batchSize = intIn(savedUnfollow.batchSize, 1, 20) ?? 10;
  }
  return patch;
}

type Loaded = {
  key: string;
  stored: boolean;
  updatedAt: string | null;
  settings: AutomationSettings;
  issues: Issue[];
  masks: Record<AutomationLane, boolean[]>;
};

const loaded = new Map<AccountId, Loaded>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function laneMasks(settings: AutomationSettings): Record<AutomationLane, boolean[]> {
  const follow = windowMask(settings.follow.windows);
  const unfollow = windowMask(settings.unfollow.windows);
  if (!settings.mutualExclusion) return { follow, unfollow };
  return {
    follow: follow.map((open, minute) => open && !unfollow[minute]),
    unfollow: unfollow.map((open, minute) => open && !follow[minute]),
  };
}

function legacyOpsJson(accountId: AccountId): string | null {
  if (accountId !== 1) return null;
  const row = getDb().prepare("SELECT ops_json FROM follow_account_config WHERE account_id = 1").get() as
    | { ops_json: string | null }
    | undefined;
  return row?.ops_json ?? null;
}

function load(accountId: AccountId): Loaded {
  const row = getDb()
    .prepare("SELECT settings_json, updated_at FROM automation_settings WHERE account_id = ?")
    .get(accountId) as { settings_json: string; updated_at: string } | undefined;
  const legacy = row ? null : legacyOpsJson(accountId);
  const key = row ? `row:${row.updated_at}:${row.settings_json}` : `default:${legacy ?? ""}`;
  const cached = loaded.get(accountId);
  if (cached && cached.key === key) return cached;

  let base = defaults(accountId);
  const legacyPatch = legacyAccount1Patch(legacy);
  if (legacyPatch) base = applyPatch(base, legacyPatch).settings;
  let settings = base;
  let issues: Issue[] = [];
  if (row) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.settings_json);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed)) {
      const result = applyPatch(base, parsed);
      settings = result.settings;
      issues = result.issues;
    } else {
      issues = [{ field: "settings", message: "已保存的设置无法解析，正在使用默认值。" }];
    }
  }
  const entry: Loaded = {
    key,
    stored: Boolean(row),
    updatedAt: row?.updated_at ?? null,
    settings: deepFreeze(settings),
    issues,
    masks: laneMasks(settings),
  };
  loaded.set(accountId, entry);
  return entry;
}

/** Shared, frozen view for hot paths. Do not mutate. */
export function currentSettings(accountId: AccountId): AutomationSettings {
  return load(accountId).settings;
}

/** A mutable copy of the effective settings for this account only. */
export function readAutomationSettings(accountId: AccountId): AutomationSettings {
  return cloneSettings(load(accountId).settings);
}

/** Single statement, so callers can wrap it in their own transaction. */
export function persistAutomationSettings(accountId: AccountId, settings: AutomationSettings, now = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO automation_settings (account_id, settings_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
    )
    .run(accountId, JSON.stringify(settings), now.toISOString());
}

/** Validates a partial update against the current settings. Nothing is written when any field is invalid. */
export function validateAutomationSettingsPatch(accountId: AccountId, input: unknown): AutomationSettings {
  if (!isRecord(input)) throw new AppError("invalid_settings", "settings 必须是对象。");
  const { settings, issues } = applyPatch(load(accountId).settings, input);
  if (issues.length) throw new AppError("invalid_settings", formatIssues(issues));
  return settings;
}

export function saveAutomationSettings(accountId: AccountId, input: unknown, now = new Date()) {
  const settings = validateAutomationSettingsPatch(accountId, input);
  persistAutomationSettings(accountId, settings, now);
  return automationSettingsView(accountId, now);
}

/** Drops the saved row. The account goes back to its defaults (账号1 also keeps legacy saved ops values). */
export function resetAutomationSettings(accountId: AccountId, now = new Date()) {
  getDb().prepare("DELETE FROM automation_settings WHERE account_id = ?").run(accountId);
  return automationSettingsView(accountId, now);
}

export function slotPrefix(zone: string): string {
  return zone === "Asia/Taipei" ? "taipei:" : `tz:${zone}:`;
}

function laneState(accountId: AccountId, lane: AutomationLane) {
  const state = load(accountId);
  return {
    zone: state.settings.scheduleTimezone,
    cadence: state.settings[lane],
    mask: state.masks[lane],
    prefix: slotPrefix(state.settings.scheduleTimezone),
  };
}

/** True while `now` is inside this lane's allowed (and not mutually excluded) window. */
export function laneOpen(accountId: AccountId, lane: AutomationLane, now: Date): boolean {
  const state = laneState(accountId, lane);
  return state.mask[zonedClock(now, state.zone).minutes] === true;
}

/** Slot key of the work window containing `now`, or null during rest or outside the window. */
export function laneSlotFor(accountId: AccountId, lane: AutomationLane, now: Date): string | null {
  const state = laneState(accountId, lane);
  const clock = zonedClock(now, state.zone);
  const minute = clock.minutes;
  if (!state.mask[minute]) return null;
  const cycle = state.cadence.workMinutes + state.cadence.restMinutes;
  const since = (minute - state.cadence.anchorMinute + DAY_MINUTES) % DAY_MINUTES;
  const offset = since % cycle;
  if (offset >= state.cadence.workMinutes) return null;
  for (let back = 1; back <= offset; back += 1) {
    if (!state.mask[(minute - back + DAY_MINUTES) % DAY_MINUTES]) return null;
  }
  let start = minute - offset;
  let day = clock.day;
  if (start < 0) {
    start += DAY_MINUTES;
    day = shiftCivilDay(day, -1);
  }
  return `${state.prefix}${day}T${hhmm(start)}`;
}

/** Minute of day encoded in `prefix` + `YYYY-MM-DDTHH:MM`, or null when the key or the date is malformed. */
export function slotKeyMinute(key: string, prefix: string): number | null {
  if (!key.startsWith(prefix)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(key.slice(prefix.length));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const probe = new Date(Date.UTC(year, month - 1, date));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) return null;
  return hour * 60 + minute;
}

/** True when `key` is a work-window start on this account's saved grid for `lane`. */
export function isLaneSlotKey(accountId: AccountId, lane: AutomationLane, key: string): boolean {
  const state = laneState(accountId, lane);
  const minute = slotKeyMinute(key, state.prefix);
  if (minute === null || !state.mask[minute]) return false;
  const since = (minute - state.cadence.anchorMinute + DAY_MINUTES) % DAY_MINUTES;
  return since % (state.cadence.workMinutes + state.cadence.restMinutes) === 0;
}

/** True when the lane still runs on the compiled default grid, zone, and exclusion. */
export function laneIsDefault(accountId: AccountId, lane: AutomationLane): boolean {
  const current = load(accountId).settings;
  const base = defaults(accountId);
  const shape = (settings: AutomationSettings) => JSON.stringify({
    zone: settings.scheduleTimezone,
    mutualExclusion: settings.mutualExclusion,
    workMinutes: settings[lane].workMinutes,
    restMinutes: settings[lane].restMinutes,
    anchorMinute: settings[lane].anchorMinute,
    windows: settings[lane].windows,
    other: settings[lane === "follow" ? "unfollow" : "follow"].windows,
  });
  return shape(current) === shape(base);
}

/** Day key for daily quotas and stats, in the saved quota zone. */
export function quotaDay(accountId: AccountId, now: Date): string {
  return zonedClock(now, load(accountId).settings.quotaTimezone).day;
}

/** [start, end) of the quota day containing `now`. */
export function quotaDayRange(accountId: AccountId, now: Date): { day: string; start: Date; end: Date } {
  return zonedDayRange(now, load(accountId).settings.quotaTimezone);
}

export function followFilters(accountId: AccountId): FollowFilters {
  return { ...load(accountId).settings.filters };
}

export function automationSettingsView(accountId: AccountId, now = new Date()) {
  const state = load(accountId);
  return {
    ok: true as const,
    accountId,
    scope: "account" as const,
    accountScoped: true as const,
    stored: state.stored,
    updatedAt: state.updatedAt,
    settings: cloneSettings(state.settings),
    defaults: defaults(accountId),
    limits: SETTINGS_LIMITS,
    invalidStoredFields: state.issues.map((issue) => issue.field),
    preview: {
      at: now.toISOString(),
      followSlot: laneSlotFor(accountId, "follow", now),
      unfollowSlot: laneSlotFor(accountId, "unfollow", now),
      followOpen: laneOpen(accountId, "follow", now),
      unfollowOpen: laneOpen(accountId, "unfollow", now),
      quotaDay: quotaDay(accountId, now),
      scheduleDay: zonedClock(now, state.settings.scheduleTimezone).day,
    },
  };
}

export type AutomationSettingsView = ReturnType<typeof automationSettingsView>;
