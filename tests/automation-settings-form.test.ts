import { describe, expect, it, vi } from "vitest";
import type { AutomationSettings } from "@/lib/automation-settings";
import {
  browserTimeZone,
  buildSettingsPatch,
  dailyPoolOpsBody,
  describeChanges,
  describeLane,
  draftFromSettings,
  draftMatches,
  fieldLabel,
  firstWindowOverlap,
  formatSettingValue,
  issuesFor,
  minuteToClock,
  parseClockMinute,
  parseSettingsIssues,
  quotaDayLabel,
  serverSettingsIssues,
  settingsPutBody,
  timeZoneOptions,
  zoneSnapshot,
  type FormIssue,
  type SettingsChange,
} from "@/lib/automation-settings-form";
import { SETTINGS_LIMITS } from "@/lib/automation-settings-limits";
import { canonicalTimeZone } from "@/lib/zoned-clock";

// A fresh, client-only fixture: importing the server's defaults would also load SQLite.
function settings(): AutomationSettings {
  return {
    scheduleTimezone: "Asia/Taipei",
    quotaTimezone: "Asia/Taipei",
    mutualExclusion: true,
    follow: { batchSize: 13, dailyCap: 350, workMinutes: 15, restMinutes: 18, anchorMinute: 540, windows: [{ start: 540, end: 300 }] },
    unfollow: { batchSize: 10, dailyCap: 80, workMinutes: 30, restMinutes: 0, anchorMinute: 15, windows: [{ start: 300, end: 540 }] },
    filters: { blueVerified: true, language: true, activity: false },
  };
}

describe("clock form values", () => {
  it.each([
    [0, "00:00"], [60, "01:00"], [1439, "23:59"], [1440, "24:00"],
    [-10, "00:00"], [1500, "24:00"], [61.9, "01:01"],
  ] as const)("formats and clamps minute %s as %s", (minute, clock) => {
    expect(minuteToClock(minute)).toBe(clock);
  });

  it.each([
    ["00:00", false, 0], ["01:00", false, 60], ["9:05", false, 545],
    [" 23:59 ", false, 1439], ["0", false, 0], [" 540 ", false, 540],
    ["1439", false, 1439], ["24:00", true, 1440], ["1440", true, 1440],
  ] as const)("parses %s with endOfDay=%s", (value, endOfDay, minute) => {
    expect(parseClockMinute(value, endOfDay)).toBe(minute);
  });

  it.each(["24:00", "1440"])("only accepts %s as a window end", (value) => {
    expect(parseClockMinute(value, false)).toBeNull();
    expect(parseClockMinute(value, true)).toBe(1440);
  });

  it.each(["24:01", "23:60", "25:00", "", "  ", "+08:00", "-01:00", "UTC+8", "noon", "1:2", "12:00:00", "1.5", "-1", "1441"])("rejects %j for both clock roles", (value) => {
    expect(parseClockMinute(value, false)).toBeNull();
    expect(parseClockMinute(value, true)).toBeNull();
  });
});

