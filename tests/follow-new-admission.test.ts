import { afterEach, describe, expect, it } from "vitest";
import { POST as postAdmission } from "@/app/api/follow/new-admission/route";
import { POST as postApproval } from "@/app/api/follow/new-approval/route";
import { getDb, updateAccount } from "@/lib/db";
import { admitAccount1NewFollows, approveAccount1NewFollow } from "@/lib/follow-new-admission";
import { getFollowStatus, stockFollowReserve, submitFollowBatch } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";
import { submitUnfollowBatch } from "@/lib/unfollow-queue";
import { UNFOLLOW_WHITELIST } from "@/lib/automation-account";

const CHECKED = "2026-11-12T02:00:00.000Z";

function taipei(hour: number, minute: number, day = "2026-11-12"): Date {
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
  getDb().prepare("UPDATE follow_control SET paused = 0, pause_reason = 'test' WHERE account_id = ?").run(accountId);
}

function candidate(id: string, over: Record<string, unknown> = {}) {
  return {
    targetUserId: id,
    username: "xinren",
    qualificationCheckedAt: CHECKED,
    admittedAt: CHECKED,
    snapshot: {
      verified: true,
      verifiedType: "blue",
      following: false,
      lang: "zh",
      name: "中文名",
      description: "人工智能",
    },
    ...over,
  };
}

function approveDay(day = "2026-11-12") {
  const start = taipei(0, 0, day).toISOString();
  const end = taipei(0, 0, day === "2026-11-12" ? "2026-11-13" : "2026-11-14").toISOString();
  return approveAccount1NewFollow({ approvedStart: start, approvedEnd: end }, taipei(18, 0, day));
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
  process.env.X_API_MODE = "mock";
});

