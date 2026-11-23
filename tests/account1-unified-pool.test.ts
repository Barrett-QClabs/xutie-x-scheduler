import { afterEach, describe, expect, it } from "vitest";
import { getDb, reopenDatabase, updateAccount } from "@/lib/db";
import { approveAccount1NewFollow } from "@/lib/follow-new-admission";
import { ACCOUNT1_FOLLOW_DAILY_CAP, ACCOUNT1_UNFOLLOW_BASELINE_AT, followSlot } from "@/lib/follow-cadence";
import { getFollowStatus, stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";
import { submitUnfollowBatch } from "@/lib/unfollow-queue";
import { FOLLOW_DAILY_CAP } from "@/lib/unfollow-policy";

function taipei(hour: number, minute: number, day = "2026-11-23"): Date {
  const text = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  return new Date(Date.parse(text) - 8 * 60 * 60 * 1000);
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
  getDb().prepare("UPDATE follow_control SET paused = 0, pause_reason = 'test' WHERE account_id = ?").run(accountId);
  getDb().prepare("UPDATE unfollow_control SET paused = 0, pause_reason = 'test' WHERE account_id = ?").run(accountId);
}

function profile(over: Partial<FollowProfile> = {}): FollowProfile {
  return {
    blue: true,
    following: false,
    followsBack: true,
    followers: 20,
    name: "中文名",
    bio: "人工智能",
    username: "xin",
    tweetLang: "zh",
    tweetText: "今天",
    lastPostAt: null,
    lastPostKnown: false,
    ...over,
  };
}

function stock(ids: Array<{ id: string; kind: "followback" | "new" }>, when: Date) {
  return stockFollowReserve(1, {
    checkedAt: when.toISOString(),
    candidates: ids.map((item) => ({ targetUserId: item.id, kind: item.kind })),
  }, when);
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
});