describe("settings drafts and window overlap", () => {
  it("makes editable strings, preserves null caps, and round-trips without changing the source", () => {
    const base = settings();
    base.unfollow.dailyCap = null;
    const draft = draftFromSettings(base);
    expect(draft).toEqual({
      scheduleTimezone: "Asia/Taipei", quotaTimezone: "Asia/Taipei", mutualExclusion: true,
      follow: { batchSize: "13", dailyCap: "350", noCap: false, workMinutes: "15", restMinutes: "18", anchorMinute: "09:00", windows: [{ start: "09:00", end: "05:00" }] },
      unfollow: { batchSize: "10", dailyCap: "", noCap: true, workMinutes: "30", restMinutes: "0", anchorMinute: "00:15", windows: [{ start: "05:00", end: "09:00" }] },
      filters: { blueVerified: true, language: true, activity: false },
    });
    expect(draftMatches(draft, base)).toBe(true);
    expect(buildSettingsPatch(base, draft)).toEqual({ patch: {}, changes: [], issues: [] });
    draft.follow.windows[0].start = "10:00";
    draft.filters.activity = true;
    expect(draftMatches(draft, base)).toBe(false);
    expect(base.follow.windows).toEqual([{ start: 540, end: 300 }]);
    expect(base.filters.activity).toBe(false);
  });

  it("detects an edited number, zone, or no-cap switch", () => {
    const base = settings();
    const number = draftFromSettings(base);
    number.follow.batchSize = "12";
    const zone = draftFromSettings(base);
    zone.quotaTimezone = "Europe/London";
    const cap = draftFromSettings(base);
    cap.unfollow.noCap = true;
    for (const draft of [number, zone, cap]) expect(draftMatches(draft, base)).toBe(false);
  });

  it.each([
    { name: "disjoint windows", a: [{ start: 60, end: 120 }], b: [{ start: 180, end: 240 }], overlap: null },
    { name: "touching endpoints", a: [{ start: 60, end: 120 }], b: [{ start: 120, end: 180 }], overlap: null },
    { name: "an overlap", a: [{ start: 60, end: 120 }], b: [{ start: 90, end: 180 }], overlap: 90 },
    { name: "identical windows", a: [{ start: 60, end: 120 }], b: [{ start: 60, end: 120 }], overlap: 60 },
    { name: "a midnight wrap", a: [{ start: 1380, end: 60 }], b: [{ start: 30, end: 90 }], overlap: 30 },
    { name: "two midnight wraps", a: [{ start: 1380, end: 60 }], b: [{ start: 1410, end: 30 }], overlap: 0 },
    { name: "unsorted multiple windows", a: [{ start: 600, end: 720 }, { start: 60, end: 120 }], b: [{ start: 660, end: 780 }, { start: 90, end: 150 }], overlap: 90 },
    { name: "complementary wraps", a: [{ start: 540, end: 300 }], b: [{ start: 300, end: 540 }], overlap: null },
    { name: "an empty set", a: [], b: [{ start: 0, end: 1440 }], overlap: null },
  ])("finds the first minute for $name", ({ a, b, overlap }) => {
    expect(firstWindowOverlap(a, b)).toBe(overlap);
    expect(firstWindowOverlap(b, a)).toBe(overlap);
  });
});