describe("account 1 new-follow admission", () => {
  it("follows a stale admitted snapshot once, without rescreening or rewriting the check time", async () => {
    enable(1);
    const saved = admitAccount1NewFollows([candidate("91001"), candidate("91001")], taipei(17, 0));
    expect(saved.accepted.map((item) => item.targetUserId)).toEqual(["91001"]);
    expect(saved.rejected.map((item) => item.reason)).toEqual(["duplicate_in_request"]);
    const again = admitAccount1NewFollows([candidate("91001", { qualificationCheckedAt: taipei(18, 0).toISOString() })], taipei(18, 0));
    expect(again.existing).toEqual(["91001"]);
    const stored = getDb().prepare(
      "SELECT qualification_checked_at, admitted_at, status FROM follow_new_admission WHERE target_user_id = '91001'",
    ).get() as { qualification_checked_at: string; admitted_at: string; status: string };
    expect(stored.qualification_checked_at).toBe(CHECKED);
    expect(stored.admitted_at).toBe(CHECKED);
    approveDay();
    const inspects: string[] = [];
    const follows: string[] = [];
    const evening = taipei(18, 5);
    const status = getFollowStatus(1, evening);
    expect(status.newAdmission.admitted).toBe(1);
    expect(status.newAdmission.executable).toBe(1);
    expect(status.newAdmission.succeeded).toBe(0);
    const batch = await submitFollowBatch({
      accountId: 1,
      now: evening,
      hooks: {
        inspect: async (id) => { inspects.push(id); throw new Error("rescreen"); },
        follow: async (id) => { follows.push(id); },
      },
    });
    expect(batch.slot).toBe("taipei-new:2026-11-12T18:00");
    expect(batch.followed).toBe(1);
    expect(follows).toEqual(["91001"]);
    expect(inspects).toEqual([]);
    expect(getFollowStatus(1, evening).newAdmission).toMatchObject({ admitted: 0, succeeded: 1 });
    expect(getDb().prepare("SELECT qualification_checked_at FROM follow_new_admission WHERE target_user_id = '91001'").get()).toEqual({
      qualification_checked_at: CHECKED,
    });
    const replay = await submitFollowBatch({
      accountId: 1,
      now: evening,
      hooks: {
        inspect: async () => { throw new Error("rescreen"); },
        follow: async (id) => { follows.push(id); },
      },
    });
    expect(replay.replay).toBe(true);
    expect(follows).toEqual(["91001"]);
  });

  it("keeps admitted people when approval, window, pause, or the daily cap blocks execution", async () => {
    enable(1);
    admitAccount1NewFollows([candidate("91002")], taipei(17, 0));
    const hooks = {
      inspect: async () => { throw new Error("rescreen"); },
      follow: async () => { throw new Error("should not follow"); },
    };
    const unapproved = await submitFollowBatch({ accountId: 1, now: taipei(18, 5), hooks });
    expect(unapproved.reason).toBe("approval_required");
    expect(getFollowStatus(1, taipei(18, 5)).newAdmission.executable).toBe(0);
    approveDay();
    expect((await submitFollowBatch({ accountId: 1, now: taipei(17, 59), hooks })).reason).toBe("rest");
    expect((await submitFollowBatch({ accountId: 1, now: taipei(18, 15), hooks })).reason).toBe("rest");
    getDb().prepare("UPDATE follow_control SET paused = 1, pause_reason = 'test' WHERE account_id = 1").run();
    expect((await submitFollowBatch({ accountId: 1, now: taipei(18, 5), hooks })).reason).toBe("paused");
    getDb().prepare("UPDATE follow_control SET paused = 0 WHERE account_id = 1").run();
    const day = "2026-11-12";
    const insert = getDb().prepare(
      `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
       VALUES (1, ?, NULL, 'new', ?, 'taipei-new:2026-11-12T18:00', ?)`,
    );
    for (let index = 0; index < 380; index += 1) insert.run(String(30000 + index), CHECKED, day);
    expect((await submitFollowBatch({ accountId: 1, now: taipei(18, 40), hooks })).reason).toBe("daily_cap");
    expect(getDb().prepare("SELECT status FROM follow_new_admission WHERE target_user_id = '91002'").get()).toEqual({ status: "admitted" });
  });

  it("stops the round on 429, leaves the rest admitted, and does not follow outside the cap of nine", async () => {
    enable(1);
    approveDay();
    const ids = Array.from({ length: 11 }, (_, index) => candidate(String(91010 + index)));
    admitAccount1NewFollows(ids, taipei(17, 0));
    const follows: string[] = [];
    const stopped = await submitFollowBatch({
      accountId: 1,
      now: taipei(18, 5),
      hooks: {
        inspect: async () => { throw new Error("rescreen"); },
        follow: async () => { throw Object.assign(new Error("limited"), { status: 429, kind: "rate_limit" }); },
      },
    });
    expect(stopped.followed).toBe(0);
    expect(stopped.results).toEqual([expect.objectContaining({ targetUserId: "91010", result: "failed", reason: "rate_limit" })]);
    expect(getDb().prepare("SELECT paused, pause_reason FROM follow_control WHERE account_id = 1").get()).toEqual({
      paused: 1,
      pause_reason: "rate_limit",
    });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_new_admission WHERE status = 'admitted'").get()).toEqual({ n: 10 });
    getDb().prepare("UPDATE follow_control SET paused = 0, pause_reason = 'test' WHERE account_id = 1").run();
    getDb().prepare("DELETE FROM follow_batches WHERE account_id = 1").run();
    const round = await submitFollowBatch({
      accountId: 1,
      now: taipei(18, 40),
      hooks: {
        inspect: async () => { throw new Error("rescreen"); },
        follow: async (id) => { follows.push(id); },
      },
    });
    expect(round.followed).toBe(9);
    expect(follows).toHaveLength(9);
    expect(getFollowStatus(1, taipei(18, 40)).newAdmission.admitted).toBe(1);
    const next = await submitFollowBatch({
      accountId: 1,
      now: taipei(18, 40),
      hooks: {
        inspect: async () => { throw new Error("rescreen"); },
        follow: async (id) => { follows.push(id); },
      },
    });
    expect(next.replay).toBe(true);
    expect(follows).toHaveLength(9);
  });

  it("rejects a bad snapshot, a future check time, an empty pool, and account 2", async () => {
    enable(1);
    const future = new Date(taipei(17, 0).getTime() + 60 * 60 * 1000).toISOString();
    const result = admitAccount1NewFollows([
      candidate("92001", { qualificationCheckedAt: future }),
      candidate("92002", { snapshot: { verified: true, verifiedType: "blue", following: true, lang: "zh", name: "中文名", description: "人工智能" } }),
      candidate("92003", { snapshot: { verified: false, verifiedType: "none", following: false, lang: "zh", name: "中文名", description: "人工智能" } }),
      candidate([...UNFOLLOW_WHITELIST][0]),
      candidate("92004", { snapshot: { verified: true, verifiedType: "blue", following: false, lang: "en", name: "Ada", description: "hello" } }),
    ], taipei(17, 0));
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      "qualification_checked_at_required",
      "not_unfollowed",
      "not_blue",
      "whitelist",
      "not_chinese",
    ]);
    approveDay();
    const empty = await submitFollowBatch({
      accountId: 1,
      now: taipei(18, 5),
      hooks: { inspect: async () => { throw new Error("rescreen"); }, follow: async () => undefined },
    });
    expect(empty.reason).toBe("insufficient_candidates");
    expect(getFollowStatus(1, taipei(18, 5)).newAdmission).toMatchObject({ admitted: 0, executable: 0, succeeded: 0 });
    const other = await postAdmission(new Request("http://local/api/follow/new-admission", {
      method: "POST",
      body: JSON.stringify({ accountId: 2, candidates: [candidate("93001")] }),
    }));
    expect(other.status).toBe(400);
    const otherApproval = await postApproval(new Request("http://local/api/follow/new-approval", {
      method: "POST",
      body: JSON.stringify({
        accountId: 2,
        approvedStart: taipei(18, 0).toISOString(),
        approvedEnd: taipei(0, 0, "2026-11-13").toISOString(),
      }),
    }));
    expect(otherApproval.status).toBe(400);
    enable(2);
    stockFollowReserve(2, {
      checkedAt: new Date(taipei(18, 5).getTime() - 3 * 60 * 60 * 1000).toISOString(),
      candidates: [{ targetUserId: "93002", kind: "new" }],
    }, taipei(18, 5));
    const stale = await submitFollowBatch({
      accountId: 2,
      now: taipei(18, 5),
      hooks: { inspect: async () => { throw new Error("account2"); }, follow: async () => { throw new Error("account2"); } },
    });
    expect(stale.executed).toBe(false);
    expect(stale.reason).toBe("stale_reserve");
  });

  it("does not consume the new pool during follow-back, and carries unused people to the next approved day", async () => {
    enable(1);
    admitAccount1NewFollows([candidate("94001")], taipei(17, 0));
    approveDay();
    stockFollowReserve(1, {
      checkedAt: taipei(0, 5).toISOString(),
      candidates: [{ targetUserId: "94002", kind: "followback" }],
    }, taipei(0, 5));
    const morningCalls: string[] = [];
    const morning = await submitFollowBatch({
      accountId: 1,
      now: taipei(0, 5),
      hooks: {
        inspect: async () => ({
          blue: true, following: false, followsBack: true, followers: 10, name: "中文名", bio: "人工智能",
          username: "fan", tweetLang: "zh", tweetText: "你好", lastPostAt: null, lastPostKnown: false,
        }),
        follow: async (id) => { morningCalls.push(id); },
      },
    });
    expect(morning.results.map((item) => item.targetUserId)).toEqual(["94002"]);
    expect(morningCalls).toEqual(["94002"]);
    expect(getDb().prepare("SELECT status FROM follow_new_admission WHERE target_user_id = '94001'").get()).toEqual({ status: "admitted" });
    const carried = await submitFollowBatch({
      accountId: 1,
      now: taipei(18, 5, "2026-11-13"),
      hooks: { inspect: async () => { throw new Error("rescreen"); }, follow: async () => { throw new Error("no approval"); } },
    });
    expect(carried.reason).toBe("approval_required");
    expect(getDb().prepare("SELECT qualification_checked_at, status FROM follow_new_admission WHERE target_user_id = '94001'").get()).toEqual({
      qualification_checked_at: CHECKED,
      status: "admitted",
    });
    approveDay("2026-11-13");
    const follows: string[] = [];
    const nextDay = await submitFollowBatch({
      accountId: 1,
      now: taipei(18, 5, "2026-11-13"),
      hooks: { inspect: async () => { throw new Error("rescreen"); }, follow: async (id) => { follows.push(id); } },
    });
    expect(nextDay.followed).toBe(1);
    expect(follows).toEqual(["94001"]);
    const unfollow = await submitUnfollowBatch({ accountId: 1, now: taipei(5, 15) });
    expect(unfollow.unfollowed).toBe(0);
  });

  it("refuses execution when the account flag or identity is missing", async () => {
    saveCredentials(1, {
      apiKey: "acctoneA", apiSecret: "slot-secret-value", accessToken: "token", accessTokenSecret: "token-secret",
    });
    admitAccount1NewFollows([candidate("95001")], taipei(17, 0));
    approveDay();
    const disabled = await submitFollowBatch({
      accountId: 1,
      now: taipei(18, 5),
      hooks: { inspect: async () => { throw new Error("rescreen"); }, follow: async () => undefined },
    });
    expect(disabled.reason).toBe("disabled");
    process.env.XUTIE_ACCOUNT1_FOLLOW = "on";
    const unnamed = await submitFollowBatch({
      accountId: 1,
      now: taipei(18, 5),
      hooks: { inspect: async () => { throw new Error("rescreen"); }, follow: async () => undefined },
    });
    expect(unnamed.reason).toBe("identity_unconfirmed");
    expect(getDb().prepare("SELECT status FROM follow_new_admission WHERE target_user_id = '95001'").get()).toEqual({ status: "admitted" });
  });
});
