import { afterEach, describe, expect, it } from "vitest";
import { getDb, updateAccount } from "@/lib/db";
import {
  ACCOUNT1_CYCLE_MINUTES,
  ACCOUNT1_FOLLOW_BATCH_LIMIT,
  followBatchLimit,
  followSlot,
  isFollowAuditCursor,
} from "@/lib/follow-cadence";
import { getFollowStatus, listFollowAudit, stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { londonFollowSlot } from "@/lib/london";
import { saveCredentials } from "@/lib/service";
import { FOLLOW_BATCH_LIMIT, FOLLOW_DAILY_CAP, RESERVE_FRESH_MS } from "@/lib/unfollow-policy";

const SECRET = "slot-two-secret-value";

/** 2026-11-11 03:00 Asia/Taipei. */
const TAIPEI_0300 = new Date("2026-11-10T19:00:00.000Z");

function enable(accountId: 1 | 2) {
  process.env[accountId === 1 ? "XUTIE_ACCOUNT1_FOLLOW" : "XUTIE_ACCOUNT2_FOLLOW"] = "on";
  saveCredentials(accountId, {
    apiKey: accountId === 1 ? "acctoneA" : "accttwoB",
    apiSecret: SECRET,
    accessToken: "token",
    accessTokenSecret: "token-secret",
  });
  updateAccount(accountId, accountId === 1
    ? { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" }
    : { username: "boylittle18", displayName: "Boy", userId: "1468479269701820422" });
  getDb().prepare("UPDATE follow_control SET paused = 0, pause_reason = 'test' WHERE account_id = ?").run(accountId);
}

function profile(over: Partial<FollowProfile> = {}): FollowProfile {
  return {
    blue: true,
    following: false,
    followsBack: true,
    followers: 100,
    name: "中文名",
    bio: "人工智能",
    username: "ada",
    tweetLang: "zh",
    tweetText: "今天发布",
    lastPostAt: new Date(TAIPEI_0300.getTime() - 60 * 60 * 1000).toISOString(),
    lastPostKnown: true,
    ...over,
  };
}

function stock(accountId: 1 | 2, ids: Array<{ id: string; kind: "followback" | "new" }>, checkedAt: string, now: Date) {
  stockFollowReserve(accountId, {
    checkedAt,
    candidates: ids.map((item) => ({ targetUserId: item.id, kind: item.kind })),
  }, now);
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
});

describe("per-account follow cadence", () => {
  it("anchors account 1 at 03:00 Taipei and leaves account 2 on the London clock", () => {
    expect(ACCOUNT1_CYCLE_MINUTES).toBe(33);
    expect(followBatchLimit(1)).toBe(13);
    expect(followBatchLimit(2)).toBe(10);
    expect(FOLLOW_BATCH_LIMIT).toBe(10);
    expect(FOLLOW_DAILY_CAP).toBe(380);
    expect(RESERVE_FRESH_MS).toBe(45 * 60 * 1000);
    expect(RESERVE_FRESH_MS).toBeGreaterThan(ACCOUNT1_CYCLE_MINUTES * 60 * 1000);

    expect(followSlot(1, TAIPEI_0300)).toBe("taipei:2026-11-11T03:00");
    expect(followSlot(1, new Date("2026-11-10T19:14:00.000Z"))).toBe("taipei:2026-11-11T03:00");
    expect(followSlot(1, new Date("2026-11-10T19:15:00.000Z"))).toBeNull();
    expect(followSlot(1, new Date("2026-11-10T19:32:00.000Z"))).toBeNull();
    expect(followSlot(1, new Date("2026-11-10T19:33:00.000Z"))).toBe("taipei:2026-11-11T03:33");
    expect(followSlot(1, new Date("2026-11-10T19:47:00.000Z"))).toBe("taipei:2026-11-11T03:33");
    expect(followSlot(1, new Date("2026-11-10T19:48:00.000Z"))).toBeNull();
    expect(followSlot(1, new Date("2026-11-10T20:06:00.000Z"))).toBe("taipei:2026-11-11T04:06");
    expect(followSlot(1, new Date("2026-11-10T20:20:00.000Z"))).toBe("taipei:2026-11-11T04:06");
    expect(followSlot(1, new Date("2026-11-10T20:21:00.000Z"))).toBeNull();

    expect(followSlot(1, new Date("2026-11-11T15:54:00.000Z"))).toBe("taipei:2026-11-11T23:54");
    expect(followSlot(1, new Date("2026-11-11T16:05:00.000Z"))).toBe("taipei:2026-11-11T23:54");
    expect(followSlot(1, new Date("2026-11-11T16:09:00.000Z"))).toBeNull();
    expect(followSlot(1, new Date("2026-11-11T18:39:00.000Z"))).toBe("taipei:2026-11-12T02:39");
    expect(followSlot(1, new Date("2026-11-11T18:54:00.000Z"))).toBeNull();
    expect(followSlot(1, new Date("2028-02-29T16:04:00.000Z"))).toBe("taipei:2028-02-29T23:54");

    expect(followSlot(2, new Date("2026-11-08T00:00:00.000Z"))).toBe("2026-11-08T00:00");
    expect(followSlot(2, new Date("2026-11-08T00:14:00.000Z"))).toBe("2026-11-08T00:00");
    expect(followSlot(2, new Date("2026-11-08T00:15:00.000Z"))).toBeNull();
    expect(followSlot(2, new Date("2026-07-15T23:00:00.000Z"))).toBe("2026-07-16T00:00");
    expect(londonFollowSlot(new Date("2026-07-15T23:00:00.000Z"))).toBe("2026-07-16T00:00");

    const start = Date.parse("2026-11-10T16:00:00.000Z");
    for (let minute = 0; minute < 48 * 60; minute += 1) {
      const now = new Date(start + minute * 60_000);
      const london = londonFollowSlot(now);
      expect(followSlot(2, now)).toBe(london);
      const taipei = followSlot(1, now);
      if (!taipei) continue;
      expect(taipei.startsWith("taipei:")).toBe(true);
      expect(isFollowAuditCursor(1, taipei)).toBe(true);
      expect(isFollowAuditCursor(2, taipei)).toBe(false);
      expect(taipei).not.toBe(london);
    }

    const duringTaipeiRest = new Date("2026-11-10T20:00:00.000Z");
    expect(getFollowStatus(1, duringTaipeiRest).schedule).toBe("rest");
    expect(getFollowStatus(1, duringTaipeiRest).batchSize).toBe(ACCOUNT1_FOLLOW_BATCH_LIMIT);
    expect(getFollowStatus(1, duringTaipeiRest).londonDay).toBe("2026-11-11");
    expect(getFollowStatus(2, duringTaipeiRest).schedule).toBe("work");
    expect(getFollowStatus(2, duringTaipeiRest).batchSize).toBe(10);
    expect(getFollowStatus(2, duringTaipeiRest).londonDay).toBe("2026-11-10");
    expect(getFollowStatus(2, duringTaipeiRest).dailyCap).toBe(380);
  });

  it("rejects audit cursors that are not that account's work-window starts", () => {
    expect(() => listFollowAudit(1, { before: "2026-11-11T03:00" })).toThrow(/台北关注工作窗/);
    expect(() => listFollowAudit(1, { before: "taipei:2026-11-11T03:01" })).toThrow(/台北关注工作窗/);
    expect(() => listFollowAudit(1, { before: "taipei:2026-02-31T03:00" })).toThrow(/台北关注工作窗/);
    expect(listFollowAudit(1, { before: "taipei:2026-11-11T04:06" }).batches).toEqual([]);
    expect(listFollowAudit(1, { before: "taipei:2026-11-11T23:54" }).batches).toEqual([]);
    expect(() => listFollowAudit(2, { before: "taipei:2026-11-11T03:00" })).toThrow(/伦敦关注工作窗/);
    expect(() => listFollowAudit(2, { before: "2026-11-11T03:33" })).toThrow(/伦敦关注工作窗/);
    expect(listFollowAudit(2, { before: "2026-11-11T03:00" }).batches).toEqual([]);
    expect(listFollowAudit(2, { before: "2026-11-11T03:15" }).batches).toEqual([]);
  });

  it("follows at most 13 blue follow-backs for account 1 and never kind=new", async () => {
    enable(1);
    const ids = [
      ...Array.from({ length: 14 }, (_, index) => ({ id: String(31000 + index), kind: "followback" as const })),
      { id: "31990", kind: "new" as const },
      { id: "31991", kind: "new" as const },
    ];
    stock(1, ids, TAIPEI_0300.toISOString(), TAIPEI_0300);
    const calls: string[] = [];
    const result = await submitFollowBatch({
      accountId: 1,
      now: TAIPEI_0300,
      hooks: {
        inspect: async () => profile(),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(result.slot).toBe("taipei:2026-11-11T03:00");
    expect(result.submitted).toBe(13);
    expect(result.followed).toBe(13);
    expect(result.results.every((item) => item.kind === "followback")).toBe(true);
    expect(calls).toHaveLength(13);
    expect(calls).not.toContain("31990");
    expect(calls).not.toContain("31991");
    const left = getDb().prepare(
      "SELECT target_user_id, kind, status FROM follow_reserve WHERE account_id = 1 AND status = 'reserved' ORDER BY target_user_id",
    ).all() as Array<{ target_user_id: string; kind: string; status: string }>;
    expect(left.map((row) => row.kind).sort()).toEqual(["followback", "new", "new"]);
    const days = getDb().prepare("SELECT DISTINCT london_day AS day FROM follow_success WHERE account_id = 1").all() as Array<{ day: string }>;
    expect(days).toEqual([{ day: "2026-11-11" }]);
  });

  it("does not spend account 1's slot on kind=new, then follows a later follow-back in that same window", async () => {
    enable(1);
    const now = new Date("2026-11-10T19:10:00.000Z");
    stock(1, [{ id: "32001", kind: "new" }], now.toISOString(), now);
    const calls: string[] = [];
    const skipped = await submitFollowBatch({
      accountId: 1,
      now,
      hooks: {
        inspect: async () => profile({ followsBack: false, tweetLang: "zh" }),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(skipped.executed).toBe(false);
    expect(skipped.reason).toBe("insufficient_candidates");
    expect(calls).toEqual([]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_batches WHERE account_id = 1").get()).toEqual({ n: 0 });
    const reserved = getDb().prepare("SELECT status, kind FROM follow_reserve WHERE account_id = 1 AND target_user_id = '32001'").get();
    expect(reserved).toEqual({ status: "reserved", kind: "new" });

    stock(1, [{ id: "32002", kind: "followback" }], now.toISOString(), now);
    const followed = await submitFollowBatch({
      accountId: 1,
      now,
      hooks: {
        inspect: async () => profile(),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(followed.replay).toBe(false);
    expect(followed.followed).toBe(1);
    expect(calls).toEqual(["32002"]);
    stock(1, [{ id: "32003", kind: "followback" }], now.toISOString(), now);
    const replay = await submitFollowBatch({
      accountId: 1,
      now,
      hooks: {
        inspect: async () => { throw new Error("replay must not inspect"); },
        follow: async () => { throw new Error("replay must not follow"); },
      },
    });
    expect(replay.replay).toBe(true);
    expect(replay.slot).toBe("taipei:2026-11-11T03:00");
    expect(replay.followed).toBe(1);
    expect(calls).toEqual(["32002"]);
    const stillNew = getDb().prepare("SELECT status FROM follow_reserve WHERE account_id = 1 AND target_user_id = '32001'").get();
    expect(stillNew).toEqual({ status: "reserved" });
  });

  it("does not replay a historical London slot key for account 1", async () => {
    enable(1);
    const stamp = TAIPEI_0300.toISOString();
    getDb().prepare(
      `INSERT INTO follow_batches (account_id, slot, status, submitted, followed, results_json, started_at, finished_at)
       VALUES (1, '2026-11-11T03:00', 'completed', 10, 10, '[]', ?, ?)`,
    ).run(stamp, stamp);
    stock(1, [{ id: "33001", kind: "followback" }], stamp, TAIPEI_0300);
    const calls: string[] = [];
    const result = await submitFollowBatch({
      accountId: 1,
      now: TAIPEI_0300,
      hooks: {
        inspect: async () => profile(),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(result.replay).toBe(false);
    expect(result.slot).toBe("taipei:2026-11-11T03:00");
    expect(result.followed).toBe(1);
    expect(calls).toEqual(["33001"]);
    const slots = getDb().prepare("SELECT slot FROM follow_batches WHERE account_id = 1 ORDER BY slot").all();
    expect(slots).toEqual([{ slot: "2026-11-11T03:00" }, { slot: "taipei:2026-11-11T03:00" }]);
  });

  it("counts account 1 across London midnight by the Taipei day and keeps account 2 on the London day", async () => {
    enable(1);
    enable(2);
    const early = new Date("2026-11-11T19:05:00.000Z");
    const afterLondonMidnight = new Date("2026-11-12T00:05:00.000Z");
    const calls: string[] = [];
    const hooks = {
      inspect: async () => profile({ tweetLang: "en", name: "Ada", bio: "follow back", tweetText: "hello" }),
      follow: async (id: string) => { calls.push(id); },
    };
    const first = await submitFollowBatch({ accountId: 1, now: early, hooks });
    expect(first.slot).toBe("taipei:2026-11-12T03:00");
    stock(1, [{ id: "34001", kind: "followback" }], early.toISOString(), early);
    expect((await submitFollowBatch({ accountId: 1, now: early, hooks })).followed).toBe(1);

    stock(1, [{ id: "34002", kind: "followback" }], afterLondonMidnight.toISOString(), afterLondonMidnight);
    const second = await submitFollowBatch({ accountId: 1, now: afterLondonMidnight, hooks });
    expect(second.slot).toBe("taipei:2026-11-12T07:57");
    expect(second.followed).toBe(1);
    const taipeiDays = getDb().prepare(
      "SELECT london_day AS day, COUNT(*) AS n FROM follow_success WHERE account_id = 1 GROUP BY london_day",
    ).all();
    expect(taipeiDays).toEqual([{ day: "2026-11-12", n: 2 }]);

    stock(2, [{ id: "34011", kind: "followback" }, { id: "34012", kind: "new" }], early.toISOString(), early);
    const londonEarly = await submitFollowBatch({ accountId: 2, now: early, hooks });
    expect(londonEarly.slot).toBe("2026-11-11T19:00");
    expect(londonEarly.followed).toBe(2);
    const londonDay = getDb().prepare(
      "SELECT london_day AS day FROM follow_success WHERE account_id = 2 ORDER BY target_user_id",
    ).all();
    expect(londonDay).toEqual([{ day: "2026-11-11" }, { day: "2026-11-11" }]);
    expect(calls).toEqual(["34001", "34002", "34011", "34012"]);
  });

  it("stops account 1 on the Taipei day even while London is still on the previous day", async () => {
    enable(1);
    const now = new Date("2026-11-11T19:05:00.000Z");
    const insert = getDb().prepare(
      `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
       VALUES (1, ?, NULL, 'followback', ?, 'taipei:2026-11-12T03:00', '2026-11-12')`,
    );
    for (let index = 0; index < 380; index += 1) insert.run(String(50000 + index), now.toISOString());
    stock(1, [{ id: "34100", kind: "followback" }], now.toISOString(), now);
    const calls: string[] = [];
    const capped = await submitFollowBatch({
      accountId: 1,
      now,
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(capped.reason).toBe("daily_cap");
    expect(capped.slot).toBe("taipei:2026-11-12T03:00");
    expect(calls).toEqual([]);
    expect(getFollowStatus(1, now).londonDay).toBe("2026-11-12");
    expect(getFollowStatus(1, now).followedToday).toBe(380);
    expect(getFollowStatus(2, now).londonDay).toBe("2026-11-11");
    expect(getFollowStatus(2, now).followedToday).toBe(0);
  });

  it("keeps a reserve checked 33 minutes ago and drops one checked 46 minutes ago", async () => {
    enable(1);
    const now = TAIPEI_0300;
    stock(1, [{ id: "35001", kind: "followback" }], new Date(now.getTime() - 33 * 60 * 1000).toISOString(), now);
    const fresh = await submitFollowBatch({
      accountId: 1,
      now,
      hooks: { inspect: async () => profile(), follow: async () => {} },
    });
    expect(fresh.followed).toBe(1);

    const later = new Date("2026-11-10T19:33:00.000Z");
    stock(1, [{ id: "35002", kind: "followback" }], new Date(later.getTime() - 46 * 60 * 1000).toISOString(), later);
    const stale = await submitFollowBatch({
      accountId: 1,
      now: later,
      hooks: { inspect: async () => profile(), follow: async () => { throw new Error("stale"); } },
    });
    expect(stale.executed).toBe(false);
    expect(stale.reason).toBe("stale_reserve");
  });

  it("still lets account 2 take a batch of 10, including kind=new", async () => {
    enable(2);
    const now = new Date("2026-11-08T00:00:00.000Z");
    const ids = [
      ...Array.from({ length: 4 }, (_, index) => ({ id: String(36000 + index), kind: "followback" as const })),
      ...Array.from({ length: 8 }, (_, index) => ({ id: String(36100 + index), kind: "new" as const })),
    ];
    stock(2, ids, now.toISOString(), now);
    const calls: string[] = [];
    const result = await submitFollowBatch({
      accountId: 2,
      now,
      hooks: {
        inspect: async () => profile({ tweetLang: "en", name: "Ada", bio: "follow back", tweetText: "hello" }),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(result.slot).toBe("2026-11-08T00:00");
    expect(result.submitted).toBe(10);
    expect(result.followed).toBe(10);
    expect(result.results.filter((item) => item.kind === "followback")).toHaveLength(4);
    expect(result.results.filter((item) => item.kind === "new")).toHaveLength(6);
    expect(calls).toHaveLength(10);
    const day = getDb().prepare("SELECT DISTINCT london_day AS day FROM follow_success WHERE account_id = 2").get();
    expect(day).toEqual({ day: "2026-11-08" });
  });
});