describe("partial settings patches", () => {
  it("sends nothing when an ordinary saved draft is unchanged", () => {
    const base = settings();
    expect(buildSettingsPatch(base, draftFromSettings(base))).toEqual({ patch: {}, changes: [], issues: [] });
  });

  it("sends only edited fields without rewriting custom cadence on either lane", () => {
    const base = settings();
    base.follow.workMinutes = 17;
    base.follow.restMinutes = 23;
    base.unfollow.workMinutes = 11;
    base.unfollow.restMinutes = 49;
    const before = structuredClone(base);
    const draft = draftFromSettings(base);
    draft.follow.batchSize = "7";
    draft.unfollow.dailyCap = "100";
    const draftBefore = structuredClone(draft);
    expect(buildSettingsPatch(base, draft)).toEqual({
      patch: { follow: { batchSize: 7 }, unfollow: { dailyCap: 100 } },
      changes: [
        { field: "follow.batchSize", from: 13, to: 7 },
        { field: "unfollow.dailyCap", from: 80, to: 100 },
      ],
      issues: [],
    });
    expect(base).toEqual(before);
    expect(draft).toEqual(draftBefore);
  });

  it("canonicalizes zones separately and never sends the timezone shorthand", () => {
    const base = settings();
    const draft = draftFromSettings(base);
    draft.scheduleTimezone = " US/Eastern ";
    draft.quotaTimezone = "europe/london";
    const result = buildSettingsPatch(base, draft);
    expect(result).toEqual({
      patch: { scheduleTimezone: "America/New_York", quotaTimezone: "Europe/London" },
      changes: [
        { field: "scheduleTimezone", from: "Asia/Taipei", to: "America/New_York" },
        { field: "quotaTimezone", from: "Asia/Taipei", to: "Europe/London" },
      ],
      issues: [],
    });
    expect(result.patch).not.toHaveProperty("timezone");
    draft.scheduleTimezone = " asia/taipei ";
    draft.quotaTimezone = "Asia/Taipei";
    expect(buildSettingsPatch(base, draft)).toEqual({ patch: {}, changes: [], issues: [] });
  });

  it.each(["", "Mars/Olympus", "+08:00", "-04:00", "UTC+08:00"])("rejects invalid schedule and quota zone %j", (zone) => {
    const base = settings();
    for (const field of ["scheduleTimezone", "quotaTimezone"] as const) {
      const draft = draftFromSettings(base);
      draft[field] = zone;
      const result = buildSettingsPatch(base, draft);
      expect(result.issues.map((issue) => issue.field)).toEqual([field]);
      expect(result.patch).not.toHaveProperty(field);
      expect(result.patch).not.toHaveProperty("timezone");
    }
  });

  it("requires a follow cap even if noCap is set, and sends null for an uncapped unfollow lane", () => {
    const base = settings();
    const draft = draftFromSettings(base);
    draft.follow.noCap = true;
    draft.follow.dailyCap = "";
    expect(buildSettingsPatch(base, draft).issues.map((issue) => issue.field)).toEqual(["follow.dailyCap"]);
    draft.follow.dailyCap = "350";
    draft.unfollow.noCap = true;
    draft.unfollow.dailyCap = "ignored while uncapped";
    expect(buildSettingsPatch(base, draft)).toEqual({
      patch: { unfollow: { dailyCap: null } },
      changes: [{ field: "unfollow.dailyCap", from: 80, to: null }],
      issues: [],
    });
    base.unfollow.dailyCap = null;
    const capped = draftFromSettings(base);
    capped.unfollow.noCap = false;
    expect(buildSettingsPatch(base, capped).issues.map((issue) => issue.field)).toEqual(["unfollow.dailyCap"]);
    capped.unfollow.dailyCap = "0";
    expect(buildSettingsPatch(base, capped).patch).toEqual({ unfollow: { dailyCap: 0 } });
  });

  const numericFields = [
    { lane: "follow", field: "batchSize", limit: SETTINGS_LIMITS.batchSize },
    { lane: "unfollow", field: "batchSize", limit: SETTINGS_LIMITS.batchSize },
    { lane: "follow", field: "dailyCap", limit: SETTINGS_LIMITS.followDailyCap },
    { lane: "unfollow", field: "dailyCap", limit: SETTINGS_LIMITS.unfollowDailyCap },
    { lane: "follow", field: "workMinutes", limit: SETTINGS_LIMITS.workMinutes },
    { lane: "unfollow", field: "workMinutes", limit: SETTINGS_LIMITS.workMinutes },
    { lane: "follow", field: "restMinutes", limit: SETTINGS_LIMITS.restMinutes },
    { lane: "unfollow", field: "restMinutes", limit: SETTINGS_LIMITS.restMinutes },
  ] as const;

  it.each(numericFields)("accepts the limits for $lane.$field", ({ lane, field, limit }) => {
    const base = settings();
    for (const value of [limit.min, limit.max]) {
      const draft = draftFromSettings(base);
      draft[lane][field] = ` ${value} `;
      const result = buildSettingsPatch(base, draft);
      expect(result.issues).toEqual([]);
      if (value !== base[lane][field]) expect(result.patch[lane]?.[field]).toBe(value);
    }
  });

  it.each(numericFields)("rejects invalid integers and out-of-range $lane.$field", ({ lane, field, limit }) => {
    const base = settings();
    for (const value of ["", "1.5", "1e2", "0x10", "+1", "NaN", "Infinity", "9007199254740992", String(limit.min - 1), String(limit.max + 1)]) {
      const draft = draftFromSettings(base);
      draft[lane][field] = value;
      const result = buildSettingsPatch(base, draft);
      expect(result.issues.map((issue) => issue.field)).toContain(`${lane}.${field}`);
      expect(result.patch[lane]?.[field]).toBeUndefined();
    }
  });

  it.each(["follow", "unfollow"] as const)("keeps the %s work/rest cycle within cycleMinutes.max", (lane) => {
    const base = settings();
    const draft = draftFromSettings(base);
    draft[lane].workMinutes = String(SETTINGS_LIMITS.workMinutes.max);
    draft[lane].restMinutes = String(SETTINGS_LIMITS.cycleMinutes.max - SETTINGS_LIMITS.workMinutes.max);
    expect(buildSettingsPatch(base, draft).issues).toEqual([]);
    // The individual maxima already sum to cycleMinutes.max, so exceeding the cycle
    // also exceeds an individual bound; either way, the form must refuse the save.
    draft[lane].restMinutes = String(SETTINGS_LIMITS.cycleMinutes.max - SETTINGS_LIMITS.workMinutes.max + 1);
    expect(buildSettingsPatch(base, draft).issues.map((issue) => issue.field)).toContain(`${lane}.restMinutes`);
  });

  it("reports overlapping windows only while mutual exclusion is on", () => {
    const base = settings();
    const draft = draftFromSettings(base);
    draft.follow.windows = [{ start: "08:00", end: "12:00" }];
    const blocked = buildSettingsPatch(base, draft);
    expect(blocked.issues.map((issue) => issue.field)).toEqual(["mutualExclusion"]);
    expect(blocked.issues[0].en).toContain("08:00");
    draft.mutualExclusion = false;
    expect(buildSettingsPatch(base, draft)).toMatchObject({
      patch: { mutualExclusion: false, follow: { windows: [{ start: 480, end: 720 }] } }, issues: [],
    });
  });

  it.each([
    { start: "00:00", end: "24:00", parsed: { start: 0, end: 1440 } },
    { start: "23:59", end: "00:00", parsed: { start: 1439, end: 0 } },
    { start: "23:00", end: "01:00", parsed: { start: 1380, end: 60 } },
  ])("accepts window $start–$end", ({ start, end, parsed }) => {
    const base = settings();
    const draft = draftFromSettings(base);
    draft.mutualExclusion = false;
    draft.follow.windows = [{ start, end }];
    const result = buildSettingsPatch(base, draft);
    expect(result.issues).toEqual([]);
    expect(result.patch.follow).toEqual({ windows: [parsed] });
  });

  it.each([
    { start: "24:00", end: "01:00" }, { start: "24:01", end: "01:00" },
    { start: "00:00", end: "24:01" }, { start: "23:60", end: "24:00" },
    { start: "09:00", end: "09:00" }, { start: "", end: "09:00" },
    { start: "09:00", end: "" }, { start: "+08:00", end: "09:00" },
  ])("rejects invalid window $start–$end on either lane", (window) => {
    const base = settings();
    for (const lane of ["follow", "unfollow"] as const) {
      const draft = draftFromSettings(base);
      draft[lane].windows = [window];
      const result = buildSettingsPatch(base, draft);
      expect(result.issues.map((issue) => issue.field)).toEqual([`${lane}.windows[0]`]);
      expect(result.patch[lane]?.windows).toBeUndefined();
    }
  });

  it.each(["follow", "unfollow"] as const)("validates %s window count bounds and anchors", (lane) => {
    const base = settings();
    for (const count of [SETTINGS_LIMITS.windows.min, SETTINGS_LIMITS.windows.max, SETTINGS_LIMITS.windows.min - 1, SETTINGS_LIMITS.windows.max + 1]) {
      const draft = draftFromSettings(base);
      draft.mutualExclusion = false;
      draft[lane].windows = Array.from({ length: count }, () => ({ start: "10:00", end: "11:00" }));
      const result = buildSettingsPatch(base, draft);
      if (count >= SETTINGS_LIMITS.windows.min && count <= SETTINGS_LIMITS.windows.max) {
        expect(result.issues).toEqual([]);
        expect(result.patch[lane]?.windows).toHaveLength(count);
      } else expect(result.issues.map((issue) => issue.field)).toEqual([`${lane}.windows`]);
    }
    for (const anchor of ["00:00", "23:59", String(SETTINGS_LIMITS.anchorMinute.min), String(SETTINGS_LIMITS.anchorMinute.max)]) {
      const draft = draftFromSettings(base);
      draft[lane].anchorMinute = anchor;
      const result = buildSettingsPatch(base, draft);
      expect(result.issues).toEqual([]);
      expect(result.patch[lane]?.anchorMinute).toBe(parseClockMinute(anchor, false));
    }
    for (const anchor of ["24:00", "1440", "-1", "noon"]) {
      const draft = draftFromSettings(base);
      draft[lane].anchorMinute = anchor;
      expect(buildSettingsPatch(base, draft).issues.map((issue) => issue.field)).toEqual([`${lane}.anchorMinute`]);
    }
  });

  it.each(["blueVerified", "language", "activity"] as const)("sends only the changed %s filter key", (key) => {
    const base = settings();
    const draft = draftFromSettings(base);
    draft.filters[key] = !base.filters[key];
    expect(buildSettingsPatch(base, draft)).toEqual({
      patch: { filters: { [key]: !base.filters[key] } },
      changes: [{ field: `filters.${key}`, from: base.filters[key], to: !base.filters[key] }],
      issues: [],
    });
  });

  it.each([1, 2] as const)("wraps only account %s and its partial settings in the PUT body", (accountId) => {
    const patch = { follow: { batchSize: 7 } };
    expect(settingsPutBody(accountId, patch)).toEqual({ accountId, settings: { follow: { batchSize: 7 } } });
    expect(settingsPutBody(accountId, {})).toEqual({ accountId, settings: {} });
  });
});

