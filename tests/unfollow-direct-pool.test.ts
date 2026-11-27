import { afterEach, describe, expect, it, vi } from "vitest";
import * as automationAccount from "@/lib/automation-account";
import { readAutomationSettings, saveAutomationSettings } from "@/lib/automation-settings";
import { getDb, updateAccount } from "@/lib/db";
import { importEvidence } from "@/lib/evidence";
import { followBlocked } from "@/lib/follow-blocklist";
import { saveCredentials } from "@/lib/service";
import {
  executableUnfollowCount,
  importUnfollowCandidates,
  listUnfollowCandidates,
  setUnfollowPaused,
  submitUnfollowBatch,
} from "@/lib/unfollow-queue";

const SLOT = new Date("2026-11-07T21:20:00.000Z");
const NEXT = new Date("2026-11-07T21:50:00.000Z");
const LATER = new Date("2026-11-07T22:20:00.000Z");
const IDS = ["7101", "7102"];

function enable(accountId: 1 | 2 = 1, directPool = true) {
  vi.stubEnv(accountId === 1 ? "XUTIE_ACCOUNT1_UNFOLLOW" : "XUTIE_ACCOUNT2_UNFOLLOW", "on");
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
  if (directPool) saveAutomationSettings(accountId, { unfollow: { directPool: true } });
}

