import { afterEach, describe, expect, it } from "vitest";
import { quotaDayRange, saveAutomationSettings } from "@/lib/automation-settings";
import { updateAccount } from "@/lib/db";
import { followCapDay } from "@/lib/follow-cadence";
import { getFollowStatus, setFollowPaused, stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";
import { getUnfollowStatus, importUnfollowCandidates, setUnfollowPaused, submitUnfollowBatch } from "@/lib/unfollow-queue";
import { zonedDayRange } from "@/lib/zoned-clock";

/** Local midnight that starts 2026-11-10 in each zone (London on GMT, New York on EST after 2026-11-01). */
const CASES = [
  { zone: "Europe/London", midnight: "2026-11-10T00:00:00.000Z" },
  { zone: "Asia/Taipei", midnight: "2026-11-09T16:00:00.000Z" },
  { zone: "America/New_York", midnight: "2026-11-10T05:00:00.000Z" },
];

const DAY = "2026-11-10";
const PREVIOUS = "2026-11-09";

function enable() {
  process.env.XUTIE_ACCOUNT2_FOLLOW = "on";
  process.env.XUTIE_ACCOUNT2_UNFOLLOW = "on";
  saveCredentials(2, {
    apiKey: "accttwoB",
    apiSecret: "slot-secret-value",
    accessToken: "token",
    accessTokenSecret: "token-secret",
  });
  updateAccount(2, { username: "boylittle18", displayName: "Boy", userId: "1468479269701820422" });
  setFollowPaused(2, false, "test");
  setUnfollowPaused(2, false, "test");
}

function followback(): FollowProfile {
  return {
    blue: true, following: false, followsBack: true, followers: 20, name: "Ada", bio: "hello", username: "ada",
    tweetLang: "en", tweetText: "hello", lastPostAt: null, lastPostKnown: false,
  };
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
});

describe("quota day boundaries follow the saved IANA zone", () => {
  it.each(CASES)("resets the follow and unfollow caps at $zone midnight", async ({ zone, midnight }) => {
    enable();
    saveAutomationSettings(2, {
      quotaTimezone: zone,
      follow: { dailyCap: 2 },
      unfollow: { dailyCap: 1, windows: [{ start: 0, end: 1440 }] },
    });
    const base = Date.parse(midnight);
    const at = (minutes: number) => new Date(base + minutes * 60_000);
    expect(followCapDay(2, at(-1))).toBe(PREVIOUS);
    expect(followCapDay(2, at(0))).toBe(DAY);
    expect(quotaDayRange(2, at(0)).start.toISOString()).toBe(midnight);
    expect(quotaDayRange(2, at(-1)).end.toISOString()).toBe(midnight);
    expect(getFollowStatus(1, at(0)).quotaTimezone).toBe("Asia/Taipei");

    const followed: string[] = [];
    const hooks = { inspect: async () => followback(), follow: async (id: string) => { followed.push(id); } };
    stockFollowReserve(2, {
      checkedAt: at(-60).toISOString(),
      candidates: ["71001", "71002", "71003"].map((id) => ({ targetUserId: id, kind: "followback" as const })),
    }, at(-60));
    const before = await submitFollowBatch({ accountId: 2, now: at(-60), hooks });
    expect(before.followed).toBe(2);
    const capped = await submitFollowBatch({ accountId: 2, now: at(-30), hooks });
    expect(capped.reason).toBe("daily_cap");
    expect(getFollowStatus(2, at(-1))).toMatchObject({ quotaDay: PREVIOUS, quotaTimezone: zone, followedToday: 2, remainingQuota: 0 });
    expect(getFollowStatus(2, at(0))).toMatchObject({ quotaDay: DAY, followedToday: 0, remainingQuota: 2 });
    stockFollowReserve(2, {
      checkedAt: at(0).toISOString(),
      candidates: ["71004", "71005"].map((id) => ({ targetUserId: id, kind: "followback" as const })),
    }, at(0));
    const after = await submitFollowBatch({ accountId: 2, now: at(0), hooks });
    expect(after.followed).toBe(2);
    expect(followed).toEqual(["71001", "71002", "71004", "71005"]);

    importUnfollowCandidates(2, {
      candidates: ["72001", "72002", "72003"].map((id) => ({ targetUserId: id, tier: "non_blue" as const })),
    });
    const removed: string[] = [];
    const unfollowHooks = {
      inspect: async () => ({ following: true, blue: false, followsBack: false, lastPostAt: null, lastPostKnown: true }),
      unfollow: async (id: string) => { removed.push(id); },
    };
    expect((await submitUnfollowBatch({ accountId: 2, now: at(-45), hooks: unfollowHooks })).unfollowed).toBe(1);
    expect((await submitUnfollowBatch({ accountId: 2, now: at(-15), hooks: unfollowHooks })).reason).toBe("daily_cap");
    expect(getUnfollowStatus(2, at(-1))).toMatchObject({ quotaDay: PREVIOUS, unfollowedToday: 1, remainingQuota: 0 });
    expect(getUnfollowStatus(2, at(0))).toMatchObject({ quotaDay: DAY, unfollowedToday: 0, remainingQuota: 1 });
    expect((await submitUnfollowBatch({ accountId: 2, now: at(15), hooks: unfollowHooks })).unfollowed).toBe(1);
    expect(getUnfollowStatus(2, at(16))).toMatchObject({ quotaDay: DAY, unfollowedToday: 1, remainingQuota: 0 });
    expect(removed).toHaveLength(2);
  });

  it("keeps account 1 on its Taipei quota day while account 2 moves to another zone", () => {
    saveAutomationSettings(2, { quotaTimezone: "America/New_York" });
    const instant = new Date("2026-11-10T03:00:00.000Z");
    expect(followCapDay(1, instant)).toBe("2026-11-10");
    expect(followCapDay(2, instant)).toBe("2026-11-09");
    expect(getFollowStatus(1, instant)).toMatchObject({ quotaDay: "2026-11-10", quotaTimezone: "Asia/Taipei" });
    expect(getFollowStatus(2, instant)).toMatchObject({ quotaDay: "2026-11-09", quotaTimezone: "America/New_York" });
  });

  it("measures 23- and 25-hour days from the zone itself", () => {
    const londonFall = zonedDayRange(new Date("2026-10-25T12:00:00.000Z"), "Europe/London");
    expect(londonFall.day).toBe("2026-10-25");
    expect(londonFall.start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(londonFall.end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    const londonSpring = zonedDayRange(new Date("2026-03-29T12:00:00.000Z"), "Europe/London");
    expect(londonSpring.start.toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(londonSpring.end.toISOString()).toBe("2026-03-29T23:00:00.000Z");
    const newYork = zonedDayRange(new Date("2026-11-01T12:00:00.000Z"), "America/New_York");
    expect(newYork.day).toBe("2026-11-01");
    expect(newYork.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(newYork.end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const taipei = zonedDayRange(new Date("2026-11-01T12:00:00.000Z"), "Asia/Taipei");
    expect(taipei.day).toBe("2026-11-01");
    expect(taipei.start.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    expect(taipei.end.toISOString()).toBe("2026-11-01T16:00:00.000Z");
  });
});
