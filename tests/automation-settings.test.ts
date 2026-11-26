import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DELETE as resetSettings, GET as readSettings, PUT as writeSettings } from "@/app/api/automation/settings/route";
import { PUT as saveQueue } from "@/app/api/queue/route";
import { accountIdentity } from "@/lib/account-identity";
import { ACCOUNT1_UNFOLLOW_CAP } from "@/lib/account-ops";
import { encryptString } from "@/lib/crypto";
import { defaultAutomationSettings, readAutomationSettings } from "@/lib/automation-settings";
import { getDb, getQueueSettings, reopenDatabase, updateAccount } from "@/lib/db";
import {
  ACCOUNT1_FOLLOW_BATCH_LIMIT,
  ACCOUNT1_FOLLOW_DAILY_CAP,
  ACCOUNT1_FOLLOW_WINDOW_END_MINUTES,
  ACCOUNT1_FOLLOW_ZONE,
  ACCOUNT1_OPEN_START_MINUTES,
  ACCOUNT1_REST_MINUTES,
  ACCOUNT1_WORK_MINUTES,
  ACCOUNT2_FOLLOW_CYCLE_MINUTES,
  ACCOUNT2_FOLLOW_WORK_MINUTES,
  account1UnifiedSlot,
  account2FollowSlot,
  followBatchLimit,
  followCapDay,
  followDailyCap,
  followSlot,
  isFollowAuditCursor,
} from "@/lib/follow-cadence";
import { admitAccount1NewFollows } from "@/lib/follow-new-admission";
import {
  classifyFollow,
  getFollowStatus,
  listFollowAudit,
  setFollowPaused,
  stockFollowReserve,
  submitFollowBatch,
  type FollowProfile,
} from "@/lib/follow-queue";
import { ACCOUNT1_UNFOLLOW_END_MINUTES, ACCOUNT1_UNFOLLOW_START_MINUTES, account1UnfollowSlot, unfollowSlot } from "@/lib/london";
import { pauseQueue, resumeQueue, saveCredentials } from "@/lib/service";
import { FOLLOW_BATCH_LIMIT, FOLLOW_DAILY_CAP, UNFOLLOW_BATCH_LIMIT } from "@/lib/unfollow-policy";
import { getUnfollowStatus, importUnfollowCandidates, setUnfollowPaused, submitUnfollowBatch } from "@/lib/unfollow-queue";

const DAY = "2026-11-18";

function taipei(hour: number, minute: number, day = DAY): Date {
  const text = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  return new Date(Date.parse(text) - 8 * 60 * 60 * 1000);
}

function nextDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

function enable(accountId: 1 | 2) {
  process.env[accountId === 1 ? "XUTIE_ACCOUNT1_FOLLOW" : "XUTIE_ACCOUNT2_FOLLOW"] = "on";
  process.env[accountId === 1 ? "XUTIE_ACCOUNT1_UNFOLLOW" : "XUTIE_ACCOUNT2_UNFOLLOW"] = "on";
  saveCredentials(accountId, {
    apiKey: accountId === 1 ? "acctoneA" : "accttwoB",
    apiSecret: "slot-secret-value",
    accessToken: "token",
    accessTokenSecret: "token-secret",
  });
  updateAccount(accountId, accountId === 1
    ? { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" }
    : { username: "boylittle18", displayName: "Boy", userId: "1468479269701820422" });
  setFollowPaused(accountId, false, "test");
  setUnfollowPaused(accountId, false, "test");
}

async function get(accountId: 1 | 2) {
  return (await readSettings(new Request(`http://local/api/automation/settings?accountId=${accountId}`))).json();
}

function put(accountId: unknown, settings: unknown) {
  return writeSettings(new Request("http://local/api/automation/settings", {
    method: "PUT",
    body: JSON.stringify({ accountId, settings }),
  }));
}

function followbackProfile(): FollowProfile {
  return {
    blue: true, following: false, followsBack: true, followers: 20, name: "中文名", bio: "人工智能",
    username: "fan", tweetLang: "zh", tweetText: "你好", lastPostAt: null, lastPostKnown: false,
  };
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
});