describe("settings issues", () => {
  it("splits server messages including indexed windows and filters", () => {
    const message = "自动化设置无效：follow.batchSize 必须是整数。；follow.windows[1] 开始和结束不能相同。；filters.activity 必须是布尔值。";
    const parsed = [
      { field: "follow.batchSize", message: "必须是整数。" },
      { field: "follow.windows[1]", message: "开始和结束不能相同。" },
      { field: "filters.activity", message: "必须是布尔值。" },
    ];
    expect(parseSettingsIssues(message)).toEqual(parsed);
    expect(serverSettingsIssues(message)).toEqual(parsed.map(({ field, message }) => ({ field, zh: message, en: message })));
    expect(parseSettingsIssues("无法保存；quotaTimezone 无效。"))
      .toEqual([{ field: "", message: "无法保存" }, { field: "quotaTimezone", message: "无效。" }]);
    expect(parseSettingsIssues("自动化设置无效：  无法保存  ")).toEqual([{ field: "", message: "无法保存" }]);
    expect(parseSettingsIssues("  fallback  ")).toEqual([{ field: "", message: "fallback" }]);
    expect(serverSettingsIssues("")).toEqual([{ field: "", zh: "", en: "" }]);
  });

  it("selects exact or nested fields in either locale without matching unrelated prefixes", () => {
    const issues: FormIssue[] = [
      { field: "follow", zh: "关注", en: "follow" },
      { field: "follow.batchSize", zh: "批量", en: "batch" },
      { field: "follow.windows", zh: "时间窗", en: "windows" },
      { field: "follow.windows[1]", zh: "第二窗", en: "second" },
      { field: "followback", zh: "无关", en: "unrelated" },
      { field: "unfollow.windows[0]", zh: "取关窗", en: "unfollow window" },
    ];
    expect(issuesFor(issues, "follow", "en")).toEqual(["follow"]);
    expect(issuesFor(issues, "follow", "zh", true)).toEqual(["关注", "批量", "时间窗", "第二窗"]);
    expect(issuesFor(issues, "follow.windows", "en", true)).toEqual(["windows", "second"]);
    expect(issuesFor(issues, "follow.windows[1]", "zh")).toEqual(["第二窗"]);
    expect(issuesFor(issues, "filters", "en", true)).toEqual([]);
  });
});

