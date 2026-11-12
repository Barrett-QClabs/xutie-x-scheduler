import { afterEach, describe, expect, it } from "vitest";
import { getDb, updateAccount } from "@/lib/db";
import {
  ACCOUNT1_NEW_BATCH_LIMIT,
  ACCOUNT1_NEW_CYCLE_MINUTES,
  followBatchLimit,
  followSlot,
} from "@/lib/follow-cadence";
import { listFollowAudit, stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";

function taipei(hour: number, minute: number, day = "2026-11-12"): Date {
  const asUtc = Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
  return new Date(asUtc - 8 * 60 * 60 * 1000);
}

function enable(accountId: 1 | 2) {
  process.env[accountId === 1 ? "XUTIE_ACCOUNT1_FOLLOW" : "XUTIE_ACCOUNT2_FOLLOW"] = "on";
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
}

function profile(kind: "new" | "followback"): FollowProfile {
  return {
    blue: true,
    following: false,
    followsBack: kind === "followback",
    followers: 100,
    name: "中文名",
    bio: "人工智能",
    username: "ada",
    tweetLang: "zh",
    tweetText: "今天发布",
    lastPostAt: "2026-11-12T08:00:00.000Z",
    lastPostKnown: true,
  };
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
});

describe("account 1 evening new-follow window", () => {
  it("runs kind=new only from 18:00 to 24:00, nine per round, with a 20-minute rest", () => {
    expect(ACCOUNT1_NEW_CYCLE_MINUTES).toBe(35);
    expect(ACCOUNT1_NEW_BATCH_LIMIT).toBe(9);
    expect(followSlot(1, taipei(17, 59))).toBeNull();
    expect(followSlot(1, taipei(18, 0))).toBe("taipei-new:2026-11-12T18:00");
    expect(followSlot(1, taipei(18, 14))).toBe("taipei-new:2026-11-12T18:00");
    expect(followSlot(1, taipei(18, 15))).toBeNull();
    expect(followSlot(1, taipei(18, 34))).toBeNull();
    expect(followSlot(1, taipei(18, 35))).toBe("taipei-new:2026-11-12T18:35");
    expect(followSlot(1, taipei(23, 50))).toBe("taipei-new:2026-11-12T23:50");
    expect(followSlot(1, taipei(23, 59))).toBe("taipei-new:2026-11-12T23:50");
    expect(followSlot(1, taipei(0, 0, "2026-11-13"))).toBe("taipei:2026-11-13T00:00");
    expect(followBatchLimit(1, taipei(18, 0))).toBe(9);
    expect(followBatchLimit(1, taipei(0, 5))).toBe(13);
    expect(followSlot(2, taipei(18, 0))).toBe("taipei:2026-11-12T18:00");
    expect(followBatchLimit(2, taipei(18, 0))).toBe(10);
    expect(listFollowAudit(1, { before: "taipei-new:2026-11-12T18:35" }).batches).toEqual([]);
    expect(() => listFollowAudit(1, { before: "taipei-new:2026-11-12T18:01" })).toThrow(/台北关注工作窗/);
    expect(() => listFollowAudit(2, { before: "taipei-new:2026-11-12T18:00" })).toThrow(/台北 :00 或 :30/);
  });

  it("does not follow kind=new in the follow-back window or follow-backs in the evening", async () => {
    enable(1);
    const morning = taipei(0, 5);
    const evening = taipei(18, 5);
    stockFollowReserve(1, {
      checkedAt: morning.toISOString(),
      candidates: [
        { targetUserId: "81001", kind: "new" },
        { targetUserId: "81002", kind: "followback" },
      ],
    }, morning);
    const calls: string[] = [];
    const morningBatch = await submitFollowBatch({
      accountId: 1,
      now: morning,
      hooks: {
        inspect: async (id) => profile(id === "81002" ? "followback" : "new"),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(morningBatch.slot).toBe("taipei:2026-11-12T00:00");
    expect(morningBatch.results.map((item) => item.targetUserId)).toEqual(["81002"]);
    expect(getDb().prepare("SELECT status, kind FROM follow_reserve WHERE target_user_id = '81001'").get()).toEqual({
      status: "reserved",
      kind: "new",
    });

    stockFollowReserve(1, {
      checkedAt: evening.toISOString(),
      candidates: Array.from({ length: 11 }, (_, index) => ({ targetUserId: String(82000 + index), kind: "new" as const })),
    }, evening);
    const eveningBatch = await submitFollowBatch({
      accountId: 1,
      now: evening,
      hooks: {
        inspect: async () => profile("new"),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(eveningBatch.slot).toBe("taipei-new:2026-11-12T18:00");
    expect(eveningBatch.followed).toBe(9);
    expect(eveningBatch.results.every((item) => item.kind === "new")).toBe(true);
    expect(calls[0]).toBe("81002");
    expect(calls.slice(1)).toHaveLength(9);
    expect(calls.slice(1)).not.toContain("81002");
    expect(getDb().prepare("SELECT status FROM follow_reserve WHERE target_user_id = '81002'").get()).toEqual({ status: "followed" });
    const leftNew = getDb().prepare(
      "SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 1 AND kind = 'new' AND status = 'reserved'",
    ).get() as { n: number };
    expect(leftNew.n).toBe(3);
  });
});
