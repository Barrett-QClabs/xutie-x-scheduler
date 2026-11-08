import { afterEach, describe, expect, it } from "vitest";
import { GET as readFollowAudit, POST as submitFollow } from "@/app/api/follow/batches/route";
import { GET as readFollow } from "@/app/api/follow/route";
import { GET as readReserve, POST as stockReserve } from "@/app/api/follow/reserve/route";
import { ACCOUNT2_UNFOLLOW_WHITELIST, UNFOLLOW_WHITELIST } from "@/lib/automation-account";
import { getDb, getQueueSettings, updateAccount } from "@/lib/db";
import { classifyFollow, reserveView, stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { londonClock, londonFollowSlot } from "@/lib/london";
import { importTweets, saveCredentials } from "@/lib/service";
import { xPost } from "@/lib/x-client";

const SECRET = "slot-two-secret-value";
const WORK = new Date("2026-11-08T00:00:00.000Z");

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

const blueEnglish = (over: Partial<FollowProfile> = {}): FollowProfile => ({
  blue: true,
  following: false,
  followsBack: false,
  followers: 100,
  name: "Ada",
  bio: "follow back",
  username: "ada",
  tweetLang: "en",
  tweetText: "hello",
  lastPostAt: new Date(WORK.getTime() - 60 * 60 * 1000).toISOString(),
  lastPostKnown: true,
  ...over,
});

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
});

