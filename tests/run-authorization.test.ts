import { afterEach, describe, expect, it } from "vitest";
import { DELETE as revokeRoute, GET as readRoute, POST as writeRoute } from "@/app/api/follow/authorization/route";
import { saveAutomationSettings } from "@/lib/automation-settings";
import { getDb, reopenDatabase, updateAccount } from "@/lib/db";
import {
  account1RunAuthorization,
  approvalCoversAccount1New,
  approveAccount1NewFollow,
  authorizeAccount1Run,
  pauseAccount1Run,
  resumeAccount1Run,
  revokeAccount1Run,
} from "@/lib/follow-new-admission";
import { getFollowStatus, setFollowPaused, stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";

const DAY1 = "2026-11-16";
const DAY2 = "2026-11-17";
const DAY3 = "2026-11-18";

function taipei(hour: number, minute: number, day: string): Date {
  const text = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  return new Date(Date.parse(text) - 8 * 60 * 60 * 1000);
}

function enable() {
  process.env.XUTIE_ACCOUNT1_FOLLOW = "on";
  saveCredentials(1, {
    apiKey: "acctoneA",
    apiSecret: "slot-secret-value",
    accessToken: "token",
    accessTokenSecret: "token-secret",
  });
  updateAccount(1, { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" });
  setFollowPaused(1, false, "test");
}

function chinese(): FollowProfile {
  return {
    blue: true, following: false, followsBack: false, followers: 20, name: "中文名", bio: "人工智能",
    username: "xin", tweetLang: "zh", tweetText: "今天", lastPostAt: null, lastPostKnown: false,
  };
}

function stockNew(ids: string[], when: Date) {
  stockFollowReserve(1, {
    checkedAt: when.toISOString(),
    candidates: ids.map((id) => ({ targetUserId: id, kind: "new" as const })),
  }, when);
}

function post(body: Record<string, unknown>) {
  return writeRoute(new Request("http://local/api/follow/authorization", { method: "POST", body: JSON.stringify(body) }));
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
});

describe("account 1 persistent run authorization", () => {
  it("keeps kind=new running across Taipei midnights without a daily renewal while the cap still resets", async () => {
    enable();
    saveAutomationSettings(1, { follow: { dailyCap: 1 } });
    stockNew(["96001", "96002", "96003", "96004"], taipei(17, 50, DAY1));
    const calls: string[] = [];
    const hooks = { inspect: async () => chinese(), follow: async (id: string) => { calls.push(id); } };
    const blocked = await submitFollowBatch({ accountId: 1, now: taipei(18, 0, DAY1), hooks });
    expect(blocked.reason).toBe("approval_required");
    const granted = authorizeAccount1Run({ note: "self-running" }, taipei(18, 1, DAY1));
    expect(granted).toMatchObject({ accountId: 1, persistent: true, status: "active", active: true, expiresAt: null, note: "self-running" });
    const evening = await submitFollowBatch({ accountId: 1, now: taipei(18, 2, DAY1), hooks });
    expect(evening.slot).toBe(`taipei:${DAY1}T17:48`);
    expect(evening.followed).toBe(1);
    const capped = await submitFollowBatch({ accountId: 1, now: taipei(18, 21, DAY1), hooks });
    expect(capped.reason).toBe("daily_cap");
    const afterMidnight = await submitFollowBatch({ accountId: 1, now: taipei(0, 24, DAY2), hooks });
    expect(afterMidnight.slot).toBe(`taipei:${DAY2}T00:24`);
    expect(afterMidnight.followed).toBe(1);
    const dayThree = await submitFollowBatch({ accountId: 1, now: taipei(14, 35, DAY3), hooks });
    expect(dayThree.followed).toBe(1);
    expect(calls).toHaveLength(3);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_new_approval").get()).toEqual({ n: 0 });
    const status = getFollowStatus(1, taipei(14, 40, DAY3));
    expect(status.newAdmission.approvalSource).toBe("persistent");
    expect(status.newAdmission.authorization).toMatchObject({ status: "active", active: true });
    expect(status.newAdmission.approval).toBeNull();
    expect(approvalCoversAccount1New(taipei(9, 0, DAY3))).toMatchObject({ source: "persistent", poolDay: DAY3, approvedEnd: null });
  });

  it("ends only on an explicit expiry, a pause, or a revoke", async () => {
    enable();
    stockNew(["96101", "96102", "96103"], taipei(17, 0, DAY1));
    const calls: string[] = [];
    const hooks = { inspect: async () => chinese(), follow: async (id: string) => { calls.push(id); } };
    const expiring = authorizeAccount1Run({ expiresAt: taipei(0, 0, DAY2).toISOString() }, taipei(17, 0, DAY1));
    expect(expiring.expiresAt).toBe(taipei(0, 0, DAY2).toISOString());
    expect(approvalCoversAccount1New(taipei(23, 51, DAY1))?.source).toBe("persistent");
    expect(approvalCoversAccount1New(taipei(0, 0, DAY2))).toBeNull();
    expect(account1RunAuthorization(taipei(0, 1, DAY2))).toMatchObject({ status: "active", active: false });
    expect((await submitFollowBatch({ accountId: 1, now: taipei(0, 24, DAY2), hooks })).reason).toBe("approval_required");

    authorizeAccount1Run({}, taipei(9, 0, DAY2));
    expect(account1RunAuthorization(taipei(9, 0, DAY2))).toMatchObject({ status: "active", active: true, expiresAt: null });
    pauseAccount1Run(taipei(9, 1, DAY2));
    expect(approvalCoversAccount1New(taipei(9, 2, DAY2))).toBeNull();
    expect((await submitFollowBatch({ accountId: 1, now: taipei(9, 5, DAY2), hooks })).reason).toBe("approval_required");
    resumeAccount1Run(taipei(9, 6, DAY2));
    const resumed = await submitFollowBatch({ accountId: 1, now: taipei(9, 33, DAY2), hooks });
    expect(resumed.followed).toBe(3);
    expect(calls).toHaveLength(3);

    revokeAccount1Run(taipei(10, 0, DAY2));
    expect(account1RunAuthorization(taipei(10, 1, DAY2))).toMatchObject({ status: "revoked", active: false });
    expect(approvalCoversAccount1New(taipei(10, 1, DAY2))).toBeNull();
    expect(() => resumeAccount1Run(taipei(10, 2, DAY2))).toThrow(/重新授权/);
    expect(() => pauseAccount1Run(taipei(10, 2, DAY2))).toThrow(/没有可暂停/);
    expect(() => authorizeAccount1Run({ expiresAt: taipei(9, 0, DAY2).toISOString() }, taipei(10, 3, DAY2))).toThrow(/晚于现在/);
    expect(() => authorizeAccount1Run({ expiresAt: "soon" }, taipei(10, 3, DAY2))).toThrow(/可解析/);
    expect(() => authorizeAccount1Run({ note: 7 }, taipei(10, 3, DAY2))).toThrow(/note/);
    expect(account1RunAuthorization(taipei(10, 4, DAY2)).status).toBe("revoked");
  });

  it("keeps legacy one-day approvals working, and a later pause or revoke supersedes them", () => {
    enable();
    const approveDay1 = (at: Date) => approveAccount1NewFollow({
      approvedStart: taipei(0, 0, DAY1).toISOString(),
      approvedEnd: taipei(0, 0, DAY2).toISOString(),
    }, at);
    approveDay1(taipei(8, 0, DAY1));
    expect(approvalCoversAccount1New(taipei(18, 0, DAY1))).toMatchObject({ source: "daily", poolDay: DAY1 });
    expect(approvalCoversAccount1New(taipei(0, 24, DAY2))).toBeNull();
    expect(getFollowStatus(1, taipei(18, 0, DAY1)).newAdmission).toMatchObject({
      approvalSource: "daily",
      approval: { poolDay: DAY1, active: true },
      authorization: { status: "none", active: false },
    });
    revokeAccount1Run(taipei(19, 0, DAY1));
    expect(approvalCoversAccount1New(taipei(19, 30, DAY1))).toBeNull();
    approveDay1(taipei(19, 45, DAY1));
    expect(approvalCoversAccount1New(taipei(20, 0, DAY1))?.source).toBe("daily");
    getDb().prepare(
      `INSERT INTO follow_new_approval (account_id, pool_day, approved_start, approved_end, created_at) VALUES (1, ?, ?, ?, ?)`,
    ).run(DAY3, taipei(0, 0, DAY3).toISOString(), taipei(0, 0, "2026-11-19").toISOString(), taipei(0, 0, DAY3).toISOString());
    expect(approvalCoversAccount1New(taipei(12, 0, DAY3))).toMatchObject({ source: "daily", poolDay: DAY3 });
    expect(approvalCoversAccount1New(taipei(12, 0, DAY2))).toBeNull();
  });

  it("reads, authorizes, pauses, resumes, and revokes through the API for account 1 only", async () => {
    const empty = await (await readRoute(new Request("http://local/api/follow/authorization?accountId=1"))).json();
    expect(empty).toMatchObject({ accountId: 1, status: "none", active: false });
    const granted = await post({ accountId: 1, note: "run" });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ status: "active", active: true, note: "run", expiresAt: null });
    expect(await (await post({ accountId: 1, action: "pause" })).json()).toMatchObject({ status: "paused", active: false });
    expect(await (await post({ accountId: 1, action: "resume" })).json()).toMatchObject({ status: "active", active: true });
    reopenDatabase();
    expect((await (await readRoute(new Request("http://local/api/follow/authorization?accountId=1"))).json()).status).toBe("active");
    const revoked = await revokeRoute(new Request("http://local/api/follow/authorization?accountId=1", { method: "DELETE" }));
    expect(await revoked.json()).toMatchObject({ status: "revoked", active: false });
    const other = await post({ accountId: 2 });
    expect(other.status).toBe(400);
    expect((await other.json()).code).toBe("account_required");
    expect((await readRoute(new Request("http://local/api/follow/authorization?accountId=2"))).status).toBe(400);
    expect((await post({ accountId: 1, action: "forever" })).status).toBe(400);
    expect((await post({ accountId: 1, expiresAt: "tomorrow" })).status).toBe(400);
    expect((await post({ accountId: 1, expiresAt: "2020-01-01T00:00:00.000Z" })).status).toBe(400);
    expect((await (await readRoute(new Request("http://local/api/follow/authorization?accountId=1"))).json()).status).toBe("revoked");
  });
});
