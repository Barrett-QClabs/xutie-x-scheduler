import { afterEach, describe, expect, it } from "vitest";
import { getDb, updateAccount } from "@/lib/db";
import { account1UnfollowSlot, londonUnfollowSlot, unfollowSlot } from "@/lib/london";
import { saveCredentials } from "@/lib/service";
import { importUnfollowCandidates, listUnfollowAudit, setUnfollowPaused, submitUnfollowBatch } from "@/lib/unfollow-queue";

const SLOTS = [
  "03:15", "03:45", "04:15", "04:45", "05:15", "05:45",
  "06:15", "06:45", "07:15", "07:45", "08:15", "08:45",
];

function taipei(hour: number, minute: number, day = "2026-11-12"): Date {
  const utcHour = hour - 8;
  const date = utcHour < 0 ? "2026-11-11" : day;
  const hh = (utcHour + 24) % 24;
  return new Date(`${date}T${String(hh).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
}

function enable(accountId: 1 | 2) {
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
  setUnfollowPaused(accountId, false, "test");
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
});

describe("account 1 Taipei unfollow window", () => {
  it("opens only the twelve :15 and :45 slots from 03:15 through 08:45", () => {
    expect(SLOTS).toHaveLength(12);
    for (const label of SLOTS) {
      const [hour, minute] = label.split(":").map(Number);
      const atStart = taipei(hour, minute);
      const stillOpen = taipei(hour, minute + 14);
      expect(account1UnfollowSlot(atStart)).toBe(`taipei:2026-11-12T${label}`);
      expect(account1UnfollowSlot(stillOpen)).toBe(`taipei:2026-11-12T${label}`);
    }
    expect(account1UnfollowSlot(taipei(2, 59))).toBeNull();
    expect(account1UnfollowSlot(taipei(3, 0))).toBeNull();
    expect(account1UnfollowSlot(taipei(3, 14))).toBeNull();
    expect(account1UnfollowSlot(taipei(8, 44))).toBe("taipei:2026-11-12T08:15");
    expect(account1UnfollowSlot(taipei(8, 45))).toBe("taipei:2026-11-12T08:45");
    expect(account1UnfollowSlot(taipei(8, 59))).toBe("taipei:2026-11-12T08:45");
    expect(account1UnfollowSlot(taipei(9, 0))).toBeNull();
    expect(account1UnfollowSlot(taipei(9, 15))).toBeNull();
    expect(account1UnfollowSlot(taipei(12, 15))).toBeNull();
  });

  it("runs inside the window, skips outside it, and leaves account 2 on London", async () => {
    enable(1);
    enable(2);
    importUnfollowCandidates(1, { candidates: [{ targetUserId: "93001", tier: "non_blue" }] });
    importUnfollowCandidates(2, { candidates: [{ targetUserId: "93002", tier: "non_blue" }] });
    const calls: string[] = [];
    const hooks = {
      inspect: async () => ({
        following: true, blue: false, followsBack: false, lastPostAt: null, lastPostKnown: true,
      }),
      unfollow: async (id: string) => { calls.push(id); },
    };
    const outside = await submitUnfollowBatch({ accountId: 1, now: taipei(9, 0), hooks });
    expect(outside.executed).toBe(false);
    expect(outside.reason).toBe("outside_window");
    expect(outside.slot).toBeNull();
    expect(calls).toEqual([]);

    const beforeOpen = await submitUnfollowBatch({ accountId: 1, now: taipei(3, 14), hooks });
    expect(beforeOpen.reason).toBe("outside_window");
    expect(calls).toEqual([]);

    const inside = await submitUnfollowBatch({ accountId: 1, now: taipei(3, 15), hooks });
    expect(inside.executed).toBe(true);
    expect(inside.slot).toBe("taipei:2026-11-12T03:15");
    expect(inside.unfollowed).toBe(1);
    expect(calls).toEqual(["93001"]);

    const lastMinute = await submitUnfollowBatch({ accountId: 1, now: taipei(8, 59), hooks });
    expect(lastMinute.slot).toBe("taipei:2026-11-12T08:45");
    expect(lastMinute.unfollowed).toBe(0);
    expect(getDb().prepare("SELECT status FROM unfollow_candidates WHERE target_user_id = '93001'").get()).toEqual({ status: "success" });

    const afterClose = await submitUnfollowBatch({ accountId: 1, now: taipei(9, 15), hooks });
    expect(afterClose.reason).toBe("outside_window");

    const londonNow = taipei(9, 15);
    expect(unfollowSlot(2, londonNow)).toBe("2026-11-12T01:15");
    expect(londonUnfollowSlot(londonNow)).toBe("2026-11-12T01:15");
    const account2 = await submitUnfollowBatch({ accountId: 2, now: londonNow, hooks });
    expect(account2.slot).toBe("2026-11-12T01:15");
    expect(account2.unfollowed).toBe(1);
    expect(calls).toEqual(["93001", "93002"]);

    expect(() => listUnfollowAudit(1, { before: "2026-11-12T03:15" })).toThrow(/台北/);
    expect(() => listUnfollowAudit(1, { before: "taipei:2026-11-12T09:15" })).toThrow(/台北/);
    expect(listUnfollowAudit(1, { before: "taipei:2026-11-12T08:45" }).batches.map((item) => item.slot)).toEqual([
      "taipei:2026-11-12T03:15",
    ]);
    expect(() => listUnfollowAudit(2, { before: "taipei:2026-11-12T03:15" })).toThrow(/伦敦/);
    expect(listUnfollowAudit(2, { before: "2026-11-12T01:45" }).batches.map((item) => item.slot)).toEqual([
      "2026-11-12T01:15",
    ]);
  });
});