describe("bilingual settings descriptions", () => {
  it.each([
    ["", "设置", "Settings"], ["scheduleTimezone", "排程时区", "Schedule time zone"],
    ["quotaTimezone", "日上限时区", "Quota time zone"], ["mutualExclusion", "关注与取关互斥", "Mutual exclusion"],
    ["follow.workMinutes", "关注·工作分钟", "Follow·work minutes"],
    ["unfollow.windows[1]", "取关·时间窗 2", "Unfollow·windows 2"],
    ["filters.activity", "过滤·近期活跃", "Filter·recent activity"],
    ["unknown", "unknown", "unknown"], ["custom.field", "custom·field", "custom·field"],
  ])("labels %j", (field, zh, en) => {
    expect(fieldLabel(field, "zh")).toBe(zh);
    expect(fieldLabel(field, "en")).toBe(en);
  });

  it("formats booleans, caps, anchors, windows, and ordinary values in both locales", () => {
    for (const locale of ["zh", "en"] as const) {
      expect(formatSettingValue("mutualExclusion", true, locale)).toBe(locale === "zh" ? "开" : "on");
      expect(formatSettingValue("filters.activity", false, locale)).toBe(locale === "zh" ? "关" : "off");
      expect(formatSettingValue("unfollow.dailyCap", null, locale)).toBe(locale === "zh" ? "不设上限" : "no cap");
      expect(formatSettingValue("follow.anchorMinute", 540, locale)).toBe("09:00");
      expect(formatSettingValue("follow.windows", [{ start: 1380, end: 60 }, { start: 120, end: 1440 }], locale)).toBe("23:00–01:00, 02:00–24:00");
      expect(formatSettingValue("follow.windows", [], locale)).toBe("");
      expect(formatSettingValue("follow.dailyCap", 0, locale)).toBe("0");
      expect(formatSettingValue("scheduleTimezone", "Europe/London", locale)).toBe("Europe/London");
    }
  });

  it("describes changes and lanes using the saved values in zh and en", () => {
    const changes: SettingsChange[] = [
      { field: "follow.batchSize", from: 13, to: 7 },
      { field: "unfollow.dailyCap", from: 80, to: null },
    ];
    expect(describeChanges(changes, "zh")).toBe("关注·每轮人数 13 → 7；取关·日上限 80 → 不设上限");
    expect(describeChanges(changes, "en")).toBe("Follow·batch size 13 → 7; Unfollow·daily cap 80 → no cap");
    expect(describeChanges([], "zh")).toBe("");
    expect(describeChanges([], "en")).toBe("");
    const base = settings();
    base.unfollow.dailyCap = null;
    expect(describeLane("follow", base, "zh")).toBe("每轮 13 · 日上限 350 · 工作 15 / 休息 18 分钟 · 锚点 09:00 · 时间窗 09:00–05:00");
    expect(describeLane("follow", base, "en")).toBe("batch 13 · daily cap 350 · work 15 / rest 18 min · anchor 09:00 · windows 09:00–05:00");
    expect(describeLane("unfollow", base, "zh")).toBe("每轮 10 · 日上限 不设上限 · 工作 30 / 休息 0 分钟 · 锚点 00:15 · 时间窗 05:00–09:00");
    expect(describeLane("unfollow", base, "en")).toBe("batch 10 · daily cap no cap · work 30 / rest 0 min · anchor 00:15 · windows 05:00–09:00");
  });

  it.each([
    ["Asia/Taipei", "台北日历日", "Taipei-day"],
    ["Europe/London", "伦敦每日", "London daily"],
    ["America/New_York", "America/New_York 日历日", "America/New_York-day"],
  ])("labels the quota day in %s", (zone, zh, en) => {
    expect(quotaDayLabel(zone, "zh")).toBe(zh);
    expect(quotaDayLabel(zone, "en")).toBe(en);
  });
});