describe("persisted automation settings", () => {
  it("starts both accounts on today's compiled values and reproduces the compiled grids minute by minute", async () => {
    const one = await get(1);
    const two = await get(2);
    expect(one).toMatchObject({ ok: true, accountId: 1, scope: "account", accountScoped: true, stored: false, updatedAt: null });
    expect(one.settings).toEqual(defaultAutomationSettings(1));
    expect(two.settings).toEqual(defaultAutomationSettings(2));
    expect(one.settings).toMatchObject({ scheduleTimezone: ACCOUNT1_FOLLOW_ZONE, quotaTimezone: "Asia/Taipei", mutualExclusion: true });
    expect(one.settings.follow).toEqual({
      batchSize: ACCOUNT1_FOLLOW_BATCH_LIMIT,
      dailyCap: ACCOUNT1_FOLLOW_DAILY_CAP,
      workMinutes: ACCOUNT1_WORK_MINUTES,
      restMinutes: ACCOUNT1_REST_MINUTES,
      anchorMinute: ACCOUNT1_OPEN_START_MINUTES,
      windows: [{ start: ACCOUNT1_OPEN_START_MINUTES, end: ACCOUNT1_FOLLOW_WINDOW_END_MINUTES }],
    });
    expect(one.settings.unfollow).toMatchObject({
      batchSize: UNFOLLOW_BATCH_LIMIT,
      dailyCap: ACCOUNT1_UNFOLLOW_CAP,
      windows: [{ start: ACCOUNT1_UNFOLLOW_START_MINUTES, end: ACCOUNT1_UNFOLLOW_END_MINUTES }],
    });
    expect(two.settings).toMatchObject({ scheduleTimezone: "Asia/Taipei", quotaTimezone: "Europe/London", mutualExclusion: false });
    expect(two.settings.follow).toEqual({
      batchSize: FOLLOW_BATCH_LIMIT,
      dailyCap: FOLLOW_DAILY_CAP,
      workMinutes: ACCOUNT2_FOLLOW_WORK_MINUTES,
      restMinutes: ACCOUNT2_FOLLOW_CYCLE_MINUTES - ACCOUNT2_FOLLOW_WORK_MINUTES,
      anchorMinute: 0,
      windows: [{ start: 0, end: 1440 }],
    });
    expect(two.settings.unfollow).toMatchObject({ batchSize: UNFOLLOW_BATCH_LIMIT, dailyCap: null });
    expect(two.settings.filters).toEqual({ blueVerified: true, language: true, activity: false });
    expect(one.limits.batchSize).toEqual({ min: 1, max: 50 });

    const start = Date.parse("2026-11-10T15:00:00.000Z");
    for (let minute = 0; minute < 30 * 60; minute += 1) {
      const now = new Date(start + minute * 60_000);
      expect(followSlot(1, now)).toBe(account1UnifiedSlot(now));
      expect(followSlot(2, now)).toBe(account2FollowSlot(now));
      expect(unfollowSlot(1, now)).toBe(account1UnfollowSlot(now));
      expect(unfollowSlot(2, now)).toBe(account1UnfollowSlot(now));
    }
    expect(followCapDay(1, new Date("2026-11-10T16:00:00.000Z"))).toBe("2026-11-11");
    expect(followCapDay(2, new Date("2026-11-10T16:00:00.000Z"))).toBe("2026-11-10");
  });

  it("saves through the API, survives a reopened database, and drives slots, batch, cap, and window", async () => {
    enable(1);
    expect(followSlot(1, taipei(14, 35))).toBe(`taipei:${DAY}T14:30`);
    const saved = await put(1, {
      follow: { batchSize: 2, dailyCap: 3, workMinutes: 10, restMinutes: 20, anchorMinute: "10:00", windows: [{ start: "10:00", end: "12:00" }] },
    });
    expect(saved.status).toBe(200);
    reopenDatabase();
    const again = await get(1);
    expect(again.stored).toBe(true);
    expect(typeof again.updatedAt).toBe("string");
    expect(again.settings.follow).toEqual({
      batchSize: 2, dailyCap: 3, workMinutes: 10, restMinutes: 20, anchorMinute: 600, windows: [{ start: 600, end: 720 }],
    });
    expect(followSlot(1, taipei(9, 59))).toBeNull();
    expect(followSlot(1, taipei(10, 0))).toBe(`taipei:${DAY}T10:00`);
    expect(followSlot(1, taipei(10, 9))).toBe(`taipei:${DAY}T10:00`);
    expect(followSlot(1, taipei(10, 10))).toBeNull();
    expect(followSlot(1, taipei(10, 30))).toBe(`taipei:${DAY}T10:30`);
    expect(followSlot(1, taipei(11, 35))).toBe(`taipei:${DAY}T11:30`);
    expect(followSlot(1, taipei(12, 0))).toBeNull();
    expect(followSlot(1, taipei(14, 35))).toBeNull();
    expect(followBatchLimit(1)).toBe(2);
    expect(followDailyCap(1)).toBe(3);

    stockFollowReserve(1, {
      checkedAt: taipei(9, 50).toISOString(),
      candidates: ["93001", "93002", "93003", "93004", "93005", "93006"].map((id) => ({ targetUserId: id, kind: "followback" as const })),
    }, taipei(9, 50));
    const calls: string[] = [];
    const hooks = { inspect: async () => followbackProfile(), follow: async (id: string) => { calls.push(id); } };
    const first = await submitFollowBatch({ accountId: 1, now: taipei(10, 5), hooks });
    expect(first.slot).toBe(`taipei:${DAY}T10:00`);
    expect(first.followed).toBe(2);
    const second = await submitFollowBatch({ accountId: 1, now: taipei(10, 31), hooks });
    expect(second.slot).toBe(`taipei:${DAY}T10:30`);
    expect(second.followed).toBe(1);
    const capped = await submitFollowBatch({ accountId: 1, now: taipei(11, 0), hooks });
    expect(capped.reason).toBe("daily_cap");
    const closed = await submitFollowBatch({ accountId: 1, now: taipei(14, 35), hooks });
    expect(closed.reason).toBe("rest");
    expect(calls).toHaveLength(3);
    expect(getFollowStatus(1, taipei(11, 0))).toMatchObject({ batchSize: 2, dailyCap: 3, followedToday: 3, remainingQuota: 0 });

    expect(followBatchLimit(2)).toBe(10);
    expect(followDailyCap(2)).toBe(380);
    expect(followSlot(2, taipei(14, 35))).toBe(`taipei:${DAY}T14:30`);
    expect((await get(2)).stored).toBe(false);
  });

  it("switches the schedule and quota zones per account without colliding slot keys", async () => {
    const london = await put(2, { timezone: "Europe/London" });
    expect(london.status).toBe(200);
    expect((await london.json()).settings).toMatchObject({ scheduleTimezone: "Europe/London", quotaTimezone: "Europe/London" });
    const at = new Date("2026-11-12T10:00:00.000Z");
    expect(followSlot(2, at)).toBe("tz:Europe/London:2026-11-12T10:00");
    expect(followSlot(1, at)).toBe("taipei:2026-11-12T17:48");
    expect(unfollowSlot(2, new Date("2026-11-12T05:20:00.000Z"))).toBe("tz:Europe/London:2026-11-12T05:15");
    expect(unfollowSlot(2, taipei(5, 20, "2026-11-12"))).toBeNull();
    expect(unfollowSlot(1, taipei(5, 20, "2026-11-12"))).toBe("taipei:2026-11-12T05:15");
    expect(followCapDay(2, new Date("2026-11-12T23:30:00.000Z"))).toBe("2026-11-12");
    expect((await put(2, { quotaTimezone: "asia/taipei" })).status).toBe(200);
    expect(readAutomationSettings(2)).toMatchObject({ scheduleTimezone: "Europe/London", quotaTimezone: "Asia/Taipei" });
    expect(followCapDay(2, new Date("2026-11-12T23:30:00.000Z"))).toBe("2026-11-13");
    expect(followCapDay(1, new Date("2026-11-12T23:30:00.000Z"))).toBe("2026-11-13");

    expect(isFollowAuditCursor(2, "tz:Europe/London:2026-11-12T10:00")).toBe(true);
    expect(isFollowAuditCursor(2, "tz:Europe/London:2026-11-12T10:15")).toBe(false);
    expect(isFollowAuditCursor(1, "tz:Europe/London:2026-11-12T10:00")).toBe(false);
    expect(isFollowAuditCursor(2, "taipei:2026-11-11T00:30")).toBe(true);
    expect(listFollowAudit(2, { before: "tz:Europe/London:2026-11-12T10:00" }).batches).toEqual([]);
    expect(() => listFollowAudit(2, { before: "tz:Europe/London:2026-11-12T10:07" })).toThrow(/已保存关注节奏/);
    const stamp = at.toISOString();
    getDb().prepare(
      `INSERT INTO follow_batches (account_id, slot, status, submitted, followed, results_json, started_at, finished_at)
       VALUES (2, 'taipei:2026-11-11T00:07', 'completed', 0, 0, '[]', ?, ?)`,
    ).run(stamp, stamp);
    expect(isFollowAuditCursor(2, "taipei:2026-11-11T00:07")).toBe(true);
    expect(isFollowAuditCursor(1, "taipei:2026-11-11T00:07")).toBe(false);
  });

  it("rejects invalid input clearly and writes nothing", async () => {
    const bodies: unknown[] = [
      { follow: { batchSize: 0 } },
      { follow: { batchSize: 51 } },
      { follow: { batchSize: 2.5 } },
      { follow: { dailyCap: 401 } },
      { follow: { dailyCap: null } },
      { unfollow: { dailyCap: -1 } },
      { follow: { workMinutes: 0 } },
      { follow: { restMinutes: 721 } },
      { follow: { anchorMinute: "9:00" } },
      { follow: { anchorMinute: 1440 } },
      { follow: { windows: [] } },
      { follow: { windows: [{ start: "25:00", end: "26:00" }] } },
      { follow: { windows: [{ start: "10:00", end: "10:00" }] } },
      { follow: { windows: [{ start: 600 }] } },
      { follow: { windows: [{ start: 600, end: 700, extra: 1 }] } },
      { follow: { color: "blue" } },
      { follow: "fast" },
      { quotaTimezone: "Mars/Olympus" },
      { scheduleTimezone: "+08:00" },
      { quotaTimezone: 8 },
      { timezone: "Asia/Taipei", quotaTimezone: "Europe/London" },
      { mutualExclusion: "yes" },
      { filters: { blueVerified: "no" } },
      { filters: { verified: true } },
      { follow: { windows: [{ start: "08:00", end: "12:00" }] } },
      { nonsense: true },
      "fast",
    ];
    for (const settings of bodies) {
      const response = await put(1, settings);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_settings");
    }
    const named = await (await put(1, { follow: { batchSize: 0 } })).json();
    expect(named.message).toContain("follow.batchSize");
    const overlap = await (await put(1, { follow: { windows: [{ start: "08:00", end: "12:00" }] } })).json();
    expect(overlap.message).toContain("mutualExclusion");
    const unwrapped = await writeSettings(new Request("http://local/api/automation/settings", {
      method: "PUT",
      body: JSON.stringify({ accountId: 1, follow: { batchSize: 5 } }),
    }));
    expect(unwrapped.status).toBe(400);
    const empty = await writeSettings(new Request("http://local/api/automation/settings", {
      method: "PUT",
      body: JSON.stringify({ accountId: 1 }),
    }));
    expect(empty.status).toBe(400);
    const noAccount = await put(undefined, { follow: { batchSize: 5 } });
    expect(noAccount.status).toBe(400);
    expect((await noAccount.json()).code).toBe("account_required");
    expect((await get(1)).stored).toBe(false);
    expect((await get(2)).stored).toBe(false);
    expect(followBatchLimit(1)).toBe(13);
  });

  it("keeps follows out of the unfollow window under mutual exclusion and allows overlap only when it is off", async () => {
    const open = await put(1, { mutualExclusion: false, follow: { windows: [{ start: 0, end: 1440 }] } });
    expect(open.status).toBe(200);
    expect(followSlot(1, taipei(6, 30))).toBe(`taipei:${DAY}T06:27`);
    expect(unfollowSlot(1, taipei(6, 30))).toBe(`taipei:${DAY}T06:15`);
    expect((await put(1, { mutualExclusion: true })).status).toBe(400);
    const narrowed = await put(1, { mutualExclusion: true, follow: { windows: [{ start: "09:00", end: "05:00" }] } });
    expect(narrowed.status).toBe(200);
    expect(followSlot(1, taipei(6, 30))).toBeNull();
    expect(followSlot(1, taipei(9, 5))).toBe(`taipei:${DAY}T09:00`);
    expect(unfollowSlot(1, taipei(6, 30))).toBe(`taipei:${DAY}T06:15`);
  });

  it("keeps account 1 and account 2 settings apart, and resets one account only", async () => {
    expect((await put(2, { follow: { batchSize: 4 }, filters: { activity: true } })).status).toBe(200);
    expect(followBatchLimit(2)).toBe(4);
    expect(followBatchLimit(1)).toBe(13);
    expect(readAutomationSettings(1).filters.activity).toBe(false);
    expect((await get(1)).stored).toBe(false);
    expect((await put(1, { unfollow: { batchSize: 3 } })).status).toBe(200);
    const reset = await resetSettings(new Request("http://local/api/automation/settings?accountId=2", { method: "DELETE" }));
    expect(reset.status).toBe(200);
    expect((await reset.json()).stored).toBe(false);
    expect(followBatchLimit(2)).toBe(10);
    expect(readAutomationSettings(2).filters.activity).toBe(false);
    expect(readAutomationSettings(1).unfollow.batchSize).toBe(3);
  });

  it("carries the values legacy account 1 ops actually ran with, until settings are saved", async () => {
    const stamp = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO follow_account_config (account_id, keywords_json, updated_at, ops_json) VALUES (1, '["AI"]', ?, ?)`,
    ).run(stamp, JSON.stringify({
      dailyPool: true,
      followback: { batchSize: 7 },
      unfollow: { batchSize: 6, dailyCap: 380 },
      newFollow: { batchSize: 9 },
    }));
    expect(readAutomationSettings(1).follow.batchSize).toBe(7);
    expect(readAutomationSettings(1).unfollow).toMatchObject({ batchSize: 6, dailyCap: 80 });
    getDb().prepare("UPDATE follow_account_config SET ops_json = ? WHERE account_id = 1").run(JSON.stringify({
      dailyPool: false,
      followback: { batchSize: 7 },
      unfollow: { batchSize: 6, dailyCap: 40 },
      newFollow: { batchSize: 9 },
    }));
    expect(readAutomationSettings(1).follow.batchSize).toBe(13);
    expect(readAutomationSettings(1).unfollow).toMatchObject({ batchSize: 10, dailyCap: 40 });
    expect(readAutomationSettings(2).follow.batchSize).toBe(10);
    expect((await put(1, { follow: { batchSize: 5 } })).status).toBe(200);
    getDb().prepare("UPDATE follow_account_config SET ops_json = NULL WHERE account_id = 1").run();
    expect(readAutomationSettings(1).follow.batchSize).toBe(5);
    expect(readAutomationSettings(1).unfollow).toMatchObject({ batchSize: 10, dailyCap: 40 });
  });

  it("runs the unfollow lane on the saved batch, cap, window, and quota day", async () => {
    enable(1);
    const saved = await put(1, { unfollow: { batchSize: 2, dailyCap: 3, windows: [{ start: "05:00", end: "07:00" }] } });
    expect(saved.status).toBe(200);
    expect(unfollowSlot(1, taipei(6, 45))).toBe(`taipei:${DAY}T06:45`);
    expect(unfollowSlot(1, taipei(7, 15))).toBeNull();
    expect(unfollowSlot(2, taipei(7, 15))).toBe(`taipei:${DAY}T07:15`);
    importUnfollowCandidates(1, {
      candidates: ["94001", "94002", "94003", "94004", "94005"].map((id) => ({ targetUserId: id, tier: "non_blue" as const })),
    });
    const removed: string[] = [];
    const hooks = {
      inspect: async () => ({ following: true, blue: false, followsBack: false, lastPostAt: null, lastPostKnown: true }),
      unfollow: async (id: string) => { removed.push(id); },
    };
    expect((await submitUnfollowBatch({ accountId: 1, now: taipei(5, 15), hooks })).unfollowed).toBe(2);
    expect((await submitUnfollowBatch({ accountId: 1, now: taipei(5, 45), hooks })).unfollowed).toBe(1);
    expect((await submitUnfollowBatch({ accountId: 1, now: taipei(6, 15), hooks })).reason).toBe("daily_cap");
    expect((await submitUnfollowBatch({ accountId: 1, now: taipei(7, 15), hooks })).reason).toBe("outside_window");
    expect(getUnfollowStatus(1, taipei(6, 20))).toMatchObject({
      batchSize: 2,
      dailyCap: 3,
      unfollowedToday: 3,
      remainingQuota: 0,
      quotaDay: DAY,
      schedule: "work",
    });
    const tomorrow = nextDay(DAY);
    expect((await submitUnfollowBatch({ accountId: 1, now: taipei(5, 15, tomorrow), hooks })).unfollowed).toBe(2);
    expect(removed).toHaveLength(5);
    expect(getUnfollowStatus(2, taipei(6, 20))).toMatchObject({ batchSize: 10, dailyCap: null, remainingQuota: null });
  });

  it("applies filter toggles to screening for the saving account only", async () => {
    const now = taipei(14, 35);
    const english: FollowProfile = {
      blue: false, following: false, followsBack: false, followers: 10, name: "Ada", bio: "hello", username: "ada",
      tweetLang: "en", tweetText: "hello", lastPostAt: null, lastPostKnown: false,
    };
    const chinese: FollowProfile = { ...english, name: "中文名", bio: "人工智能", tweetLang: "zh", tweetText: "今天" };
    expect(classifyFollow({ accountId: 2, kind: "new", profile: english, now })).toMatchObject({ proceed: false, reason: "not_blue" });
    expect((await put(2, { filters: { blueVerified: false } })).status).toBe(200);
    expect(classifyFollow({ accountId: 2, kind: "new", profile: english, now }).proceed).toBe(true);
    expect(classifyFollow({ accountId: 1, kind: "new", profile: chinese, now })).toMatchObject({ proceed: false, reason: "not_blue" });
    expect(classifyFollow({ accountId: 2, kind: "new", profile: chinese, now })).toMatchObject({ proceed: false, reason: "not_english" });
    expect((await put(2, { filters: { language: false } })).status).toBe(200);
    expect(classifyFollow({ accountId: 2, kind: "new", profile: chinese, now }).proceed).toBe(true);
    expect((await put(2, { filters: { activity: true } })).status).toBe(200);
    const stale = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(classifyFollow({ accountId: 2, kind: "new", profile: { ...english, lastPostAt: stale, lastPostKnown: true }, now }))
      .toMatchObject({ proceed: false, result: "skipped", reason: "inactive" });
    expect(classifyFollow({ accountId: 2, kind: "new", profile: english, now }))
      .toMatchObject({ proceed: false, result: "unknown", reason: "activity_unconfirmed" });
    expect(classifyFollow({ accountId: 2, kind: "new", profile: { ...english, lastPostAt: fresh }, now }).proceed).toBe(true);
    expect(classifyFollow({ accountId: 2, kind: "followback", profile: { ...english, followsBack: true }, now }).proceed).toBe(true);
    expect(classifyFollow({ accountId: 1, kind: "new", profile: { ...chinese, blue: true }, now }).proceed).toBe(true);

    const checked = taipei(14, 0).toISOString();
    const snapshot = { verified: false, verifiedType: "none", following: false, lang: "zh", name: "中文名", description: "人工智能" };
    expect(admitAccount1NewFollows([{ targetUserId: "97001", qualificationCheckedAt: checked, snapshot }], now).rejected)
      .toEqual([{ targetUserId: "97001", reason: "not_blue" }]);
    expect((await put(1, { filters: { blueVerified: false } })).status).toBe(200);
    expect(admitAccount1NewFollows([{ targetUserId: "97001", qualificationCheckedAt: checked, snapshot }], now).accepted
      .map((item) => item.targetUserId)).toEqual(["97001"]);
    expect(getFollowStatus(2, now).filters).toEqual({ blueVerified: false, language: false, activity: true });
    expect(getFollowStatus(1, now).filters).toEqual({ blueVerified: false, language: true, activity: false });
  });

  it("leaves posting interval, jitter, and pause/resume adjustable and separate", async () => {
    const response = await saveQueue(new Request("http://local/api/queue", {
      method: "PUT",
      body: JSON.stringify({ accountId: 1, intervalMinutes: 20, randomMinSeconds: 0, randomMaxSeconds: 30 }),
    }));
    expect(response.status).toBe(200);
    expect(getQueueSettings(1)).toMatchObject({ intervalMinutes: 20, randomMinSeconds: 0, randomMaxSeconds: 30, paused: false });
    expect((await put(1, { follow: { batchSize: 5 }, unfollow: { batchSize: 4 } })).status).toBe(200);
    expect(getQueueSettings(1)).toMatchObject({ intervalMinutes: 20, randomMinSeconds: 0, randomMaxSeconds: 30, paused: false });
    pauseQueue(1, "manual");
    expect(getQueueSettings(1).paused).toBe(true);
    resumeQueue(1);
    expect(getQueueSettings(1).paused).toBe(false);
    expect(getQueueSettings(2)).toMatchObject({ intervalMinutes: 15, paused: true });
    expect(readAutomationSettings(1).follow.batchSize).toBe(5);
  });
});

describe("upgrading a database written before settings existed", () => {
  const previousPath = process.env.DATABASE_PATH;

  afterEach(() => {
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    reopenDatabase();
  });

  it("adds the new tables and columns, marks stored identities legacy, and keeps the old effective values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xuti-upgrade-"));
    const file = path.join(dir, "old.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE credentials (
        id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
        ciphertext TEXT NOT NULL,
        username TEXT,
        display_name TEXT,
        user_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE follow_account_config (
        account_id INTEGER PRIMARY KEY CHECK (account_id IN (1, 2)),
        keywords_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ops_json TEXT
      );
    `);
    old.prepare(
      `INSERT INTO credentials (id, ciphertext, username, display_name, user_id, updated_at)
       VALUES (1, ?, 'barrett_tt', 'Barrett', '1933586991612080128', '2026-11-20T00:00:00.000Z')`,
    ).run(encryptString(JSON.stringify({ apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" })));
    old.prepare(
      `INSERT INTO follow_account_config (account_id, keywords_json, updated_at, ops_json)
       VALUES (1, '["AI"]', '2026-11-20T00:00:00.000Z', ?)`,
    ).run(JSON.stringify({ dailyPool: true, followback: { batchSize: 11 }, unfollow: { batchSize: 8, dailyCap: 60 }, newFollow: { batchSize: 9 } }));
    old.close();

    process.env.DATABASE_PATH = file;
    reopenDatabase();
    expect(accountIdentity(1)).toMatchObject({ state: "confirmed", userId: "1933586991612080128", source: "legacy" });
    expect(readAutomationSettings(1)).toMatchObject({ follow: { batchSize: 11 }, unfollow: { batchSize: 8, dailyCap: 60 } });
    expect(readAutomationSettings(2)).toEqual(defaultAutomationSettings(2));
    expect(followSlot(1, taipei(14, 35))).toBe(`taipei:${DAY}T14:30`);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM automation_settings").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_run_authorization").get()).toEqual({ n: 0 });
    reopenDatabase();
    expect(accountIdentity(1).source).toBe("legacy");
  });
});