/** Existing candidates left open by a previous evidence-backed batch. Never re-imported after enabling. */
function staleCandidates(accountId: 1 | 2 = 1) {
  importUnfollowCandidates(accountId, {
    candidates: [
      { targetUserId: IDS[0], tier: "non_blue" },
      { targetUserId: IDS[1], tier: "no_followback_72h" },
    ],
  });
  importEvidence(accountId, {
    schema_version: 1,
    account_id: accountId === 1 ? "1933586991612080128" : "1468479269701820422",
    source_namespace: accountId === 1 ? "user-X" : "user-X--english",
    source_tool: "get_users_me_following",
    observed_at: "2026-11-05T00:00:00.000Z",
    expires_at: "2026-11-05T12:00:00.000Z",
    request_fields: ["verified", "verified_type", "connection_status"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [],
    subjects: [{ id: IDS[0], verified: false, verified_type: "none", connection_status: ["following"] }],
  }, SLOT);
  const update = getDb().prepare(
    "UPDATE unfollow_candidates SET result = 'skipped', reason = ? WHERE account_id = ? AND target_user_id = ?",
  );
  update.run("evidence_expired", accountId, IDS[0]);
  update.run("evidence_missing", accountId, IDS[1]);
}

function candidate(accountId: 1 | 2, id: string) {
  return getDb().prepare(
    "SELECT status, result, reason FROM unfollow_candidates WHERE account_id = ? AND target_user_id = ?",
  ).get(accountId, id);
}

function hooks() {
  return {
    inspect: vi.fn(async () => { throw new Error("direct pool must not inspect"); }),
    unfollow: vi.fn(async (_id: string) => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("direct pool unfollow", () => {
  it("counts existing skipped candidates of every valid tier, excluding invalid tiers and fixed whitelist ids", () => {
    enable(1, false);
    staleCandidates();
    importUnfollowCandidates(1, { candidates: [{ targetUserId: "7103", tier: "inactive_48h" }] });
    const stamp = SLOT.toISOString();
    const insert = getDb().prepare(
      `INSERT INTO unfollow_candidates (account_id, target_user_id, tier, status, created_at, updated_at)
       VALUES (1, ?, ?, 'candidate', ?, ?)`,
    );
    for (const id of automationAccount.UNFOLLOW_WHITELIST) insert.run(id, "non_blue", stamp, stamp);
    insert.run("7199", "invalid_tier", stamp, stamp);
    expect(executableUnfollowCount(1, SLOT)).toBe(0);

    saveAutomationSettings(1, { unfollow: { directPool: true } });
    expect(executableUnfollowCount(1, SLOT)).toBe(3);
    const page = listUnfollowCandidates(1, undefined, SLOT);
    expect(page.executable).toBe(3);
    expect(page.candidates.find((row) => row.targetUserId === IDS[0])).toMatchObject({
      status: "candidate", result: "skipped", reason: "evidence_expired", evidence: "expired",
    });
    expect(page.candidates.find((row) => row.targetUserId === IDS[1])).toMatchObject({
      status: "candidate", result: "skipped", reason: "evidence_missing", evidence: "missing",
    });
  });

  it("executes existing expired/missing candidates with custom hooks, bypasses inspection, and permanently blocks account 1 successes", async () => {
    enable(1, false);
    staleCandidates();
    saveAutomationSettings(1, { unfollow: { directPool: true } });
    const action = hooks();
    const result = await submitUnfollowBatch({ accountId: 1, now: SLOT, hooks: action });
    expect(result).toMatchObject({ executed: true, submitted: 2, unfollowed: 2 });
    expect(result.results).toEqual([
      { targetUserId: IDS[0], tier: "non_blue", result: "success", reason: "direct_pool" },
      { targetUserId: IDS[1], tier: "no_followback_72h", result: "success", reason: "direct_pool" },
    ]);
    expect(action.inspect).not.toHaveBeenCalled();
    expect(action.unfollow.mock.calls.map(([id]) => id)).toEqual(IDS);
    for (const id of IDS) {
      expect(candidate(1, id)).toEqual({ status: "success", result: "success", reason: "direct_pool" });
      expect(followBlocked(1, id)).toBe(true);
      expect(followBlocked(2, id)).toBe(false);
      expect(getDb().prepare("SELECT source FROM follow_blocklist WHERE account_id = 1 AND target_user_id = ?").get(id))
        .toEqual({ source: "unfollow_success" });
    }
    const replay = await submitUnfollowBatch({ accountId: 1, now: SLOT, hooks: action });
    expect(replay.replay).toBe(true);
    expect(action.unfollow).toHaveBeenCalledTimes(2);
  });

  it("executes the live-hook path after enabling, without refreshing or rewriting stale evidence", async () => {
    vi.stubEnv("X_API_MODE", "live");
    enable(1, false);
    staleCandidates();
    const evidenceBefore = getDb().prepare("SELECT * FROM evidence_subjects").all();
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "DELETE") throw new Error("only DELETE is allowed");
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    // The default live path leaves all stale candidates open and marks their evidence failures.
    const before = await submitUnfollowBatch({ accountId: 1, now: SLOT });
    expect(before).toMatchObject({ submitted: 0, unfollowed: 0 });
    expect(fetch).not.toHaveBeenCalled();
    importUnfollowCandidates(1, { candidates: [{ targetUserId: "7103", tier: "inactive_48h" }] });
    saveAutomationSettings(1, { unfollow: { directPool: true, batchSize: 1 } });
    const result = await submitUnfollowBatch({ accountId: 1, now: NEXT });
    expect(result).toMatchObject({ submitted: 1, unfollowed: 1 });
    expect(result.results[0]).toMatchObject({ targetUserId: IDS[0], result: "success", reason: "direct_pool" });
    // A candidate outside this batch is not rewritten by noteStaleEvidence in direct-pool mode.
    expect(candidate(1, IDS[1])).toEqual({ status: "candidate", result: "skipped", reason: "evidence_missing" });
    expect(candidate(1, "7103")).toEqual({ status: "candidate", result: null, reason: null });
    saveAutomationSettings(1, { unfollow: { batchSize: 10 } });
    const rest = await submitUnfollowBatch({ accountId: 1, now: LATER });
    expect(rest.unfollowed).toBe(2);
    expect(rest.results.every((row) => row.result === "success" && row.reason === "direct_pool")).toBe(true);
    expect(fetch.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      `DELETE https://api.x.com/2/users/1933586991612080128/following/${IDS[0]}`,
      `DELETE https://api.x.com/2/users/1933586991612080128/following/${IDS[1]}`,
      "DELETE https://api.x.com/2/users/1933586991612080128/following/7103",
    ]);
    expect(getDb().prepare("SELECT * FROM evidence_subjects").all()).toEqual(evidenceBefore);
  });

  it("excludes all fixed whitelist ids from selection", async () => {
    enable();
    const stamp = SLOT.toISOString();
    const insert = getDb().prepare(
      `INSERT INTO unfollow_candidates (account_id, target_user_id, tier, status, created_at, updated_at)
       VALUES (1, ?, 'non_blue', 'candidate', ?, ?)`,
    );
    for (const id of automationAccount.UNFOLLOW_WHITELIST) insert.run(id, stamp, stamp);
    const action = hooks();
    const result = await submitUnfollowBatch({ accountId: 1, now: SLOT, hooks: action });
    expect(result).toMatchObject({ submitted: 0, unfollowed: 0 });
    expect(action.inspect).not.toHaveBeenCalled();
    expect(action.unfollow).not.toHaveBeenCalled();
  });

  it("rechecks the whitelist immediately before each delete and records whitelisted for a newly protected target", async () => {
    enable();
    const whitelist = new Set(automationAccount.UNFOLLOW_WHITELIST);
    vi.spyOn(automationAccount, "unfollowWhitelist").mockImplementation((accountId) =>
      accountId === 1 ? whitelist : automationAccount.ACCOUNT2_UNFOLLOW_WHITELIST);
    staleCandidates();
    const action = hooks();
    action.unfollow.mockImplementation(async () => { whitelist.add(IDS[1]); });
    const result = await submitUnfollowBatch({ accountId: 1, now: SLOT, hooks: action });
    expect(action.inspect).not.toHaveBeenCalled();
    expect(action.unfollow.mock.calls.map(([id]) => id)).toEqual([IDS[0]]);
    expect(result.results[1]).toMatchObject({ targetUserId: IDS[1], result: "skipped", reason: "whitelisted" });
    expect(candidate(1, IDS[1])).toEqual({ status: "skipped", result: "skipped", reason: "whitelisted" });
    expect(followBlocked(1, IDS[1])).toBe(false);
  });

  it.each([
    { status: 429, kind: "rate_limit", reason: "rate_limit" },
    { status: 403, reason: "auth" },
  ])("pauses immediately and breaks the batch on $status", async ({ status, reason, ...extra }) => {
    enable();
    staleCandidates();
    const action = hooks();
    action.unfollow.mockRejectedValue(Object.assign(new Error("risk stop"), { status, ...extra }));
    const result = await submitUnfollowBatch({ accountId: 1, now: SLOT, hooks: action });
    expect(action.inspect).not.toHaveBeenCalled();
    expect(action.unfollow.mock.calls.map(([id]) => id)).toEqual([IDS[0]]);
    expect(result).toMatchObject({ submitted: 1, unfollowed: 0, results: [{ targetUserId: IDS[0], result: "failed", reason }] });
    expect(getDb().prepare("SELECT paused, pause_reason FROM unfollow_control WHERE account_id = 1").get())
      .toEqual({ paused: 1, pause_reason: reason });
    expect(candidate(1, IDS[1])).toMatchObject({ status: "candidate" });
    expect(followBlocked(1, IDS[0])).toBe(false);
    expect((await submitUnfollowBatch({ accountId: 1, now: NEXT, hooks: action })).reason).toBe("paused");
    expect(action.unfollow).toHaveBeenCalledTimes(1);
  });

  it("respects batch size and the remaining daily cap across slots", async () => {
    enable();
    staleCandidates();
    importUnfollowCandidates(1, { candidates: [{ targetUserId: "7103", tier: "inactive_48h" }] });
    saveAutomationSettings(1, { unfollow: { batchSize: 1, dailyCap: 2 } });
    const action = hooks();
    expect((await submitUnfollowBatch({ accountId: 1, now: SLOT, hooks: action })).unfollowed).toBe(1);
    saveAutomationSettings(1, { unfollow: { batchSize: 10 } });
    expect((await submitUnfollowBatch({ accountId: 1, now: NEXT, hooks: action })).unfollowed).toBe(1);
    expect((await submitUnfollowBatch({ accountId: 1, now: LATER, hooks: action })).reason).toBe("daily_cap");
    expect(action.unfollow).toHaveBeenCalledTimes(2);
    expect(candidate(1, "7103")).toMatchObject({ status: "candidate" });
  });

  it("stops before the next target when paused mid-batch", async () => {
    enable();
    staleCandidates();
    const action = hooks();
    action.unfollow.mockImplementation(async () => { setUnfollowPaused(1, true, "manual"); });
    const result = await submitUnfollowBatch({ accountId: 1, now: SLOT, hooks: action });
    expect(result).toMatchObject({ submitted: 1, unfollowed: 1 });
    expect(action.unfollow).toHaveBeenCalledTimes(1);
    expect(candidate(1, IDS[1])).toMatchObject({ status: "candidate" });
  });

  it("leaves account 2's default evidence checks unchanged when only account 1 enables direct pool", async () => {
    vi.stubEnv("X_API_MODE", "live");
    enable();
    enable(2, false);
    staleCandidates(1);
    staleCandidates(2);
    expect(readAutomationSettings(2).unfollow.directPool).toBe(false);
    expect(executableUnfollowCount(1, SLOT)).toBe(2);
    expect(executableUnfollowCount(2, SLOT)).toBe(0);
    expect(listUnfollowCandidates(2, undefined, SLOT).executable).toBe(0);
    const fetch = vi.fn(async () => { throw new Error("no network allowed"); });
    vi.stubGlobal("fetch", fetch);
    const result = await submitUnfollowBatch({ accountId: 2, now: SLOT });
    expect(result).toMatchObject({ submitted: 0, unfollowed: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(candidate(2, IDS[0])).toEqual({ status: "candidate", result: "skipped", reason: "evidence_expired" });
    expect(candidate(2, IDS[1])).toEqual({ status: "candidate", result: "skipped", reason: "evidence_missing" });
  });

  it("keeps direct-pool mode off the network in mock mode", async () => {
    enable();
    staleCandidates();
    vi.stubEnv("X_API_MODE", "mock");
    const fetch = vi.fn(async () => { throw new Error("no network allowed"); });
    vi.stubGlobal("fetch", fetch);
    expect((await submitUnfollowBatch({ accountId: 1, now: SLOT })).reason).toBe("mock_mode");
    expect(fetch).not.toHaveBeenCalled();
    expect(candidate(1, IDS[0])).toMatchObject({ status: "candidate" });
  });
});
