import { afterEach, describe, expect, it } from "vitest";
import { PUT as saveConfig, GET as readConfig } from "@/app/api/follow/config/route";
import { getDb, updateAccount } from "@/lib/db";
import { UNFOLLOW_WHITELIST } from "@/lib/automation-account";
import { account1FollowbackDeadline, account1NewFollowDeadline } from "@/lib/follow-cadence";
import { admitAccount1NewFollows, approveAccount1NewFollow } from "@/lib/follow-new-admission";
import { getFollowStatus, stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { importEvidence } from "@/lib/evidence";
import { unfollowEvidenceState } from "@/lib/unfollow-queue";
import { saveCredentials } from "@/lib/service";
import { submitUnfollowBatch } from "@/lib/unfollow-queue";

function taipei(hour: number, minute: number, day: string): Date {
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

const profile = (): FollowProfile => ({
  blue: true, following: false, followsBack: false, followers: 20, name: "中文名", bio: "人工智能",
  username: "xin", tweetLang: "zh", tweetText: "今天", lastPostAt: null, lastPostKnown: false,
});

const opsBody = (over: Record<string, unknown> = {}) => ({
  dailyPool: true,
  followback: { batchSize: 13, workMinutes: 15, restMinutes: 18 },
  newFollow: { batchSize: 9, workMinutes: 15, restMinutes: 20 },
  unfollow: { batchSize: 10, dailyCap: 80 },
  ...over,
});

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
});