describe("IANA time zone selection", () => {
  it.each([
    ["Asia/Taipei", "Asia/Taipei"], [" asia/taipei ", "Asia/Taipei"],
    ["US/Eastern", "America/New_York"], ["europe/london", "Europe/London"], ["UTC", "UTC"],
  ])("canonicalizes %j", (value, canonical) => {
    expect(canonicalTimeZone(value)).toBe(canonical);
  });

  it.each([null, undefined, 8, {}, "", "   ", "+08:00", "-0400", "UTC+08:00", "Mars/Olympus", "Asia/Taipei extra", "A".repeat(65)])("rejects non-IANA value %j", (value) => {
    expect(canonicalTimeZone(value)).toBeNull();
  });

  it("puts canonical valid extras first, drops invalid extras and duplicates, and retains common zones", () => {
    const options = timeZoneOptions([" US/Eastern ", "Europe/London", "America/New_York", "Mars/Olympus", "+08:00", ""]);
    expect(options.slice(0, 2)).toEqual(["America/New_York", "Europe/London"]);
    expect(options).toContain("Asia/Taipei");
    expect(options).toContain("Europe/London");
    expect(options).not.toContain("US/Eastern");
    expect(options).not.toContain("Mars/Olympus");
    expect(options.some((zone) => /^[+-]/.test(zone))).toBe(false);
    expect(new Set(options).size).toBe(options.length);
    expect(timeZoneOptions()).toContain("Asia/Taipei");
    expect(timeZoneOptions(["invalid", "+08:00"])).toEqual(timeZoneOptions());
  });

  it("returns a canonical browser zone or null without assuming the host's local zone", () => {
    const zone = browserTimeZone();
    expect(zone === null || (typeof zone === "string" && canonicalTimeZone(zone) === zone)).toBe(true);
  });

  it("canonicalizes a browser alias and returns null for an invalid or unavailable browser zone", () => {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");
    try {
      // Only the browser lookup is mocked; canonicalization still uses the real Intl result.
      resolved.mockReturnValueOnce({ ...options, timeZone: "US/Eastern" });
      expect(browserTimeZone()).toBe("America/New_York");
      resolved.mockReturnValueOnce({ ...options, timeZone: "Mars/Olympus" });
      expect(browserTimeZone()).toBeNull();
      resolved.mockImplementationOnce(() => { throw new RangeError("zone unavailable"); });
      expect(browserTimeZone()).toBeNull();
    } finally {
      resolved.mockRestore();
    }
  });

  it("shows civil date, minute, and offset including London daylight saving", () => {
    const now = new Date("2026-07-01T20:34:56.000Z");
    expect(zoneSnapshot(" asia/taipei ", now)).toEqual({ zone: "Asia/Taipei", day: "2026-07-02", time: "04:34", offset: "GMT+08:00" });
    expect(zoneSnapshot("Europe/London", now)).toEqual({ zone: "Europe/London", day: "2026-07-01", time: "21:34", offset: "GMT+01:00" });
    expect(zoneSnapshot("Europe/London", new Date("2026-01-01T20:34:56.000Z"))).toEqual({ zone: "Europe/London", day: "2026-01-01", time: "20:34", offset: expect.stringMatching(/^GMT(?:\+00:00)?$/) });
    expect(zoneSnapshot("Mars/Olympus", now)).toBeNull();
    expect(zoneSnapshot("+08:00", now)).toBeNull();
  });
});

