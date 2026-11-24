import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { GET as readFollow } from "@/app/api/follow/route";
import { PUT as saveConfig, GET as readConfig } from "@/app/api/follow/config/route";
import { ApprovedListFollowControl } from "@/components/approved-list-follow-control";
import { approvedListFollowPutBody, approvedListFollowView } from "@/lib/approved-list-follow";
import { UNFOLLOW_WHITELIST } from "@/lib/automation-account";
import { getDb, reopenDatabase, updateAccount } from "@/lib/db";
import { evidenceFollowProfile } from "@/lib/evidence";
import { saveFollowAllowlist } from "@/lib/follow-allowlist";
import { recordAccount1UnfollowBlock } from "@/lib/follow-blocklist";
import { approveAccount1NewFollow } from "@/lib/follow-new-admission";
import { getFollowStatus, stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";

function taipei(hour: number, minute: number, day = "2026-11-24"): Date {
  const text = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  return new Date(Date.parse(text) - 8 * 60 * 60 * 1000);
}

const WORK = taipei(17, 15);
const NEXT = taipei(17, 48);
const CHECKED = "2026-11-24T06:00:00.000Z";
const LIST = Array.from({ length: 21 }, (_, index) => String(91001 + index));

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

function approveDay() {
  approveAccount1NewFollow({
    approvedStart: taipei(0, 0).toISOString(),
    approvedEnd: taipei(0, 0, "2026-11-25").toISOString(),
  }, taipei(9, 0));
}

function stockList(extra: string[] = []) {
  stockFollowReserve(1, {
    checkedAt: CHECKED,
    candidates: [...LIST, ...extra].map((id) => ({ targetUserId: id, kind: "new" as const, trusted: true })),
  }, taipei(14, 0));
}

function emptyProfile(): FollowProfile {
  return {
    blue: null, following: null, followsBack: null, followers: null, name: null, bio: null, username: null,
    tweetLang: null, tweetText: null, lastPostAt: null, lastPostKnown: false,
  };
}

async function put(body: Record<string, unknown>) {
  return saveConfig(new Request("http://local/api/follow/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
});

describe("approved list follow switch", () => {
  it("defaults off, persists across a reopened database, and rejects account 2", async () => {
    const first = await (await readConfig(new Request("http://local/api/follow/config?accountId=1"))).json();
    expect(first.approvedListFollow).toBe(false);
    expect(first.approvedListFollowLocked).toBe(false);
    expect(first.approvedListStatus).toBe(approvedListFollowView(1).approvedListStatus);
    expect(first.approvedListStatus.startsWith("关闭")).toBe(true);
    expect(first.dailyCap).toBe(350);
    expect(first.ops.followback).toMatchObject({ batchSize: 13, workMinutes: 15, restMinutes: 18 });
    const second = await (await readConfig(new Request("http://local/api/follow/config?accountId=2"))).json();
    expect(second.approvedListFollow).toBe(false);
    expect(second.approvedListFollowLocked).toBe(true);
    expect(second.approvedListStatus.startsWith("账号2")).toBe(true);
    const locked = await put({ accountId: 2, approvedListFollow: true });
    expect(locked.status).toBe(400);
    expect((await locked.json()).code).toBe("approved_list_locked");
    const bad = await put({ accountId: 1, approvedListFollow: "yes" });
    expect(bad.status).toBe(400);
    const saved = await put({ accountId: 1, approvedListFollow: true, keywords: ["商业"] });
    const savedBody = await saved.json();
    expect(savedBody.keywords).toEqual(["商业"]);
    expect(savedBody.approvedListFollow).toBe(true);
    reopenDatabase();
    const again = await (await readConfig(new Request("http://local/api/follow/config?accountId=1"))).json();
    expect(again.approvedListFollow).toBe(true);
    expect(again.approvedListStatus.startsWith("开启")).toBe(true);
    expect(again.keywords).toEqual(["商业"]);
    const keywords = await put({ accountId: 1, keywords: ["AI"] });
    expect((await keywords.json()).approvedListFollow).toBe(true);
    const ops = await put({
      accountId: 1,
      ops: {
        dailyPool: true,
        followback: { batchSize: 13, workMinutes: 15, restMinutes: 18 },
        newFollow: { batchSize: 9, workMinutes: 15, restMinutes: 20 },
        unfollow: { batchSize: 10, dailyCap: 80 },
      },
    });
    const opsBody = await ops.json();
    expect(opsBody.approvedListFollow).toBe(true);
    expect(opsBody.ops.followback).toMatchObject({ batchSize: 13, workMinutes: 15, restMinutes: 18 });
    const off = await put({ accountId: 1, approvedListFollow: false });
    expect((await off.json()).approvedListFollow).toBe(false);
    reopenDatabase();
    const status = await (await readFollow(new Request("http://local/api/follow?accountId=1"))).json();
    expect(status.approvedListFollow).toBe(false);
    expect(status.dailyCap).toBe(350);
    expect(status.batchSize).toBe(13);
  });

  it("keeps the existing 21 reserved people on evidence_pending while the switch is off", async () => {
    enable(1);
    approveDay();
    stockList(["91099"]);
    saveFollowAllowlist(1, { enforced: true, targetUserIds: LIST });
    const follows: string[] = [];
    const inspected: string[] = [];
    const batch = await submitFollowBatch({
      accountId: 1,
      now: WORK,
      random: () => 0,
      hooks: {
        inspect: async (id) => {
          inspected.push(id);
          return evidenceFollowProfile(1, id, WORK);
        },
        follow: async (id) => { follows.push(id); },
      },
    });
    expect(batch.slot).toBe("taipei:2026-11-24T17:15");
    expect(batch.submitted).toBe(13);
    expect(batch.followed).toBe(0);
    expect(batch.results).toHaveLength(13);
    expect(batch.results.every((item) => item.result === "skipped" && item.reason === "evidence_pending")).toBe(true);
    expect(follows).toEqual([]);
    expect(inspected).toHaveLength(13);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve").get()).toEqual({ n: 22 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE status = 'reserved'").get()).toEqual({ n: 22 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM evidence_subjects").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM evidence_pages").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_success").get()).toEqual({ n: 0 });
  });

  it("follows the existing 21 after the switch is on, without new rows or fabricated evidence", async () => {
    enable(1);
    approveDay();
    stockList(["91099"]);
    saveFollowAllowlist(1, { enforced: true, targetUserIds: LIST });
    const turned = await put({ accountId: 1, approvedListFollow: true });
    expect((await turned.json()).approvedListStatus.startsWith("开启")).toBe(true);
    reopenDatabase();
    expect(approvedListFollowView(1).approvedListFollow).toBe(true);
    const follows: string[] = [];
    const hooks = {
      inspect: async () => { throw new Error("approved list must not read evidence"); },
      follow: async (id: string) => { follows.push(id); },
    };
    const first = await submitFollowBatch({ accountId: 1, now: WORK, random: () => 0, hooks });
    expect(first.slot).toBe("taipei:2026-11-24T17:15");
    expect(first.submitted).toBe(13);
    expect(first.followed).toBe(13);
    expect(first.results.every((item) => item.result === "success" && item.reason === "approved_list")).toBe(true);
    const replay = await submitFollowBatch({
      accountId: 1,
      now: WORK,
      hooks: { inspect: async () => { throw new Error("replay"); }, follow: async () => { throw new Error("replay"); } },
    });
    expect(replay.replay).toBe(true);
    expect(replay.followed).toBe(13);
    const second = await submitFollowBatch({ accountId: 1, now: NEXT, random: () => 0, hooks });
    expect(second.slot).toBe("taipei:2026-11-24T17:48");
    expect(second.followed).toBe(8);
    expect(second.results.every((item) => item.reason === "approved_list")).toBe(true);
    expect(new Set(follows)).toEqual(new Set(LIST));
    expect(follows).toHaveLength(21);
    expect(follows).not.toContain("91099");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve").get()).toEqual({ n: 22 });
    expect(getDb().prepare("SELECT status, checked_at FROM follow_reserve WHERE target_user_id = '91099'").get()).toEqual({
      status: "reserved",
      checked_at: CHECKED,
    });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_reserve WHERE status = 'followed'").get()).toEqual({ n: 21 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_success WHERE account_id = 1").get()).toEqual({ n: 21 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM evidence_subjects").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM evidence_pages").get()).toEqual({ n: 0 });
    const live = getFollowStatus(1, WORK);
    expect(live.approvedListFollow).toBe(true);
    expect(live.dailyCap).toBe(350);
    expect(live.batchSize).toBe(13);
    expect(live.schedule).toBe("work");
    expect(getFollowStatus(1, taipei(6, 30)).schedule).toBe("rest");
    expect(getFollowStatus(1, taipei(7, 0)).batchSize).toBe(13);
  });

  it("still skips a blocklist id, an already followed id, and a whitelist id when the switch is on", async () => {
    enable(1);
    approveDay();
    const blocked = "91031";
    const done = "91032";
    const fresh = "91033";
    const whitelist = [...UNFOLLOW_WHITELIST][0];
    stockFollowReserve(1, {
      checkedAt: CHECKED,
      candidates: [blocked, done, fresh, whitelist].map((id) => ({ targetUserId: id, kind: "new" as const })),
    }, taipei(14, 0));
    saveFollowAllowlist(1, { enforced: true, targetUserIds: [blocked, done, fresh, whitelist] });
    recordAccount1UnfollowBlock(blocked, WORK);
    getDb().prepare(
      `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
       VALUES (1, ?, 'done', 'new', ?, 'taipei:2026-11-24T09:00', '2026-11-24')`,
    ).run(done, WORK.toISOString());
    await put({ accountId: 1, approvedListFollow: true });
    const follows: string[] = [];
    const batch = await submitFollowBatch({
      accountId: 1,
      now: WORK,
      random: () => 0,
      hooks: {
        inspect: async () => { throw new Error("screen"); },
        follow: async (id) => { follows.push(id); },
      },
    });
    expect(follows).toEqual([fresh]);
    expect(batch.results.find((item) => item.targetUserId === whitelist)?.reason).toBe("whitelist");
    expect(batch.results.some((item) => item.targetUserId === blocked || item.targetUserId === done)).toBe(false);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_success WHERE target_user_id = ?").get(done)).toEqual({ n: 1 });
    expect(getDb().prepare("SELECT status FROM follow_reserve WHERE target_user_id = ?").get(blocked)).toEqual({ status: "reserved" });
  });

  it("does not let a discovered candidate waive screening, and restores screening when the switch is off", async () => {
    enable(1);
    approveDay();
    stockFollowReserve(1, {
      checkedAt: CHECKED,
      candidates: [
        { targetUserId: "91041", kind: "new", trusted: true },
        { targetUserId: "91042", kind: "new" },
      ],
    }, taipei(14, 0));
    saveFollowAllowlist(1, { enforced: false, targetUserIds: ["91041"] });
    await put({ accountId: 1, approvedListFollow: true });
    const follows: string[] = [];
    const open = await submitFollowBatch({
      accountId: 1,
      now: WORK,
      random: () => 0,
      hooks: {
        inspect: async (id) => {
          if (id === "91041") throw new Error("listed id must not be inspected");
          return emptyProfile();
        },
        follow: async (id) => { follows.push(id); },
      },
    });
    expect(follows).toEqual(["91041"]);
    expect(open.results.find((item) => item.targetUserId === "91041")).toMatchObject({ result: "success", reason: "approved_list" });
    expect(open.results.find((item) => item.targetUserId === "91042")).toMatchObject({ result: "skipped", reason: "evidence_pending" });
    getDb().prepare("DELETE FROM follow_batches").run();
    getDb().prepare("DELETE FROM follow_success").run();
    getDb().prepare("DELETE FROM follow_inflight").run();
    getDb().prepare("UPDATE follow_reserve SET status = 'reserved', result = NULL, reason = NULL").run();
    await put({ accountId: 1, approvedListFollow: false });
    const screened = await submitFollowBatch({
      accountId: 1,
      now: NEXT,
      random: () => 0,
      hooks: {
        inspect: async () => ({
          ...emptyProfile(),
          blue: false,
          following: false,
          name: "Tom",
          bio: "hello",
          username: "tom",
          tweetLang: "en",
          tweetText: "hello there",
        }),
        follow: async () => { throw new Error("off"); },
      },
    });
    expect(screened.followed).toBe(0);
    expect(screened.results.map((item) => item.reason).sort()).toEqual(["not_blue", "not_blue"]);
  });

  it("keeps account 2 on its own screen and keeps account 1 cadence, cap, approval, and rate limit", async () => {
    enable(1);
    enable(2);
    await put({ accountId: 1, approvedListFollow: true });
    await readConfig(new Request("http://local/api/follow/config?accountId=2"));
    getDb().prepare("UPDATE follow_account_config SET approved_list_follow = 1 WHERE account_id = 2").run();
    const account2Now = taipei(17, 5);
    stockFollowReserve(2, {
      checkedAt: taipei(17, 0).toISOString(),
      candidates: [{ targetUserId: "92001", kind: "new" }, { targetUserId: "92002", kind: "new" }],
    }, account2Now);
    const account2Follows: string[] = [];
    const account2 = await submitFollowBatch({
      accountId: 2,
      now: account2Now,
      hooks: {
        inspect: async (id) => ({
          blue: id === "92002",
          following: false,
          followsBack: false,
          followers: 20,
          name: "Tom",
          bio: "AI business",
          username: "tom",
          tweetLang: "en",
          tweetText: "shipping today",
          lastPostAt: null,
          lastPostKnown: false,
        }),
        follow: async (id) => { account2Follows.push(id); },
      },
    });
    expect(account2.slot).toBe("taipei:2026-11-24T17:00");
    expect(account2Follows).toEqual(["92002"]);
    expect(account2.results.find((item) => item.targetUserId === "92001")?.reason).toBe("not_blue");
    expect(account2.results.find((item) => item.targetUserId === "92002")?.reason).toBe("new");
    stockFollowReserve(1, {
      checkedAt: CHECKED,
      candidates: [{ targetUserId: "91051", kind: "new" }],
    }, taipei(14, 0));
    saveFollowAllowlist(1, { enforced: true, targetUserIds: ["91051"] });
    const unapproved = await submitFollowBatch({
      accountId: 1,
      now: WORK,
      hooks: { inspect: async () => { throw new Error("approval"); }, follow: async () => { throw new Error("approval"); } },
    });
    expect(unapproved.reason).toBe("approval_required");
    expect(unapproved.followed).toBe(0);
    approveDay();
    const resting = await submitFollowBatch({
      accountId: 1,
      now: taipei(6, 30),
      hooks: { inspect: async () => { throw new Error("rest"); }, follow: async () => { throw new Error("rest"); } },
    });
    expect(resting.reason).toBe("rest");
    const stamp = WORK.toISOString();
    const insert = getDb().prepare(
      `INSERT INTO follow_success (account_id, target_user_id, username, kind, succeeded_at, slot, london_day)
       VALUES (1, ?, NULL, 'new', ?, 'taipei:2026-11-24T09:00', '2026-11-24')`,
    );
    for (let index = 0; index < 350; index += 1) insert.run(String(800000 + index), stamp);
    const capped = await submitFollowBatch({
      accountId: 1,
      now: WORK,
      hooks: { inspect: async () => { throw new Error("cap"); }, follow: async () => { throw new Error("cap"); } },
    });
    expect(capped.reason).toBe("daily_cap");
    getDb().prepare("DELETE FROM follow_success").run();
    const limited = await submitFollowBatch({
      accountId: 1,
      now: WORK,
      hooks: {
        inspect: async () => { throw new Error("rate"); },
        follow: async () => { throw Object.assign(new Error("limited"), { status: 429 }); },
      },
    });
    expect(limited.results[0]).toMatchObject({ targetUserId: "91051", result: "failed", reason: "rate_limit" });
    expect(getDb().prepare("SELECT paused, pause_reason FROM follow_control WHERE account_id = 1").get()).toEqual({
      paused: 1,
      pause_reason: "rate_limit",
    });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_success WHERE target_user_id = '91051'").get()).toEqual({ n: 0 });
  });

  it("renders the Chinese switch for both states and keeps account 2 locked", () => {
    const off = renderToStaticMarkup(createElement(ApprovedListFollowControl, {
      accountId: 1,
      checked: false,
      locked: false,
      status: approvedListFollowView(1).approvedListStatus,
      busy: false,
      onChecked: () => undefined,
      onSave: () => undefined,
    }));
    expect(off).toContain("已筛名单直接关注");
    expect(off).toContain("保存已筛名单开关");
    expect(off).toContain("关闭：账号1仍按原资格筛选");
    expect(off).toContain('aria-label="已筛名单直接关注"');
    expect(off).not.toContain("checked");
    const on = renderToStaticMarkup(createElement(ApprovedListFollowControl, {
      accountId: 1,
      checked: true,
      locked: false,
      status: "开启：账号1执行白名单上的已筛名单，只跳过永久取关黑名单和已经关注过的人。",
      busy: false,
      onChecked: () => undefined,
      onSave: () => undefined,
    }));
    expect(on).toContain("checked");
    expect(on).toContain("开启：账号1执行白名单上的已筛名单");
    const locked = renderToStaticMarkup(createElement(ApprovedListFollowControl, {
      accountId: 2,
      checked: false,
      locked: true,
      status: approvedListFollowView(2).approvedListStatus,
      busy: false,
      onChecked: () => undefined,
      onSave: () => undefined,
    }));
    expect(locked).toContain("账号2没有已筛名单开关");
    expect(locked).not.toContain("已筛名单直接关注");
    expect(approvedListFollowPutBody(true)).toEqual({ accountId: 1, approvedListFollow: true });
    expect(approvedListFollowPutBody(false)).toEqual({ accountId: 1, approvedListFollow: false });
  });
});