describe("account 2 follow reserve", () => {
  it("stocks a pool without following, and keeps it off account 1", async () => {
    const posted = importTweets({
      accountId: 2,
      source: "approved english post",
      format: "text",
      startAt: "2026-11-08T06:42:31.000Z",
      intervalMinutes: 15,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
    });
    const stocked = await stockReserve(new Request("http://local/api/follow/reserve", {
      method: "POST",
      body: JSON.stringify({
        accountId: 2,
        checkedAt: new Date().toISOString(),
        candidates: [
          { targetUserId: "81", kind: "followback" },
          { targetUserId: "82", kind: "new" },
        ],
      }),
    }));
    const body = await stocked.json();
    expect(body.accepted).toEqual(["81", "82"]);
    const status = await (await readFollow(new Request("http://local/api/follow?accountId=2"))).json();
    expect(status.enabled).toBe(false);
    expect(status.audience).toBe("en");
    expect(status.reserve.updatedAt).toBeTruthy();
    expect(status.reserve.available).toBe(2);
    expect(status.reserve.followbackAvailable).toBe(1);
    expect(status.reserve.gap).toBe(8);
    expect(status.reserve.constraint).toBe("disabled");
    const page = await (await readReserve(new Request("http://local/api/follow/reserve?accountId=2"))).json();
    expect(page.candidates).toHaveLength(2);
    const account1 = await (await readReserve(new Request("http://local/api/follow/reserve?accountId=1"))).json();
    expect(account1.candidates).toEqual([]);
    expect(account1.audience).toBe("zh");
    expect(getQueueSettings(2).paused).toBe(true);
    const still = getDb().prepare("SELECT text, scheduled_at FROM tweets WHERE account_id = 2").get() as { text: string; scheduled_at: string };
    expect(still).toMatchObject({ text: "approved english post", scheduled_at: posted.queued[0].scheduledAt });
    expect(londonFollowSlot(WORK)).toBe("2026-11-08T00:00");
    expect(londonClock(new Date("2026-07-15T23:00:00.000Z")).day).toBe("2026-07-16");
  });

  it("does not act on a stale reserve or pad a short fresh list", async () => {
    enable(2);
    stockFollowReserve(2, {
      checkedAt: new Date(WORK.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      candidates: [{ targetUserId: "81", kind: "followback" }],
    });
    const calls: string[] = [];
    const stale = await submitFollowBatch({
      accountId: 2,
      now: WORK,
      hooks: {
        inspect: async () => blueEnglish({ followsBack: true }),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(stale.executed).toBe(false);
    expect(stale.reason).toBe("stale_reserve");
    expect(stale.followed).toBe(0);
    expect(calls).toEqual([]);
    const refreshed = stockFollowReserve(2, {
      checkedAt: WORK.toISOString(),
      candidates: [
        { targetUserId: "81", kind: "followback" },
        { targetUserId: "82", kind: "new" },
      ],
    });
    expect(refreshed.refreshed).toContain("81");
    const before = reserveView(2, WORK);
    expect(before.available).toBe(2);
    expect(before.followbackAvailable).toBe(1);
    expect(before.gap).toBe(8);
    expect(before.constraint).toBe("insufficient_candidates");
    const result = await submitFollowBatch({
      accountId: 2,
      now: WORK,
      hooks: {
        inspect: async (id) => blueEnglish({ followsBack: id === "81", tweetLang: id === "82" ? "zh" : "en", name: "中文名", bio: "中文简介" }),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(result.submitted).toBe(2);
    expect(result.followed).toBe(1);
    expect(calls).toEqual(["81"]);
    expect(result.results.find((item) => item.targetUserId === "82")?.reason).toBe("not_english");
    const success = await (await readFollowAudit(new Request("http://local/api/follow/batches?accountId=2"))).json();
    expect(success.batches[0].followed).toBe(1);
    const pool = await (await readReserve(new Request("http://local/api/follow/reserve?accountId=2"))).json();
    expect(pool.candidates.find((item: { targetUserId: string }) => item.targetUserId === "81").status).toBe("followed");
    expect(pool.reserve.available).toBe(0);
  });

  it("rechecks blue before a new english follow and does not retry an unknown result", async () => {
    enable(2);
    stockFollowReserve(2, {
      checkedAt: WORK.toISOString(),
      candidates: [{ targetUserId: "90", kind: "new" }, { targetUserId: "91", kind: "followback" }],
    });
    const calls: string[] = [];
    const first = await submitFollowBatch({
      accountId: 2,
      now: WORK,
      hooks: {
        inspect: async (id) => blueEnglish({ blue: id === "91" ? null : true, followsBack: true }),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(calls).toEqual(["90"]);
    expect(first.results.find((item) => item.targetUserId === "91")?.result).toBe("unknown");
    const again = await submitFollowBatch({
      accountId: 2,
      now: new Date("2026-11-08T00:45:00.000Z"),
      hooks: {
        inspect: async () => blueEnglish({ followsBack: true }),
        follow: async (id) => { calls.push(id); },
      },
    });
    expect(again.submitted).toBe(0);
    expect(calls).toEqual(["90"]);
  });

  it("stops at the london daily cap and never opens a socket in mock mode", async () => {
    enable(2);
    const day = londonClock(WORK).day;
    const insert = getDb().prepare(
      `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
       VALUES (2, ?, NULL, 'new', ?, '2026-11-08T00:00', ?)`,
    );
    for (let index = 0; index < 380; index += 1) insert.run(String(10000 + index), WORK.toISOString(), day);
    stockFollowReserve(2, { checkedAt: WORK.toISOString(), candidates: [{ targetUserId: "7", kind: "followback" }] });
    const calls: string[] = [];
    const capped = await submitFollowBatch({
      accountId: 2,
      now: WORK,
      hooks: { inspect: async () => blueEnglish({ followsBack: true }), follow: async (id) => { calls.push(id); } },
    });
    expect(capped.reason).toBe("daily_cap");
    expect(calls).toEqual([]);
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      throw new Error("network");
    };
    try {
      delete process.env.XUTIE_ACCOUNT2_FOLLOW;
      process.env.XUTIE_ACCOUNT2_FOLLOW = "on";
      const response = await submitFollow(new Request("http://local/api/follow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 2 }),
      }));
      expect((await response.json()).reason).toBe("mock_mode");
      await expect(xPost({ apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" }, "/2/users/1/following", { target_user_id: "2" })).rejects.toThrow(/模拟模式/);
      expect(seen).toEqual([]);
      expect(UNFOLLOW_WHITELIST.size).toBe(7);
      expect(ACCOUNT2_UNFOLLOW_WHITELIST.size).toBe(0);
      expect([...ACCOUNT2_UNFOLLOW_WHITELIST].some((id) => UNFOLLOW_WHITELIST.has(id))).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps a chinese new follow on account 1 and an english one off it", () => {
    const chinese = classifyFollow({
      accountId: 1,
      kind: "new",
      now: WORK,
      profile: blueEnglish({ tweetLang: "zh", name: "中文名", bio: "人工智能", tweetText: "今天发布" }),
    });
    const englishOnChinese = classifyFollow({
      accountId: 1,
      kind: "new",
      now: WORK,
      profile: blueEnglish(),
    });
    expect(chinese.proceed).toBe(true);
    expect(englishOnChinese.reason).toBe("not_chinese");
    expect(classifyFollow({
      accountId: 2,
      kind: "new",
      now: WORK,
      profile: blueEnglish({ followers: 20_001 }),
    }).reason).toBe("too_many_followers");
    expect(classifyFollow({
      accountId: 2,
      kind: "new",
      now: WORK,
      profile: blueEnglish({ blue: false }),
    }).reason).toBe("not_blue");
  });
});
