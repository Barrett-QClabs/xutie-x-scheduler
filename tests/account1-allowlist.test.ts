import { afterEach, describe, expect, it } from "vitest";
import { PUT as saveAllowlist, GET as readAllowlist } from "@/app/api/follow/allowlist/route";
import { getDb, reopenDatabase, updateAccount } from "@/lib/db";
import { admitAccount1NewFollows, approveAccount1NewFollow } from "@/lib/follow-new-admission";
import { stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";

const SCREENSHOT_IDS = ["1076751441748873216", "1670271066", "2110667651429384192"] as const;

function taipei(hour: number, minute: number, day = "2026-11-23"): Date {
  const text = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  return new Date(Date.parse(text) - 8 * 60 * 60 * 1000);
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
  getDb().prepare("UPDATE follow_control SET paused = 0 WHERE account_id = ?").run(accountId);
}

function profile(): FollowProfile {
  return {
    blue: true, following: false, followsBack: true, followers: 20, name: "中文名", bio: "人工智能",
    username: "xin", tweetLang: "zh", tweetText: "今天", lastPostAt: null, lastPostKnown: false,
  };
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
});

describe("account 1 execution allowlist", () => {
  it("starts enforced and empty, then follows only the saved ids after approval", async () => {
    enable(1);
    enable(2);
    getDb().prepare("DELETE FROM follow_allowlist_control").run();
    reopenDatabase();
    const initial = await (await readAllowlist(new Request("http://local/api/follow/allowlist?accountId=1"))).json();
    expect(initial).toMatchObject({ accountId: 1, enforced: true, count: 0, preservesHistory: true, touchesBlocklist: false });
    const now = taipei(14, 35);
    stockFollowReserve(1, {
      checkedAt: now.toISOString(),
      candidates: [
        { targetUserId: "91022", kind: "followback" },
        { targetUserId: SCREENSHOT_IDS[0], kind: "followback" },
      ],
    }, now);
    admitAccount1NewFollows([
      {
        targetUserId: "91018",
        username: "old",
        qualificationCheckedAt: "2026-11-13T06:00:00.000Z",
        admittedAt: "2026-11-13T06:00:00.000Z",
        snapshot: { verified: true, verifiedType: "blue", following: false, lang: "zh", name: "旧候选", description: "人工智能" },
      },
      {
        targetUserId: SCREENSHOT_IDS[1],
        username: "mujunchengcs",
        qualificationCheckedAt: now.toISOString(),
        admittedAt: now.toISOString(),
        snapshot: { verified: true, verifiedType: "blue", following: false, lang: "zh", name: "中文名", description: "人工智能" },
      },
    ], now);
    approveAccount1NewFollow({
      approvedStart: taipei(0, 0).toISOString(),
      approvedEnd: taipei(0, 0, "2026-11-24").toISOString(),
    }, now);
    const calls: string[] = [];
    const blocked = await submitFollowBatch({
      accountId: 1,
      now,
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(blocked.followed).toBe(0);
    expect(calls).toEqual([]);
    expect(getDb().prepare("SELECT status FROM follow_reserve WHERE target_user_id = '91022'").get()).toEqual({ status: "reserved" });
    expect(getDb().prepare("SELECT status FROM follow_new_admission WHERE target_user_id = '91018'").get()).toEqual({ status: "admitted" });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_blocklist").get()).toEqual({ n: 0 });

    const saved = await saveAllowlist(new Request("http://local/api/follow/allowlist", {
      method: "PUT",
      body: JSON.stringify({ accountId: 1, enforced: true, targetUserIds: [...SCREENSHOT_IDS] }),
    }));
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.count).toBe(3);
    expect(body.targetUserIds).toEqual([...SCREENSHOT_IDS].slice().sort());
    const locked = await saveAllowlist(new Request("http://local/api/follow/allowlist", {
      method: "PUT",
      body: JSON.stringify({ accountId: 2, enforced: true, targetUserIds: [...SCREENSHOT_IDS] }),
    }));
    expect(locked.status).toBe(400);

    const ran = await submitFollowBatch({
      accountId: 1,
      now,
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(ran.replay).toBe(false);
    expect(calls.slice().sort()).toEqual([SCREENSHOT_IDS[0], SCREENSHOT_IDS[1]].slice().sort());
    expect(calls).not.toContain("91022");
    expect(calls).not.toContain("91018");
    expect(getDb().prepare("SELECT status FROM follow_reserve WHERE target_user_id = '91022'").get()).toEqual({ status: "reserved" });
    expect(getDb().prepare("SELECT status FROM follow_new_admission WHERE target_user_id = '91018'").get()).toEqual({ status: "admitted" });
    expect(getDb().prepare("SELECT status FROM follow_new_admission WHERE target_user_id = ?").get(SCREENSHOT_IDS[1])).toEqual({ status: "followed" });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_blocklist").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE account_id = 1").get()).toEqual({ n: 2 });

    stockFollowReserve(2, {
      checkedAt: now.toISOString(),
      candidates: [{ targetUserId: "92001", kind: "followback" }],
    }, now);
    const other = await submitFollowBatch({
      accountId: 2,
      now,
      hooks: {
        inspect: async () => profile(),
        follow: async (id) => { calls.push(`a2-${id}`); },
      },
    });
    expect(other.followed).toBe(1);
    expect(calls).toContain("a2-92001");
  });
});
