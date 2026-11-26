/**
 * Client-safe operator form for the persisted automation settings (`/api/automation/settings`).
 *
 * Bounds come from `lib/automation-settings-limits.ts`, the same object the server validator in
 * `lib/automation-settings.ts` uses, so the page refuses what the API would refuse. Saves are partial:
 * `buildSettingsPatch` compares the draft with the snapshot the draft was started from and sends only
 * the fields the operator changed. A save therefore never rewrites a value the operator did not touch
 * (for example a custom follow work/rest cadence), even when another field on the same lane changes.
 *
 * Only `import type` reaches the server modules, so this file stays safe for the browser bundle.
 */
import type { AutomationSettings, FollowFilters, TimeWindow } from "@/lib/automation-settings";
import { DAY_MINUTES, SETTINGS_LIMITS } from "@/lib/automation-settings-limits";
import type { Locale } from "@/lib/messages";
import { canonicalTimeZone, zonedClock } from "@/lib/zoned-clock";

export type SettingsLane = "follow" | "unfollow";

export type WindowDraft = { start: string; end: string };

/** Text the operator is editing. Numbers stay strings until they are parsed for a save. */
export type LaneDraft = {
  batchSize: string;
  dailyCap: string;
  /** Unfollow only: no daily cap, saved as `dailyCap: null`. Always false for follow. */
  noCap: boolean;
  workMinutes: string;
  restMinutes: string;
  /** `HH:MM`, or a whole number of minutes after midnight. */
  anchorMinute: string;
  windows: WindowDraft[];
};

export type SettingsDraft = {
  scheduleTimezone: string;
  quotaTimezone: string;
  mutualExclusion: boolean;
  follow: LaneDraft;
  unfollow: LaneDraft;
  filters: FollowFilters;
};

export type LanePatch = {
  batchSize?: number;
  dailyCap?: number | null;
  workMinutes?: number;
  restMinutes?: number;
  anchorMinute?: number;
  windows?: TimeWindow[];
};

/** Partial `settings` object for `PUT /api/automation/settings`. The `timezone` shorthand is never sent. */
export type SettingsPatch = {
  scheduleTimezone?: string;
  quotaTimezone?: string;
  mutualExclusion?: boolean;
  follow?: LanePatch;
  unfollow?: LanePatch;
  filters?: Partial<FollowFilters>;
};

/** A problem with one field. Client checks are bilingual; server messages fill both with the same text. */
export type FormIssue = { field: string; zh: string; en: string };

export type SettingsChange = { field: string; from: unknown; to: unknown };

export type SettingsPatchResult = {
  patch: SettingsPatch;
  changes: SettingsChange[];
  issues: FormIssue[];
};

export const FILTER_KEYS = ["blueVerified", "language", "activity"] as const;

const LANE_FIELDS = ["batchSize", "dailyCap", "workMinutes", "restMinutes", "anchorMinute"] as const;

const LANE_NAME: Record<SettingsLane, { zh: string; en: string }> = {
  follow: { zh: "关注", en: "Follow" },
  unfollow: { zh: "取关", en: "Unfollow" },
};

