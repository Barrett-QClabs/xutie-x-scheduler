import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as readAllowlist, PUT as putAllowlist } from "@/app/api/follow/allowlist/route";
import { GET as readConfig, PUT as putConfig } from "@/app/api/follow/config/route";
import { FollowAllowlistControl } from "@/components/follow-allowlist-control";
import type { AccountId } from "@/lib/account";
import { approvedListFollowEnabled, approvedListWaivesScreening } from "@/lib/approved-list-follow";
import { readAutomationSettings, saveAutomationSettings } from "@/lib/automation-settings";
import { getDb, reopenDatabase, resetAllData, updateAccount } from "@/lib/db";
import { importEvidence } from "@/lib/evidence";
import { getFollowAllowlist, saveFollowAllowlist } from "@/lib/follow-allowlist";
import { saveApprovedListFollowSetting } from "@/lib/follow-config";
import { stockFollowReserve, submitFollowBatch, type FollowProfile } from "@/lib/follow-queue";
import { saveCredentials } from "@/lib/service";

const NOW = new Date("2026-11-24T09:05:00.000Z");
const NEXT = new Date("2026-11-24T09:35:00.000Z");
const LATER = new Date("2026-11-24T10:05:00.000Z");
const SOURCE = "1468479269701820422";

function enable(accountId: AccountId = 2) {
  vi.stubEnv(accountId === 1 ? "XUTIE_ACCOUNT1_FOLLOW" : "XUTIE_ACCOUNT2_FOLLOW", "on");
  saveCredentials(accountId, {
    apiKey: accountId === 1 ? "acctoneA" : "accttwoB",
    apiSecret: "slot-secret-value", accessToken: "token", accessTokenSecret: "token-secret",
  });
  updateAccount(accountId, accountId === 1
    ? { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" }
    : { username: "boylittle18", displayName: "Boy", userId: SOURCE });
  getDb().prepare("UPDATE follow_control SET paused = 0, pause_reason = 'test' WHERE account_id = ?").run(accountId);
}

function stock(ids: string[], accountId: AccountId = 2) {
  return stockFollowReserve(accountId, {
    checkedAt: NOW.toISOString(),
    candidates: ids.map((targetUserId) => ({ targetUserId, kind: "followback" as const })),
  }, NOW);
}

function profile(): FollowProfile {
  return {
    blue: true, following: false, followsBack: true, followers: 20, name: "Tom", bio: "AI business",
    username: "tom", tweetLang: "en", tweetText: "shipping today", lastPostAt: null, lastPostKnown: false,
  };
}

function hooks() {
  return {
    inspect: vi.fn<(id: string) => Promise<FollowProfile>>(async () => profile()),
    follow: vi.fn<(id: string) => Promise<void>>(async () => undefined),
  };
}

function put(handler: typeof putConfig | typeof putAllowlist, body: Record<string, unknown>) {
  return handler(new Request("http://local/api/follow", { method: "PUT", body: JSON.stringify(body) }));
}

function accountRows(accountId: AccountId) {
  const db = getDb();
  return {
    config: db.prepare("SELECT * FROM follow_account_config WHERE account_id = ?").all(accountId),
    control: db.prepare("SELECT * FROM follow_control WHERE account_id = ?").all(accountId),
    allowlist: db.prepare("SELECT * FROM follow_allowlist_control WHERE account_id = ?").all(accountId),
    ids: db.prepare("SELECT * FROM follow_execution_allowlist WHERE account_id = ? ORDER BY target_user_id").all(accountId),
    reserve: db.prepare("SELECT * FROM follow_reserve WHERE account_id = ? ORDER BY target_user_id").all(accountId),
    success: db.prepare("SELECT * FROM follow_success WHERE account_id = ? ORDER BY target_user_id").all(accountId),
  };
}

function reserve(id: string) {
  return getDb().prepare("SELECT status, result, reason FROM follow_reserve WHERE account_id = 2 AND target_user_id = ?").get(id);
}

function knownFollowing(id: string) {
  importEvidence(2, {
    schema_version: 1, account_id: SOURCE, source_namespace: "user-X--english", source_tool: "get_users_me_following",
    observed_at: NOW.toISOString(), expires_at: LATER.toISOString(),
    request_fields: ["verified", "verified_type", "connection_status"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [], subjects: [{ id, verified: false, verified_type: "none", connection_status: ["following"] }],
  }, NOW);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("independent approved-list switches and execution allowlists", () => {
  it.each([1, 2] as const)("saves and validates account %s's switch without writing the other account", async (accountId) => {
    const other = accountId === 1 ? 2 : 1;
    saveApprovedListFollowSetting(other, true);
    const otherBefore = accountRows(other);
    const initial = await (await readConfig(new Request(`http://local/api/follow/config?accountId=${accountId}`))).json();
    expect(initial).toMatchObject({ accountId, approvedListFollow: false, approvedListFollowLocked: false });
    expect(getDb().prepare("SELECT approved_list_follow FROM follow_account_config WHERE account_id = ?").get(accountId))
      .toEqual({ approved_list_follow: 0 });
    const saved = await put(putConfig, { accountId, approvedListFollow: true });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ accountId, approvedListFollow: true, approvedListFollowLocked: false });
    reopenDatabase();
    expect((await (await readConfig(new Request(`http://local/api/follow/config?accountId=${accountId}`))).json()).approvedListFollow).toBe(true);
    const beforeBad = accountRows(accountId);
    for (const value of ["true", 1, null, {}, []]) {
      const bad = await put(putConfig, { accountId, approvedListFollow: value });
      expect(bad.status).toBe(400);
      expect((await bad.json()).code).toBe("invalid_approved_list");
    }
    expect(accountRows(accountId)).toEqual(beforeBad);
    expect((await (await put(putConfig, { accountId, approvedListFollow: false })).json()).approvedListFollow).toBe(false);
    reopenDatabase();
    expect(approvedListFollowEnabled(accountId)).toBe(false);
    expect(accountRows(other)).toEqual(otherBefore);
  });

  it.each([1, 2] as const)("persists account %s's allowlist through the HTTP API without changing history or the other account", async (accountId) => {
    const other = accountId === 1 ? 2 : 1;
    saveFollowAllowlist(other, { enforced: true, targetUserIds: ["80001"] });
    const otherBefore = accountRows(other);
    stock(["92001"], accountId);
    const reserveBefore = accountRows(accountId).reserve;
    getDb().prepare(
      "INSERT INTO follow_success VALUES (?, '95001', 'history', 'new', ?, 'old-slot', '2026-11-23')",
    ).run(accountId, "2026-11-23T09:05:00.000Z");
    getDb().prepare("INSERT INTO follow_blocklist VALUES (?, '95002', 'unfollow_success', ?)").run(accountId, NOW.toISOString());
    getDb().prepare(
      `INSERT INTO follow_new_admission
       (account_id, target_user_id, sequence, admitted_at, qualification_checked_at, snapshot_json, follow_reason, status, created_at, updated_at)
       VALUES (1, '95003', 1, ?, ?, '{}', 'new', 'admitted', ?, ?)`,
    ).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    const historyBefore = ["follow_new_admission", "follow_success", "follow_blocklist", "follow_batches"].map((table) =>
      getDb().prepare(`SELECT * FROM ${table}`).all());
    const initial = await (await readAllowlist(new Request(`http://local/api/follow/allowlist?accountId=${accountId}`))).json();
    expect(initial).toMatchObject({ accountId, enforced: false, targetUserIds: [] });
    const response = await put(putAllowlist, { accountId, enforced: true, targetUserIds: ["92002", " 92001 ", "92002"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accountId, enforced: true, count: 2, targetUserIds: ["92001", "92002"] });
    reopenDatabase();
    expect(await (await readAllowlist(new Request(`http://local/api/follow/allowlist?accountId=${accountId}`))).json())
      .toMatchObject({ accountId, enforced: true, targetUserIds: ["92001", "92002"] });
    const beforeBad = accountRows(accountId);
    for (const invalid of [
      { enforced: "true", targetUserIds: [] }, { enforced: 1, targetUserIds: [] },
      { enforced: true, targetUserIds: ["abc"] }, { enforced: true, targetUserIds: ["1".repeat(33)] },
      { enforced: true, targetUserIds: [123] }, { enforced: true, targetUserIds: "92001" },
    ]) {
      const bad = await put(putAllowlist, { accountId, ...invalid });
      expect(bad.status).toBe(400);
      expect((await bad.json()).code).toBe("invalid_allowlist");
    }
    expect(accountRows(accountId)).toEqual(beforeBad);
    expect((await (await put(putAllowlist, { accountId, enforced: false, targetUserIds: [] })).json()).targetUserIds).toEqual([]);
    expect(accountRows(accountId).reserve).toEqual(reserveBefore);
    expect(["follow_new_admission", "follow_success", "follow_blocklist", "follow_batches"].map((table) =>
      getDb().prepare(`SELECT * FROM ${table}`).all())).toEqual(historyBefore);
    expect(accountRows(other)).toEqual(otherBefore);
  });

  it.each([0, 1])("widens legacy allowlist tables preserving account 1 enforced=%s and every id/timestamp", (enforced) => {
    getDb().exec(`
      DROP TABLE follow_allowlist_control;
      DROP TABLE follow_execution_allowlist;
      CREATE TABLE follow_allowlist_control (
        account_id INTEGER PRIMARY KEY CHECK (account_id = 1), enforced INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE follow_execution_allowlist (
        account_id INTEGER NOT NULL CHECK (account_id = 1), target_user_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, target_user_id)
      );
    `);
    getDb().prepare("INSERT INTO follow_allowlist_control VALUES (1, ?, 'original-control-time')").run(enforced);
    getDb().exec("INSERT INTO follow_execution_allowlist VALUES (1, '91001', 'first-time'), (1, '91002', 'second-time')");
    const before = accountRows(1);
    reopenDatabase();
    expect(accountRows(1)).toEqual(before);
    expect(getFollowAllowlist(2)).toMatchObject({ accountId: 2, enforced: false, targetUserIds: [] });
    saveFollowAllowlist(2, { enforced: true, targetUserIds: ["92001"] });
    reopenDatabase();
    expect(accountRows(1)).toEqual(before);
    expect(getFollowAllowlist(2)).toMatchObject({ enforced: true, targetUserIds: ["92001"] });
  });

  it("resets account 2 to off and empty, and restores its missing control without changing account 1 bootstrap semantics", () => {
    saveApprovedListFollowSetting(2, true);
    saveFollowAllowlist(2, { enforced: true, targetUserIds: ["92001"] });
    getDb().prepare("DELETE FROM follow_allowlist_control WHERE account_id = 2").run();
    resetAllData();
    expect(getFollowAllowlist(2)).toMatchObject({ enforced: false, targetUserIds: [] });
    expect(approvedListFollowEnabled(2)).toBe(false);
    expect(getFollowAllowlist(1).enforced).toBe(false);
    getDb().prepare("DELETE FROM follow_allowlist_control").run();
    reopenDatabase();
    expect(getFollowAllowlist(1)).toMatchObject({ enforced: true, targetUserIds: [] });
    expect(getFollowAllowlist(2)).toMatchObject({ enforced: false, targetUserIds: [] });
  });

  it.each([1, 2] as const)("renders account %s's allowlist editor", (accountId) => {
    const html = renderToStaticMarkup(createElement(FollowAllowlistControl, { accountId, locale: "en" }));
    expect(html).toContain(`Account ${accountId} execution allowlist`);
    expect(html).toContain("Only follow users on this list");
    expect(html).toContain(`id="follow-allowlist-${accountId}"`);
    expect(html).toContain("Save execution allowlist");
  });
});

describe("account 2 approved-list execution", () => {
  it("bypasses missing evidence, blue, language and activity screens only for its own operator-listed targets", async () => {
    enable();
    enable(1);
    stock(["91001"], 1);
    saveFollowAllowlist(1, { enforced: false, targetUserIds: ["92004"] });
    saveApprovedListFollowSetting(1, true);
    const account1Before = accountRows(1);
    const settings1 = readAutomationSettings(1);
    saveApprovedListFollowSetting(2, true);
    saveAutomationSettings(2, { filters: { activity: true } });
    saveFollowAllowlist(2, { enforced: false, targetUserIds: ["92001", "92002", "92003"] });
    stockFollowReserve(2, {
      checkedAt: NOW.toISOString(),
      candidates: ["92001", "92002", "92003", "92004"].map((targetUserId) => ({ targetUserId, kind: "new" })),
    }, NOW);
    const action = hooks();
    action.inspect.mockResolvedValue({ ...profile(), blue: false, tweetLang: "zh" });
    const result = await submitFollowBatch({ accountId: 2, now: NOW, hooks: action });
    expect(result).toMatchObject({ submitted: 4, followed: 3 });
    expect(result.results.slice(0, 3).every((row) => row.result === "success" && row.reason === "approved_list")).toBe(true);
    expect(result.results[3]).toMatchObject({ targetUserId: "92004", result: "skipped", reason: "not_blue" });
    expect(action.inspect.mock.calls).toEqual([["92004"]]);
    expect(action.follow.mock.calls).toEqual([["92001"], ["92002"], ["92003"]]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM evidence_subjects").get()).toEqual({ n: 0 });
    expect(accountRows(1)).toEqual(account1Before);
    expect(readAutomationSettings(1)).toEqual(settings1);
  });

  it("does not waive screening with only the other account's switch/list, or its own switch without membership", async () => {
    enable();
    stock(["92001", "92002"]);
    saveApprovedListFollowSetting(1, true);
    saveFollowAllowlist(1, { enforced: true, targetUserIds: ["92001", "92002"] });
    saveFollowAllowlist(2, { enforced: false, targetUserIds: ["92001"] });
    expect(approvedListWaivesScreening(2, "92001")).toBe(false);
    saveApprovedListFollowSetting(2, true);
    expect(approvedListWaivesScreening(2, "92002")).toBe(false);
    const action = hooks();
    action.inspect.mockResolvedValue({ ...profile(), blue: false });
    const result = await submitFollowBatch({ accountId: 2, now: NOW, hooks: action });
    expect(result.results.map((row) => row.reason)).toEqual(["approved_list", "not_blue"]);
    expect(action.follow.mock.calls).toEqual([["92001"]]);
  });

  it("enforces account 2's own allowlist before applying batch size", async () => {
    enable();
    stock(["92001", "92002"]);
    saveAutomationSettings(2, { follow: { batchSize: 1 } });
    saveApprovedListFollowSetting(2, true);
    saveFollowAllowlist(2, { enforced: true, targetUserIds: [] });
    const action = hooks();
    expect((await submitFollowBatch({ accountId: 2, now: NOW, hooks: action })).reason).toBe("insufficient_candidates");
    expect(action.follow).not.toHaveBeenCalled();
    saveFollowAllowlist(2, { enforced: true, targetUserIds: ["92002"] });
    const result = await submitFollowBatch({ accountId: 2, now: NOW, hooks: action });
    expect(result).toMatchObject({ submitted: 1, followed: 1 });
    expect(action.follow.mock.calls).toEqual([["92002"]]);
    expect(reserve("92001")).toMatchObject({ status: "reserved" });
    expect(action.inspect).not.toHaveBeenCalled();
  });

  it.each([false, true])("skips blocklisted, already-followed and known already-following users with approvedList=%s", async (approvedList) => {
    enable();
    stock(["92001", "92002", "92003", "92004"]);
    saveApprovedListFollowSetting(2, approvedList);
    saveFollowAllowlist(2, { enforced: true, targetUserIds: ["92001", "92002", "92003", "92004"] });
    getDb().prepare("INSERT INTO follow_blocklist VALUES (2, '92001', 'unfollow_success', ?)").run(NOW.toISOString());
    getDb().prepare(
      "INSERT INTO follow_success VALUES (2, '92002', NULL, 'followback', ?, 'old-slot', '2026-11-23')",
    ).run("2026-11-23T09:05:00.000Z");
    knownFollowing("92003");
    const action = hooks();
    action.inspect.mockImplementation(async (id) => ({ ...profile(), following: id === "92003" }));
    const result = await submitFollowBatch({ accountId: 2, now: NOW, hooks: action });
    expect(result.results.find((row) => row.targetUserId === "92001")).toMatchObject({ result: "skipped", reason: "unfollowed" });
    expect(result.results.find((row) => row.targetUserId === "92003")).toMatchObject({ result: "skipped", reason: "already_following" });
    expect(action.follow.mock.calls).toEqual([["92004"]]);
    expect(action.inspect.mock.calls.flat()).not.toContain("92001");
    expect(action.inspect.mock.calls.flat()).not.toContain("92002");
    if (approvedList) expect(action.inspect).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM follow_success WHERE account_id = 2 AND target_user_id = '92002'").get()).toEqual({ n: 1 });
  });

  it.each([
    { approvedList: true, status: 429, reason: "rate_limit" },
    { approvedList: true, status: 403, reason: "auth" },
    { approvedList: false, status: 429, reason: "rate_limit" },
    { approvedList: false, status: 403, reason: "auth" },
  ])("pauses only account 2 and breaks on $status with approvedList=$approvedList", async ({ approvedList, status, reason }) => {
    enable(1);
    enable();
    saveFollowAllowlist(1, { enforced: true, targetUserIds: ["91001"] });
    saveApprovedListFollowSetting(1, true);
    const account1Before = accountRows(1);
    stock(["92001", "92002"]);
    saveFollowAllowlist(2, { enforced: true, targetUserIds: ["92001", "92002"] });
    saveApprovedListFollowSetting(2, approvedList);
    const action = hooks();
    action.follow.mockRejectedValue({ status, kind: reason });
    const result = await submitFollowBatch({ accountId: 2, now: NOW, hooks: action });
    expect(result).toMatchObject({ submitted: 1, followed: 0, results: [{ targetUserId: "92001", result: "failed", reason }] });
    expect(action.follow.mock.calls).toEqual([["92001"]]);
    expect(getDb().prepare("SELECT paused, pause_reason FROM follow_control WHERE account_id = 2").get()).toEqual({ paused: 1, pause_reason: reason });
    expect(reserve("92002")).toMatchObject({ status: "reserved" });
    expect((await submitFollowBatch({ accountId: 2, now: NEXT, hooks: action })).reason).toBe("paused");
    expect(accountRows(1)).toEqual(account1Before);
  });

  it("honors account 2 batch size, daily cap, cadence, pause, identity, environment and mock gates", async () => {
    enable();
    stock(["92001", "92002", "92003"]);
    saveApprovedListFollowSetting(2, true);
    saveFollowAllowlist(2, { enforced: true, targetUserIds: ["92001", "92002", "92003"] });
    saveAutomationSettings(2, { follow: { batchSize: 1, dailyCap: 2 } });
    const fetch = vi.fn(async () => { throw new Error("no network allowed"); });
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("X_API_MODE", "mock");
    expect((await submitFollowBatch({ accountId: 2, now: NOW })).reason).toBe("mock_mode");
    expect(fetch).not.toHaveBeenCalled();
    const action = hooks();
    vi.stubEnv("XUTIE_ACCOUNT2_FOLLOW", "off");
    expect((await submitFollowBatch({ accountId: 2, now: NOW, hooks: action })).reason).toBe("disabled");
    vi.stubEnv("XUTIE_ACCOUNT2_FOLLOW", "on");
    getDb().prepare("UPDATE credentials SET user_id = NULL WHERE id = 2").run();
    expect((await submitFollowBatch({ accountId: 2, now: NOW, hooks: action })).reason).toBe("identity_unconfirmed");
    enable();
    getDb().prepare("UPDATE follow_control SET paused = 1 WHERE account_id = 2").run();
    expect((await submitFollowBatch({ accountId: 2, now: NOW, hooks: action })).reason).toBe("paused");
    getDb().prepare("UPDATE follow_control SET paused = 0 WHERE account_id = 2").run();
    expect((await submitFollowBatch({ accountId: 2, now: new Date("2026-11-24T09:20:00Z"), hooks: action })).reason).toBe("rest");
    expect(action.follow).not.toHaveBeenCalled();
    expect((await submitFollowBatch({ accountId: 2, now: NOW, hooks: action })).followed).toBe(1);
    saveAutomationSettings(2, { follow: { batchSize: 10 } });
    expect((await submitFollowBatch({ accountId: 2, now: NEXT, hooks: action })).followed).toBe(1);
    expect((await submitFollowBatch({ accountId: 2, now: LATER, hooks: action })).reason).toBe("daily_cap");
    expect(action.follow).toHaveBeenCalledTimes(2);
    expect(action.inspect).not.toHaveBeenCalled();
    expect(reserve("92003")).toMatchObject({ status: "reserved" });
  });

  it("executes account 2 approved-list follows through the default live network hooks", async () => {
    enable();
    stock(["92001"]);
    saveApprovedListFollowSetting(2, true);
    saveFollowAllowlist(2, { enforced: true, targetUserIds: ["92001"] });
    vi.stubEnv("X_API_MODE", "live");
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ target_user_id: "92001" });
      return new Response(JSON.stringify({ data: { following: true } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await submitFollowBatch({ accountId: 2, now: NOW });
    expect(result.results).toMatchObject([{ targetUserId: "92001", result: "success", reason: "approved_list" }]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([`https://api.x.com/2/users/${SOURCE}/following`]);
  });
});