describe("account 1 unified permanent pool", () => {
  it("keeps 14:35 inside a work slot, stays closed 05:00–09:00, and resumes at 09:00", () => {
    const day = "2026-11-23";
    expect(ACCOUNT1_UNFOLLOW_BASELINE_AT).toBe("2026-11-23T06:27:00.000Z");
    expect(followSlot(1, taipei(14, 35, day))).toBe("taipei:2026-11-23T14:30");
    expect(followSlot(1, taipei(5, 0, day))).toBeNull();
    expect(followSlot(1, taipei(7, 15, day))).toBeNull();
    expect(followSlot(1, taipei(8, 59, day))).toBeNull();
    expect(followSlot(1, taipei(9, 0, day))).toBe("taipei:2026-11-23T09:00");
    expect(followSlot(1, taipei(9, 14, day))).toBe("taipei:2026-11-23T09:00");
    expect(followSlot(1, taipei(9, 15, day))).toBeNull();
    expect(followSlot(2, taipei(7, 0, day))).toBe("taipei:2026-11-23T07:00");
    expect(FOLLOW_DAILY_CAP).toBe(380);
    expect(ACCOUNT1_FOLLOW_DAILY_CAP).toBe(350);
  });

  it("does not follow during 05:00–09:00 and follows again at 09:00", async () => {
    enable(1);
    const quiet = taipei(6, 30);
    stock([{ id: "91001", kind: "followback" }], quiet);
    const calls: string[] = [];
    const closed = await submitFollowBatch({
      accountId: 1,
      now: quiet,
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(closed.reason).toBe("rest");
    expect(closed.followed).toBe(0);
    expect(calls).toEqual([]);
    const resumed = await submitFollowBatch({
      accountId: 1,
      now: taipei(9, 5),
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(resumed.slot).toBe("taipei:2026-11-23T09:00");
    expect(resumed.followed).toBe(1);
    expect(calls).toEqual(["91001"]);
  });

  it("draws follow and follow-back from one pool without repeating or expiring across days", async () => {
    enable(1);
    const firstDay = taipei(14, 35, "2026-11-22");
    const secondDay = taipei(14, 35, "2026-11-23");
    approveAccount1NewFollow({
      approvedStart: taipei(0, 0, "2026-11-23").toISOString(),
      approvedEnd: taipei(0, 0, "2026-11-24").toISOString(),
    }, secondDay);
    stock([
      { id: "81001", kind: "followback" },
      { id: "81002", kind: "new" },
      { id: "81003", kind: "followback" },
    ], firstDay);
    stock([{ id: "81001", kind: "followback" }], secondDay);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 1").get()).toEqual({ n: 3 });
    const draws = [0, 0, 0];
    let cursor = 0;
    const calls: string[] = [];
    const batch = await submitFollowBatch({
      accountId: 1,
      now: secondDay,
      random: () => draws[cursor++] ?? 0,
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(batch.slot).toBe("taipei:2026-11-23T14:30");
    expect(calls).toEqual(["81002", "81003", "81001"]);
    expect(new Set(calls).size).toBe(3);
    expect(getDb().prepare("SELECT checked_at FROM follow_reserve WHERE target_user_id = '81002'").get()).toEqual({
      checked_at: firstDay.toISOString(),
    });
    const again = await submitFollowBatch({
      accountId: 1,
      now: secondDay,
      hooks: {
        inspect: async () => { throw new Error("completed slot"); },
        follow: async () => { throw new Error("completed slot"); },
      },
    });
    expect(again.replay).toBe(true);
    expect(again.followed).toBe(3);
    expect(stock([{ id: "81001", kind: "followback" }], secondDay).rejected.map((item) => item.reason)).toEqual(["already_followed"]);
  });

  it("counts follow and follow-back together through midnight and stops at 350", async () => {
    enable(1);
    approveAccount1NewFollow({
      approvedStart: taipei(0, 0, "2026-11-22").toISOString(),
      approvedEnd: taipei(0, 0, "2026-11-23").toISOString(),
    }, taipei(14, 35, "2026-11-22"));
    const insert = getDb().prepare(
      `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
       VALUES (1, ?, NULL, ?, ?, 'taipei:2026-11-22T14:30', '2026-11-22')`,
    );
    for (let index = 0; index < 349; index += 1) {
      insert.run(String(60000 + index), index % 2 === 0 ? "followback" : "new", taipei(23, 50, "2026-11-22").toISOString());
    }
    stock([{ id: "82001", kind: "followback" }, { id: "82002", kind: "followback" }], taipei(23, 50, "2026-11-22"));
    const calls: string[] = [];
    const evening = await submitFollowBatch({
      accountId: 1,
      now: taipei(23, 51, "2026-11-22"),
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(evening.followed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(getFollowStatus(1, taipei(23, 55, "2026-11-22")).followedToday).toBe(350);
    expect(getFollowStatus(1, taipei(23, 55, "2026-11-22")).remainingQuota).toBe(0);
    const blocked = await submitFollowBatch({
      accountId: 1,
      now: taipei(0, 24, "2026-11-23"),
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(`late-${id}`); } },
    });
    expect(blocked.reason).not.toBe("daily_cap");
    expect(getFollowStatus(1, taipei(0, 24, "2026-11-23")).londonDay).toBe("2026-11-23");
    expect(getFollowStatus(1, taipei(0, 24, "2026-11-23")).followedToday).toBe(blocked.followed);
    expect(blocked.followed).toBe(1);
    for (let index = 0; index < 349 - blocked.followed; index += 1) {
      getDb().prepare(
        `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
         VALUES (1, ?, NULL, 'followback', ?, 'taipei:2026-11-23T00:24', '2026-11-23')`,
      ).run(String(70000 + index), taipei(0, 24, "2026-11-23").toISOString());
    }
    getDb().prepare(
      `INSERT INTO follow_inflight (account_id, target_user_id, cap_day, claimed_at) VALUES (1, '83999', '2026-11-23', ?)`,
    ).run(taipei(0, 30, "2026-11-23").toISOString());
    stock([{ id: "82003", kind: "followback" }], taipei(0, 30, "2026-11-23"));
    const capped = await submitFollowBatch({
      accountId: 1,
      now: taipei(0, 30, "2026-11-23"),
      hooks: { inspect: async () => { throw new Error("over cap"); }, follow: async () => { throw new Error("over cap"); } },
    });
    expect(capped.reason).toBe("daily_cap");
    expect(getFollowStatus(1, taipei(0, 30, "2026-11-23")).dailyCap).toBe(350);
    expect(getFollowStatus(2, taipei(0, 30, "2026-11-23")).dailyCap).toBe(380);
  });

  it("keeps a completed slot from running again and migrates the blocklist once", async () => {
    enable(1);
    const now = taipei(14, 35);
    getDb().prepare(
      `INSERT INTO follow_batches (account_id, slot, status, submitted, followed, results_json, started_at, finished_at)
       VALUES (1, 'taipei:2026-11-23T14:30', 'completed', 1, 1, '[]', ?, ?)`,
    ).run(now.toISOString(), now.toISOString());
    getDb().prepare(
      `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
       VALUES (1, '84001', NULL, 'followback', ?, 'taipei:2026-11-23T14:30', '2026-11-23')`,
    ).run(now.toISOString());
    getDb().prepare(
      `INSERT INTO unfollow_candidates
        (account_id, target_user_id, username, tier, status, result, created_at, updated_at)
       VALUES (1, '85001', NULL, 'non_blue', 'success', 'success', ?, ?)`,
    ).run("2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z");
    getDb().prepare(
      `INSERT INTO unfollow_candidates
        (account_id, target_user_id, username, tier, status, result, created_at, updated_at)
       VALUES (1, '85002', NULL, 'non_blue', 'candidate', NULL, ?, ?)`,
    ).run("2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    reopenDatabase();
    reopenDatabase();
    const blocks = getDb().prepare(
      "SELECT target_user_id, source FROM follow_blocklist WHERE account_id = 1 ORDER BY target_user_id",
    ).all();
    expect(blocks).toEqual([{ target_user_id: "85001", source: "unfollow_confirmed" }]);
    expect(getDb().prepare("SELECT slot, status FROM follow_batches WHERE account_id = 1").all()).toEqual([
      { slot: "taipei:2026-11-23T14:30", status: "completed" },
    ]);
    stock([{ id: "84002", kind: "followback" }, { id: "85001", kind: "followback" }, { id: "85002", kind: "new" }], now);
    const replay = await submitFollowBatch({
      accountId: 1,
      now,
      hooks: {
        inspect: async () => { throw new Error("replay"); },
        follow: async () => { throw new Error("replay"); },
      },
    });
    expect(replay.replay).toBe(true);
    expect(replay.followed).toBe(1);
    const rejected = stock([{ id: "85001", kind: "followback" }], now).rejected.map((item) => item.reason);
    expect(rejected).toEqual(["unfollowed"]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_success WHERE account_id = 1").get()).toEqual({ n: 1 });
  });

  it("records a new unfollow on the blocklist and refuses that person before the next follow", async () => {
    enable(1);
    const now = taipei(5, 20);
    getDb().prepare(
      `INSERT INTO unfollow_candidates
        (account_id, target_user_id, username, tier, followed_at, status, created_at, updated_at)
       VALUES (1, '86001', NULL, 'non_blue', ?, 'candidate', ?, ?)`,
    ).run(new Date(now.getTime() - 80 * 60 * 60 * 1000).toISOString(), now.toISOString(), now.toISOString());
    const unfollowed = await submitUnfollowBatch({
      accountId: 1,
      now,
      hooks: {
        inspect: async () => ({ following: true, blue: false, followsBack: false, lastPostAt: null, lastPostKnown: false }),
        unfollow: async () => undefined,
      },
    });
    expect(unfollowed.unfollowed).toBe(1);
    expect(getDb().prepare("SELECT source FROM follow_blocklist WHERE target_user_id = '86001'").get()).toEqual({
      source: "unfollow_success",
    });
    const later = taipei(9, 5);
    const rejected = stock([{ id: "86001", kind: "followback" }], later);
    expect(rejected.rejected).toEqual([{ targetUserId: "86001", reason: "unfollowed" }]);
    stock([{ id: "86002", kind: "followback" }], later);
    getDb().prepare(
      `INSERT OR IGNORE INTO follow_blocklist (account_id, target_user_id, source, blocked_at)
       VALUES (1, '86002', 'unfollow_success', ?)`,
    ).run(later.toISOString());
    const calls: string[] = [];
    const batch = await submitFollowBatch({
      accountId: 1,
      now: later,
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(calls).toEqual([]);
    expect(batch.followed).toBe(0);
    expect(batch.reason).toBe("insufficient_candidates");
  });

  it("stops the account 1 batch on a rate limit and leaves account 2 off that blocklist", async () => {
    enable(1);
    enable(2);
    const now = taipei(14, 35);
    stock([{ id: "87001", kind: "followback" }, { id: "87002", kind: "followback" }], now);
    const calls: string[] = [];
    const stopped = await submitFollowBatch({
      accountId: 1,
      now,
      random: () => 0.99,
      hooks: {
        inspect: async () => profile(),
        follow: async (id) => {
          calls.push(id);
          throw Object.assign(new Error("slow down"), { status: 429, kind: "rate_limit" });
        },
      },
    });
    expect(calls).toEqual(["87001"]);
    expect(stopped.followed).toBe(0);
    expect(getDb().prepare("SELECT pause_reason FROM follow_control WHERE account_id = 1").get()).toEqual({ pause_reason: "rate_limit" });
    expect(getDb().prepare("SELECT status FROM follow_reserve WHERE target_user_id = '87002'").get()).toEqual({ status: "reserved" });
    stockFollowReserve(2, {
      checkedAt: now.toISOString(),
      candidates: [{ targetUserId: "87003", kind: "followback" }],
    }, now);
    const other = await submitFollowBatch({
      accountId: 2,
      now,
      hooks: {
        inspect: async () => profile({ tweetLang: "en", name: "Ada", bio: "business", tweetText: "hello", followsBack: true }),
        follow: async () => undefined,
      },
    });
    expect(other.followed).toBe(1);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_blocklist WHERE account_id = 2").get()).toEqual({ n: 0 });
    expect(getFollowStatus(2, now).dailyCap).toBe(380);
  });
});