describe("account ops", () => {
  it("persists account 1 defaults and rejects account 2 or an illegal batch", async () => {
    const first = await (await readConfig(new Request("http://local/api/follow/config?accountId=1"))).json();
    expect(first.ops.dailyPool).toBe(true);
    expect(first.ops.slotClock).toBe("compiled");
    expect(first.ops.unfollow.dailyCap).toBe(80);
    const second = await (await readConfig(new Request("http://local/api/follow/config?accountId=2"))).json();
    expect(second.ops).toEqual({ dailyPool: false, locked: true });
    const saved = await saveConfig(new Request("http://local/api/follow/config", {
      method: "PUT",
      body: JSON.stringify({ accountId: 2, keywords: ["business"] }),
    }));
    expect((await saved.json()).keywords).toEqual(["business"]);
    const locked = await saveConfig(new Request("http://local/api/follow/config", {
      method: "PUT",
      body: JSON.stringify({ accountId: 2, ops: opsBody() }),
    }));
    expect(locked.status).toBe(400);
    const bad = await saveConfig(new Request("http://local/api/follow/config", {
      method: "PUT",
      body: JSON.stringify({ accountId: 1, ops: opsBody({ followback: { batchSize: 0, workMinutes: 15, restMinutes: 18 } }) }),
    }));
    expect(bad.status).toBe(400);
    const clock = await saveConfig(new Request("http://local/api/follow/config", {
      method: "PUT",
      body: JSON.stringify({ accountId: 1, ops: opsBody({ followback: { batchSize: 13, workMinutes: 10, restMinutes: 18 } }) }),
    }));
    expect(clock.status).toBe(400);
    const ok = await saveConfig(new Request("http://local/api/follow/config", {
      method: "PUT",
      body: JSON.stringify({ accountId: 1, ops: opsBody({ dailyPool: false, unfollow: { batchSize: 10, dailyCap: 40 } }) }),
    }));
    const savedOps = await ok.json();
    expect(savedOps.ops.dailyPool).toBe(false);
    expect(savedOps.ops.unfollow.dailyCap).toBe(40);
    const again = await (await readConfig(new Request("http://local/api/follow/config?accountId=1"))).json();
    expect(again.ops.dailyPool).toBe(false);
    expect((await (await readConfig(new Request("http://local/api/follow/config?accountId=2"))).json()).ops.locked).toBe(true);
  });

  it("keeps a 23:00 new-follow check until the next evening and does not overwrite it at the next 23:00", async () => {
    enable(1);
    const checked = "2026-11-14T15:00:00.000Z";
    expect(account1NewFollowDeadline(checked)).toBe(taipei(0, 0, "2026-11-16").getTime());
    expect(account1FollowbackDeadline(checked)).toBe(taipei(5, 0, "2026-11-15").getTime());
    const whitelist = [...UNFOLLOW_WHITELIST][0];
    stockFollowReserve(1, {
      checkedAt: checked,
      candidates: [{ targetUserId: "91001", kind: "new" }, { targetUserId: whitelist, kind: "new" }],
    }, taipei(23, 0, "2026-11-14"));
    const evening = taipei(19, 10, "2026-11-15");
    const calls: string[] = [];
    const unapproved = await submitFollowBatch({
      accountId: 1,
      now: evening,
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(unapproved.reason).toBe("approval_required");
    expect(unapproved.followed).toBe(0);
    expect(calls).toEqual([]);
    approveAccount1NewFollow({
      approvedStart: taipei(18, 0, "2026-11-15").toISOString(),
      approvedEnd: taipei(0, 0, "2026-11-16").toISOString(),
    }, evening);
    const reserveOnly = await submitFollowBatch({
      accountId: 1,
      now: evening,
      hooks: { inspect: async () => profile(), follow: async (id) => { calls.push(id); } },
    });
    expect(reserveOnly.followed).toBe(1);
    expect(calls).toEqual(["91001"]);
    expect(reserveOnly.results.find((item) => item.targetUserId === whitelist)?.reason).toBe("whitelist");
    expect(getDb().prepare("SELECT checked_at FROM follow_reserve WHERE target_user_id = '91001'").get()).toEqual({ checked_at: checked });
    getDb().prepare("UPDATE follow_reserve SET status = 'reserved', result = NULL, reason = NULL WHERE target_user_id = '91001'").run();
    getDb().prepare("DELETE FROM follow_success WHERE target_user_id = '91001'").run();
    getDb().prepare("DELETE FROM follow_batches").run();
    const blocked = stockFollowReserve(1, {
      checkedAt: "2026-11-15T15:00:00.000Z",
      candidates: [{ targetUserId: "91001", kind: "new" }],
    }, taipei(23, 0, "2026-11-15"));
    expect(blocked.existing).toEqual(["91001"]);
    expect(getDb().prepare("SELECT checked_at FROM follow_reserve WHERE target_user_id = '91001'").get()).toEqual({ checked_at: checked });
    const morning = await submitFollowBatch({
      accountId: 1,
      now: taipei(0, 5, "2026-11-16"),
      hooks: { inspect: async () => profile(), follow: async () => { throw new Error("new pool closed"); } },
    });
    expect(morning.followed).toBe(0);
    expect(getFollowStatus(1, taipei(0, 5, "2026-11-16")).reserve.newAvailable).toBe(0);
  });

  it("caps account 1 unfollows at the saved daily number and leaves account 2 uncapped by that switch", async () => {
    enable(1);
    enable(2);
    await saveConfig(new Request("http://local/api/follow/config", {
      method: "PUT",
      body: JSON.stringify({ accountId: 1, ops: opsBody() }),
    }));
    const insert = getDb().prepare(
      `INSERT INTO unfollow_candidates (account_id, target_user_id, username, tier, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'non_blue', 'candidate', ?, ?)`,
    );
    const stamp = taipei(5, 0, "2026-11-15").toISOString();
    for (let index = 0; index < 3; index += 1) insert.run(1, String(70000 + index), stamp, stamp);
    insert.run(2, "71000", stamp, stamp);
    getDb().prepare(
      `INSERT INTO unfollow_batches (account_id, slot, status, submitted, unfollowed, results_json, started_at, finished_at)
       VALUES (1, 'taipei:2026-11-15T05:15', 'completed', 80, 80, '[]', ?, ?)`,
    ).run(stamp, stamp);
    const capped = await submitUnfollowBatch({
      accountId: 1,
      now: taipei(5, 20, "2026-11-15"),
      hooks: { inspect: async () => { throw new Error("cap"); }, unfollow: async () => { throw new Error("cap"); } },
    });
    expect(capped.reason).toBe("daily_cap");
    const other = await submitUnfollowBatch({
      accountId: 2,
      now: taipei(5, 20, "2026-11-15"),
      hooks: {
        inspect: async () => ({ following: true, blue: false, followsBack: false, lastPostAt: null, lastPostKnown: false }),
        unfollow: async () => undefined,
      },
    });
    expect(other.unfollowed).toBe(1);
  });

  it("keeps a 23:00 new-follow snapshot through the next evening, then lets the following 23:00 replace it", () => {
    enable(1);
    const checked = "2026-11-14T15:00:00.000Z";
    const snapshot = {
      targetUserId: "91011",
      username: "xinren",
      qualificationCheckedAt: checked,
      admittedAt: checked,
      snapshot: { verified: true, verifiedType: "blue", following: false, lang: "zh", name: "中文名", description: "人工智能" },
    };
    expect(admitAccount1NewFollows([snapshot], taipei(23, 0, "2026-11-14")).accepted.map((item) => item.targetUserId)).toEqual(["91011"]);
    const blocked = admitAccount1NewFollows([{
      ...snapshot,
      qualificationCheckedAt: "2026-11-15T15:00:00.000Z",
      admittedAt: "2026-11-15T15:00:00.000Z",
    }], taipei(23, 0, "2026-11-15"));
    expect(blocked.existing).toEqual(["91011"]);
    expect(getDb().prepare("SELECT qualification_checked_at FROM follow_new_admission WHERE target_user_id = '91011'").get()).toEqual({
      qualification_checked_at: checked,
    });
    const later = "2026-11-16T15:00:00.000Z";
    const replaced = admitAccount1NewFollows([{
      ...snapshot,
      qualificationCheckedAt: later,
      admittedAt: later,
    }], taipei(23, 0, "2026-11-16"));
    expect(replaced.accepted.map((item) => item.qualificationCheckedAt)).toEqual([later]);
    expect(getDb().prepare("SELECT qualification_checked_at FROM follow_new_admission WHERE target_user_id = '91011'").get()).toEqual({
      qualification_checked_at: later,
    });
  });

  it("treats a 23:00 unfollow read as fresh through 09:00 and expired past 25 hours", () => {
    enable(1);
    const observed = "2026-11-14T15:00:00.000Z";
    importEvidence(1, {
      schema_version: 1,
      account_id: "1933586991612080128",
      source_namespace: "user-X",
      source_tool: "get_users_me_following",
      observed_at: observed,
      expires_at: "2026-11-15T01:00:00.000Z",
      request_fields: ["verified", "verified_type", "connection_status"],
      coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
      errors: [],
      evidence_refs: [],
      subjects: [{ id: "72001", verified: false, verified_type: "none", connection_status: ["following"] }],
    }, taipei(23, 0, "2026-11-14"));
    expect(unfollowEvidenceState(1, "72001", taipei(8, 45, "2026-11-15"))).toBe("fresh");
    expect(unfollowEvidenceState(1, "72001", taipei(9, 0, "2026-11-15"))).toBe("expired");
    importEvidence(1, {
      schema_version: 1,
      account_id: "1933586991612080128",
      source_namespace: "user-X",
      source_tool: "get_users_me_following",
      observed_at: observed,
      expires_at: "2026-11-16T01:00:00.000Z",
      request_fields: ["verified", "verified_type", "connection_status"],
      coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
      errors: [],
      evidence_refs: [],
      subjects: [{ id: "72002", verified: false, verified_type: "none", connection_status: ["following"] }],
    }, taipei(23, 0, "2026-11-14"));
    const pastClamp = new Date(Date.parse(observed) + 25 * 60 * 60 * 1000 + 1);
    expect(unfollowEvidenceState(1, "72002", pastClamp)).toBe("expired");
    expect(unfollowEvidenceState(2, "72002", taipei(8, 45, "2026-11-15"))).toBe("missing");
  });
});