/** `HH:MM` for a minute of day. 1440 is written `24:00` (a window end at midnight). */
export function minuteToClock(minute: number): string {
  const safe = Math.max(0, Math.min(DAY_MINUTES, Math.trunc(minute)));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/**
 * Minute of day from `HH:MM` (one- or two-digit hour) or from a whole number of minutes.
 * `24:00` / 1440 is accepted only when `endOfDay` is true, i.e. as a window end.
 */
export function parseClockMinute(text: string, endOfDay: boolean): number | null {
  const value = text.trim();
  const max = endOfDay ? DAY_MINUTES : DAY_MINUTES - 1;
  if (/^\d{1,4}$/.test(value)) {
    const minutes = Number(value);
    return minutes <= max ? minutes : null;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return null;
  if (hour === 24 && minute === 0) return endOfDay ? DAY_MINUTES : null;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

function laneDraft(lane: { batchSize: number; dailyCap: number | null; workMinutes: number; restMinutes: number; anchorMinute: number; windows: TimeWindow[] }): LaneDraft {
  return {
    batchSize: String(lane.batchSize),
    dailyCap: lane.dailyCap === null ? "" : String(lane.dailyCap),
    noCap: lane.dailyCap === null,
    workMinutes: String(lane.workMinutes),
    restMinutes: String(lane.restMinutes),
    anchorMinute: minuteToClock(lane.anchorMinute),
    windows: lane.windows.map((range) => ({ start: minuteToClock(range.start), end: minuteToClock(range.end) })),
  };
}

/** Editable copy of saved settings. */
export function draftFromSettings(settings: AutomationSettings): SettingsDraft {
  return {
    scheduleTimezone: settings.scheduleTimezone,
    quotaTimezone: settings.quotaTimezone,
    mutualExclusion: settings.mutualExclusion,
    follow: laneDraft(settings.follow),
    unfollow: laneDraft(settings.unfollow),
    filters: { ...settings.filters },
  };
}

/** True when the draft still shows exactly `settings`. */
export function draftMatches(draft: SettingsDraft, settings: AutomationSettings): boolean {
  return JSON.stringify(draft) === JSON.stringify(draftFromSettings(settings));
}

function integerText(text: string): number | null {
  const value = text.trim();
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function integerIn(text: string, limit: { min: number; max: number }): number | null {
  const value = integerText(text);
  return value !== null && value >= limit.min && value <= limit.max ? value : null;
}

type ParsedLane = {
  batchSize?: number;
  dailyCap?: number | null;
  workMinutes?: number;
  restMinutes?: number;
  anchorMinute?: number;
  windows?: TimeWindow[];
};

function rangeIssue(field: string, zh: string, en: string, limit: { min: number; max: number }, zhTail = "", enTail = ""): FormIssue {
  return {
    field,
    zh: `${zh}必须是 ${limit.min} 到 ${limit.max} 的整数${zhTail}。`,
    en: `${en} must be a whole number from ${limit.min} to ${limit.max}${enTail}.`,
  };
}

function parseLane(lane: SettingsLane, draft: LaneDraft, issues: FormIssue[]): ParsedLane {
  const name = LANE_NAME[lane];
  const parsed: ParsedLane = {};

  const batch = integerIn(draft.batchSize, SETTINGS_LIMITS.batchSize);
  if (batch === null) issues.push(rangeIssue(`${lane}.batchSize`, `${name.zh}每轮人数`, `${name.en} batch size`, SETTINGS_LIMITS.batchSize));
  else parsed.batchSize = batch;

  if (lane === "unfollow" && draft.noCap) parsed.dailyCap = null;
  else {
    const limit = lane === "follow" ? SETTINGS_LIMITS.followDailyCap : SETTINGS_LIMITS.unfollowDailyCap;
    const cap = integerIn(draft.dailyCap, limit);
    if (cap === null) {
      issues.push(lane === "follow"
        ? rangeIssue("follow.dailyCap", "关注日上限", "Follow daily cap", limit)
        : rangeIssue("unfollow.dailyCap", "取关日上限", "Unfollow daily cap", limit, "，或勾选「不设日上限」", ', or tick "no daily cap"'));
    } else parsed.dailyCap = cap;
  }

  const work = integerIn(draft.workMinutes, SETTINGS_LIMITS.workMinutes);
  if (work === null) issues.push(rangeIssue(`${lane}.workMinutes`, `${name.zh}工作分钟`, `${name.en} work minutes`, SETTINGS_LIMITS.workMinutes));
  else parsed.workMinutes = work;

  const rest = integerIn(draft.restMinutes, SETTINGS_LIMITS.restMinutes);
  if (rest === null) issues.push(rangeIssue(`${lane}.restMinutes`, `${name.zh}休息分钟`, `${name.en} rest minutes`, SETTINGS_LIMITS.restMinutes));
  else parsed.restMinutes = rest;

  const anchor = parseClockMinute(draft.anchorMinute, false);
  if (anchor === null) {
    issues.push({
      field: `${lane}.anchorMinute`,
      zh: `${name.zh}锚点必须是 00:00–23:59，或 ${SETTINGS_LIMITS.anchorMinute.min}–${SETTINGS_LIMITS.anchorMinute.max} 的分钟数。`,
      en: `${name.en} anchor must be 00:00–23:59, or minutes ${SETTINGS_LIMITS.anchorMinute.min}–${SETTINGS_LIMITS.anchorMinute.max}.`,
    });
  } else parsed.anchorMinute = anchor;

  const count = draft.windows.length;
  if (count < SETTINGS_LIMITS.windows.min || count > SETTINGS_LIMITS.windows.max) {
    issues.push({
      field: `${lane}.windows`,
      zh: `${name.zh}需要 ${SETTINGS_LIMITS.windows.min} 到 ${SETTINGS_LIMITS.windows.max} 个时间窗。`,
      en: `${name.en} needs ${SETTINGS_LIMITS.windows.min} to ${SETTINGS_LIMITS.windows.max} windows.`,
    });
  } else {
    const windows: TimeWindow[] = [];
    draft.windows.forEach((range, index) => {
      const start = parseClockMinute(range.start, false);
      const end = parseClockMinute(range.end, true);
      if (start === null || end === null || start === end) {
        issues.push({
          field: `${lane}.windows[${index}]`,
          zh: `${name.zh}时间窗 ${index + 1}：开始填 00:00–23:59，结束填 00:00–24:00，两者不能相同。结束早于开始表示跨过午夜，24:00 只能作结束。`,
          en: `${name.en} window ${index + 1}: start 00:00–23:59, end 00:00–24:00, and they must differ. An end before the start wraps past midnight; 24:00 is only valid as an end.`,
        });
      } else windows.push({ start, end });
    });
    if (windows.length === count) parsed.windows = windows;
  }
  return parsed;
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

/** First minute of day that both window sets cover, or null. Same rule as the server cross-check. */
export function firstWindowOverlap(a: TimeWindow[], b: TimeWindow[]): number | null {
  const left = windowMask(a);
  const right = windowMask(b);
  const minute = left.findIndex((open, index) => open && right[index]);
  return minute >= 0 ? minute : null;
}

function crossCheck(follow: ParsedLane, unfollow: ParsedLane, mutualExclusion: boolean, issues: FormIssue[]): void {
  for (const [lane, parsed] of [["follow", follow], ["unfollow", unfollow]] as const) {
    if (parsed.workMinutes === undefined || parsed.restMinutes === undefined) continue;
    if (parsed.workMinutes + parsed.restMinutes > SETTINGS_LIMITS.cycleMinutes.max) {
      issues.push({
        field: `${lane}.restMinutes`,
        zh: `${LANE_NAME[lane].zh}工作加休息不能超过 ${SETTINGS_LIMITS.cycleMinutes.max} 分钟。`,
        en: `${LANE_NAME[lane].en} work plus rest cannot exceed ${SETTINGS_LIMITS.cycleMinutes.max} minutes.`,
      });
    }
  }
  if (mutualExclusion && follow.windows && unfollow.windows) {
    const overlap = firstWindowOverlap(follow.windows, unfollow.windows);
    if (overlap !== null) {
      issues.push({
        field: "mutualExclusion",
        zh: `互斥开启时关注窗和取关窗不能重叠（${minuteToClock(overlap)} 同时落在两边）。请调整窗口，或关闭互斥。`,
        en: `With mutual exclusion on, follow and unfollow windows cannot overlap (${minuteToClock(overlap)} is in both). Adjust a window or turn mutual exclusion off.`,
      });
    }
  }
}

function sameWindows(a: TimeWindow[], b: TimeWindow[]): boolean {
  return a.length === b.length && a.every((range, index) => range.start === b[index].start && range.end === b[index].end);
}

function diffLane(
  lane: SettingsLane,
  base: { batchSize: number; dailyCap: number | null; workMinutes: number; restMinutes: number; anchorMinute: number; windows: TimeWindow[] },
  parsed: ParsedLane,
  changes: SettingsChange[],
): LanePatch | null {
  const out: LanePatch = {};
  for (const key of LANE_FIELDS) {
    const value = parsed[key];
    if (value === undefined || value === base[key]) continue;
    if (key === "dailyCap") out.dailyCap = value;
    else out[key] = value as number;
    changes.push({ field: `${lane}.${key}`, from: base[key], to: value });
  }
  if (parsed.windows && !sameWindows(parsed.windows, base.windows)) {
    out.windows = parsed.windows.map((range) => ({ ...range }));
    changes.push({ field: `${lane}.windows`, from: base.windows.map((range) => ({ ...range })), to: out.windows });
  }
  return Object.keys(out).length > 0 ? out : null;
}

function timezoneIssue(field: "scheduleTimezone" | "quotaTimezone"): FormIssue {
  const zh = field === "scheduleTimezone" ? "排程时区" : "日上限时区";
  const en = field === "scheduleTimezone" ? "Schedule time zone" : "Quota time zone";
  return {
    field,
    zh: `${zh}必须是有效的 IANA 时区名，例如 Asia/Taipei 或 Europe/London；不接受 +08:00 这类偏移。`,
    en: `${en} must be a valid IANA time zone name such as Asia/Taipei or Europe/London. Offsets such as +08:00 are not accepted.`,
  };
}

/**
 * Partial update from `base` (the settings the draft started from) to `draft`. Unchanged fields are
 * left out, so the server keeps whatever it has for them. Invalid fields are reported in `issues`;
 * callers must not send the patch while `issues` is non-empty.
 */
export function buildSettingsPatch(base: AutomationSettings, draft: SettingsDraft): SettingsPatchResult {
  const issues: FormIssue[] = [];
  const changes: SettingsChange[] = [];
  const patch: SettingsPatch = {};

  for (const key of ["scheduleTimezone", "quotaTimezone"] as const) {
    const zone = canonicalTimeZone(draft[key]);
    if (!zone) {
      issues.push(timezoneIssue(key));
      continue;
    }
    if (zone !== base[key]) {
      patch[key] = zone;
      changes.push({ field: key, from: base[key], to: zone });
    }
  }

  if (draft.mutualExclusion !== base.mutualExclusion) {
    patch.mutualExclusion = draft.mutualExclusion;
    changes.push({ field: "mutualExclusion", from: base.mutualExclusion, to: draft.mutualExclusion });
  }

  const follow = parseLane("follow", { ...draft.follow, noCap: false }, issues);
  const unfollow = parseLane("unfollow", draft.unfollow, issues);
  crossCheck(follow, unfollow, draft.mutualExclusion, issues);
  const followPatch = diffLane("follow", base.follow, follow, changes);
  if (followPatch) patch.follow = followPatch;
  const unfollowPatch = diffLane("unfollow", base.unfollow, unfollow, changes);
  if (unfollowPatch) patch.unfollow = unfollowPatch;

  const filters: Partial<FollowFilters> = {};
  for (const key of FILTER_KEYS) {
    if (draft.filters[key] === base.filters[key]) continue;
    filters[key] = draft.filters[key];
    changes.push({ field: `filters.${key}`, from: base.filters[key], to: draft.filters[key] });
  }
  if (Object.keys(filters).length > 0) patch.filters = filters;

  return { patch, changes, issues };
}

/** Body for `PUT /api/automation/settings`. Only the visible account goes in, and only the patch. */
export function settingsPutBody(accountId: 1 | 2, patch: SettingsPatch): { accountId: 1 | 2; settings: SettingsPatch } {
  return { accountId, settings: patch };
}

const ISSUE_PREFIX = "自动化设置无效：";
const ISSUE_FIELD = /(?:^|；)((?:scheduleTimezone|quotaTimezone|timezone|mutualExclusion|settings|filters|unfollow|follow)(?:\.[A-Za-z]+)?(?:\[\d+\])?) /g;

/**
 * Splits an `invalid_settings` message into `{ field, message }` items so the form can show each
 * one next to its input. A message without field names comes back as one item with `field: ""`.
 */
export function parseSettingsIssues(message: string): Array<{ field: string; message: string }> {
  const text = message.startsWith(ISSUE_PREFIX) ? message.slice(ISSUE_PREFIX.length) : message;
  const starts: Array<{ index: number; field: string; textStart: number }> = [];
  const pattern = new RegExp(ISSUE_FIELD.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    starts.push({ index: match.index, field: match[1], textStart: match.index + match[0].length });
  }
  if (starts.length === 0) return [{ field: "", message: text.trim() }];
  const items: Array<{ field: string; message: string }> = [];
  const lead = text.slice(0, starts[0].index).trim();
  if (lead) items.push({ field: "", message: lead });
  starts.forEach((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : text.length;
    items.push({ field: start.field, message: text.slice(start.textStart, end).trim() });
  });
  return items;
}

/** Server issues in the form's shape. The API writes Chinese, so both locales show that text. */
export function serverSettingsIssues(message: string): FormIssue[] {
  return parseSettingsIssues(message).map((item) => ({ field: item.field, zh: item.message, en: item.message }));
}

/** Issues for exactly `field`, or for `field` and everything under it when `nested` is true. */
export function issuesFor(issues: FormIssue[], field: string, locale: Locale, nested = false): string[] {
  return issues
    .filter((issue) => issue.field === field || (nested && (issue.field.startsWith(`${field}.`) || issue.field.startsWith(`${field}[`))))
    .map((issue) => issue[locale]);
}

const FIELD_LABELS: Record<string, { zh: string; en: string }> = {
  scheduleTimezone: { zh: "排程时区", en: "Schedule time zone" },
  quotaTimezone: { zh: "日上限时区", en: "Quota time zone" },
  timezone: { zh: "时区", en: "Time zone" },
  mutualExclusion: { zh: "关注与取关互斥", en: "Mutual exclusion" },
  settings: { zh: "设置", en: "Settings" },
  batchSize: { zh: "每轮人数", en: "batch size" },
  dailyCap: { zh: "日上限", en: "daily cap" },
  workMinutes: { zh: "工作分钟", en: "work minutes" },
  restMinutes: { zh: "休息分钟", en: "rest minutes" },
  anchorMinute: { zh: "锚点", en: "anchor" },
  windows: { zh: "时间窗", en: "windows" },
  blueVerified: { zh: "必须蓝V", en: "Blue Verified only" },
  language: { zh: "受众语言", en: "audience language" },
  activity: { zh: "近期活跃", en: "recent activity" },
};

/** Readable name for a settings field path such as `follow.workMinutes` or `unfollow.windows[1]`. */
export function fieldLabel(field: string, locale: Locale): string {
  if (!field) return FIELD_LABELS.settings[locale];
  const [head, ...rest] = field.split(".");
  if (rest.length === 0) return FIELD_LABELS[head]?.[locale] ?? field;
  const group = head === "follow" || head === "unfollow"
    ? LANE_NAME[head][locale]
    : head === "filters"
      ? (locale === "zh" ? "过滤" : "Filter")
      : head;
  const tail = rest.join(".");
  const indexed = /^([A-Za-z]+)\[(\d+)\]$/.exec(tail);
  const key = indexed ? indexed[1] : tail;
  const label = FIELD_LABELS[key]?.[locale] ?? key;
  return `${group}·${label}${indexed ? ` ${Number(indexed[2]) + 1}` : ""}`;
}

/** Display text for one saved or draft value. */
export function formatSettingValue(field: string, value: unknown, locale: Locale): string {
  if (typeof value === "boolean") return value ? (locale === "zh" ? "开" : "on") : (locale === "zh" ? "关" : "off");
  if (field.endsWith(".dailyCap") && value === null) return locale === "zh" ? "不设上限" : "no cap";
  if (field.endsWith(".anchorMinute") && typeof value === "number") return minuteToClock(value);
  if (field.endsWith(".windows") && Array.isArray(value)) {
    return (value as TimeWindow[]).map((range) => `${minuteToClock(range.start)}–${minuteToClock(range.end)}`).join(", ");
  }
  return String(value);
}

/** One line per change, for "this is what will be saved" and for the save confirmation. */
export function describeChanges(changes: SettingsChange[], locale: Locale): string {
  return changes
    .map((change) => `${fieldLabel(change.field, locale)} ${formatSettingValue(change.field, change.from, locale)} → ${formatSettingValue(change.field, change.to, locale)}`)
    .join(locale === "zh" ? "；" : "; ");
}

/** Short summary of one lane, e.g. for the defaults line under the lane. */
export function describeLane(lane: SettingsLane, settings: AutomationSettings, locale: Locale): string {
  const value = settings[lane];
  const windows = formatSettingValue(`${lane}.windows`, value.windows, locale);
  const cap = formatSettingValue(`${lane}.dailyCap`, value.dailyCap, locale);
  return locale === "zh"
    ? `每轮 ${value.batchSize} · 日上限 ${cap} · 工作 ${value.workMinutes} / 休息 ${value.restMinutes} 分钟 · 锚点 ${minuteToClock(value.anchorMinute)} · 时间窗 ${windows}`
    : `batch ${value.batchSize} · daily cap ${cap} · work ${value.workMinutes} / rest ${value.restMinutes} min · anchor ${minuteToClock(value.anchorMinute)} · windows ${windows}`;
}

/** Daily-cap wording for a quota zone. The two default zones keep their established labels. */
export function quotaDayLabel(zone: string, locale: Locale): string {
  if (zone === "Asia/Taipei") return locale === "zh" ? "台北日历日" : "Taipei-day";
  if (zone === "Europe/London") return locale === "zh" ? "伦敦每日" : "London daily";
  return locale === "zh" ? `${zone} 日历日` : `${zone}-day`;
}

/** Suggestions shown first. Any other valid IANA name can still be typed or picked from the full list. */
const COMMON_ZONES = [
  "Asia/Taipei",
  "Europe/London",
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney",
];

let zoneCache: string[] | null = null;

function supportedZones(): string[] {
  if (zoneCache) return zoneCache;
  let listed: string[] = [];
  try {
    listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    listed = [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const zone of [...COMMON_ZONES.map((item) => canonicalTimeZone(item)), ...listed]) {
    if (!zone || seen.has(zone)) continue;
    seen.add(zone);
    out.push(zone);
  }
  zoneCache = out;
  return out;
}

/**
 * IANA zone names for the picker: `extra` (for example the saved values) first, then common zones,
 * then everything this runtime's Intl knows. Invalid extras are dropped. No offsets are listed.
 */
export function timeZoneOptions(extra: readonly string[] = []): string[] {
  const base = supportedZones();
  const head: string[] = [];
  for (const item of extra) {
    const zone = canonicalTimeZone(item);
    if (zone && !head.includes(zone)) head.push(zone);
  }
  if (head.length === 0) return base;
  return [...head, ...base.filter((zone) => !head.includes(zone))];
}

/** The browser's own zone, when it is a valid IANA name. */
export function browserTimeZone(): string | null {
  try {
    return canonicalTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/** Civil date, time, and UTC offset in `zone` at `now`, or null for an invalid zone. Display only. */
export function zoneSnapshot(zone: string, now: Date): { zone: string; day: string; time: string; offset: string } | null {
  const canonical = canonicalTimeZone(zone);
  if (!canonical) return null;
  const clock = zonedClock(now, canonical);
  let offset = "";
  try {
    offset = new Intl.DateTimeFormat("en-US", { timeZone: canonical, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    offset = "";
  }
  return { zone: canonical, day: clock.day, time: minuteToClock(clock.minutes), offset };
}

/** Saved legacy evening new-follow numbers. They no longer drive execution and are echoed back unchanged. */
export type LegacyNewFollow = { batchSize: number; workMinutes: number; restMinutes: number };

export type DailyPoolOpsBody = {
  accountId: 1;
  ops: {
    dailyPool: boolean;
    followback: { batchSize: number };
    newFollow: LegacyNewFollow;
    unfollow: { batchSize: number; dailyCap: number };
  };
};

/**
 * Body for the account 1 daily-pool switch (`PUT /api/follow/config` with `ops`). That endpoint still
 * requires batch sizes and the unfollow cap, so they are copied from the freshly read saved settings
 * and come back unchanged. No work/rest minutes, anchor, or window is sent, so the saved cadence stays
 * as it is. Returns null when the unfollow lane has no daily cap: the legacy endpoint cannot hold that.
 */
export function dailyPoolOpsBody(dailyPool: boolean, settings: AutomationSettings, newFollow: LegacyNewFollow): DailyPoolOpsBody | null {
  if (settings.unfollow.dailyCap === null) return null;
  return {
    accountId: 1,
    ops: {
      dailyPool,
      followback: { batchSize: settings.follow.batchSize },
      newFollow: { batchSize: newFollow.batchSize, workMinutes: newFollow.workMinutes, restMinutes: newFollow.restMinutes },
      unfollow: { batchSize: settings.unfollow.batchSize, dailyCap: settings.unfollow.dailyCap },
    },
  };
}
