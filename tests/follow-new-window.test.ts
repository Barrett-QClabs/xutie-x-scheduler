import { afterEach, describe, expect, it } from "vitest";
import { getDb, updateAccount } from "@/lib/db";
import {
  ACCOUNT1_NEW_BATCH_LIMIT,
  ACCOUNT1_NEW_CYCLE_MINUTES,
  followBatchLimit,
  followSlot,
} from "@/lib/follow-cadence";
import { approveAccount1NewFollow } from "@/lib/follow-new-admission";
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

describe("account 1 unified follow window", () => {
  it("keeps the 15/18 cadence outside 05:00–09:00 and still accepts old evening cursors", () => {
    expect(ACCOUNT1_NEW_CYCLE_MINUTES).toBe(35);
    expect(ACCOUNT1_NEW_BATCH_LIMIT).toBe(9);
    expect(followSlot(1, taipei(5, 0))).toBeNull();
    expect(followSlot(1, taipei(8, 59))).toBeNull();
    expect(followSlot(1, taipei(17, 48))).toBe("taipei:2026-11-12T17:48");
    expect(followSlot(1, taipei(18, 0))).toBe("taipei:2026-11-12T17:48");
    expect(followSlot(1, taipei(18, 2))).toBe("taipei:2026-11-12T17:48");
    expect(followSlot(1, taipei(18, 3))).toBeNull();
    expect(followSlot(1, taipei(18, 21))).toBe("taipei:2026-11-12T18:21");
    expect(followSlot(1, taipei(23, 51))).toBe("taipei:2026-11-12T23:51");
    expect(followSlot(1, taipei(0, 0, "2026-11-13"))).toBe("taipei:2026-11-12T23:51");
    expect(followBatchLimit(1, taipei(18, 0))).toBe(13);
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
    const evening = taipei(18, 0);
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
    expect(morningBatch.slot).toBe("taipei:2026-11-11T23:51");
    expect(morningBatch.results.map((item) => item.targetUserId)).toEqual(["81002"]);
    expect(getDb().prepare("SELECT status, kind FROM follow_reserve WHERE target_user_id = '81001'").get()).toEqual({
      status: "reserved",
      kind: "new",
    });

    stockFollowReserve(1, {
      checkedAt: evening.toISOString(),
      candidates: Array.from({ length: 11 }, (_, index) => ({ targetUserId: String(82000 + index), kind: "new" as const })),
    }, evening);
    approveAccount1NewFollow({
      approvedStart: taipei(18, 0).toISOString(),
      approvedEnd: taipei(0, 0, "2026-11-13").toISOString(),
    }, evening);
    const eveningBatch = await submitFollowBatch({
      accountId: 1,
      now: evening,
      hooks: {
        inspect: async () => profile("new"),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(eveningBatch.slot).toBe("taipei:2026-11-12T17:48");
    expect(eveningBatch.followed).toBe(12);
    expect(eveningBatch.results.every((item) => item.kind === "new")).toBe(true);
    expect(calls[0]).toBe("81002");
    expect(calls).toContain("81001");
    expect(calls.filter((id) => id !== "81002")).toHaveLength(12);
    expect(getDb().prepare("SELECT status FROM follow_reserve WHERE target_user_id = '81002'").get()).toEqual({ status: "followed" });
    const leftNew = getDb().prepare(
      "SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 1 AND kind = 'new' AND status = 'reserved'",
    ).get() as { n: number };
    expect(leftNew.n).toBe(0);
  });
});