describe("daily-pool compatibility body", () => {
  it.each([true, false])("copies saved batch sizes and cap with dailyPool=%s and echoes only the legacy new-follow cadence", (dailyPool) => {
    const base = settings();
    base.follow.batchSize = 7;
    base.follow.workMinutes = 19;
    base.follow.restMinutes = 29;
    base.unfollow.batchSize = 4;
    base.unfollow.dailyCap = 123;
    const legacy = { batchSize: 9, workMinutes: 16, restMinutes: 21 };
    const before = structuredClone(base);
    const body = dailyPoolOpsBody(dailyPool, base, legacy);
    expect(body).toEqual({
      accountId: 1,
      ops: { dailyPool, followback: { batchSize: 7 }, newFollow: legacy, unfollow: { batchSize: 4, dailyCap: 123 } },
    });
    expect(body?.ops.newFollow).not.toBe(legacy);
    expect(body?.ops.followback).not.toHaveProperty("workMinutes");
    expect(body?.ops.unfollow).not.toHaveProperty("windows");
    expect(base).toEqual(before);
    expect(legacy).toEqual({ batchSize: 9, workMinutes: 16, restMinutes: 21 });
  });

  it("refuses a legacy body for an uncapped unfollow lane, but preserves a zero cap", () => {
    const base = settings();
    const legacy = { batchSize: 9, workMinutes: 15, restMinutes: 20 };
    base.unfollow.dailyCap = null;
    expect(dailyPoolOpsBody(true, base, legacy)).toBeNull();
    expect(dailyPoolOpsBody(false, base, legacy)).toBeNull();
    base.unfollow.dailyCap = 0;
    expect(dailyPoolOpsBody(true, base, legacy)?.ops.unfollow.dailyCap).toBe(0);
  });
});
