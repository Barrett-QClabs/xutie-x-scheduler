import { afterEach, describe, expect, it } from "vitest";
import { GET as readIdentity, PUT as writeIdentity } from "@/app/api/credentials/identity/route";
import { POST as testCredentialsRoute } from "@/app/api/credentials/test/route";
import { accountIdentity, executionUserId, saveManualIdentity } from "@/lib/account-identity";
import { getCredentialsRow, updateAccount } from "@/lib/db";
import { evidenceCoverage, importEvidence } from "@/lib/evidence";
import { getFollowStatus, setFollowPaused, stockFollowReserve, submitFollowBatch } from "@/lib/follow-queue";
import { saveCredentials, testCredentials } from "@/lib/service";
import { getUnfollowStatus, importUnfollowCandidates, setUnfollowPaused, submitUnfollowBatch } from "@/lib/unfollow-queue";

const DAY = "2026-11-20";
const SELF = "777000111";
const USERS_ME = "GET https://api.x.com/2/users/me?user.fields=id%2Cname%2Cusername";

function taipei(hour: number, minute: number, day = DAY): Date {
  const text = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  return new Date(Date.parse(text) - 8 * 60 * 60 * 1000);
}

function keys(apiKey: string) {
  return { apiKey, apiSecret: `${apiKey}-secret`, accessToken: `${apiKey}-token`, accessTokenSecret: `${apiKey}-token-secret` };
}

function identityPut(body: Record<string, unknown>) {
  return writeIdentity(new Request("http://local/api/credentials/identity", { method: "PUT", body: JSON.stringify(body) }));
}

function verify(body: Record<string, unknown>) {
  return testCredentialsRoute(new Request("http://local/api/credentials/test", { method: "POST", body: JSON.stringify(body) }));
}

function envelope(accountId: string, tool: string, subjects: Array<Record<string, unknown>>, observed: Date, expires: Date) {
  return {
    schema_version: 1,
    account_id: accountId,
    source_namespace: "user-X",
    source_tool: tool,
    observed_at: observed.toISOString(),
    expires_at: expires.toISOString(),
    request_fields: ["verified", "verified_type", "connection_status"],
    coverage: { pagination_complete: true, next_token: null, activity_window_complete: false, excluded: [] },
    errors: [],
    subjects,
  };
}

function stubFetch(respond: (method: string, url: string) => Response) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${String(input)}`);
    return respond(method, String(input));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_FOLLOW;
  delete process.env.XUTIE_ACCOUNT2_FOLLOW;
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete process.env.XUTIE_ACCOUNT2_UNFOLLOW;
  process.env.X_API_MODE = "mock";
});

describe("slot identity without a compiled pin", () => {
  it("follows and unfollows live as the slot's own stored identity and keeps the blacklist and dedup", async () => {
    process.env.X_API_MODE = "live";
    const fetches = stubFetch((method) => (
      method === "GET"
        ? new Response("no read", { status: 500 })
        : new Response(JSON.stringify({ data: { following: method === "POST" } }), { status: 200 })
    ));
    try {
      saveCredentials(1, keys("selfhostA"));
      expect(saveManualIdentity(1, { userId: SELF, username: "@self_host", displayName: "Self Host" })).toMatchObject({
        state: "confirmed",
        userId: SELF,
        username: "self_host",
        displayName: "Self Host",
        source: "manual",
        executionAllowed: true,
      });
      process.env.XUTIE_ACCOUNT1_FOLLOW = "on";
      process.env.XUTIE_ACCOUNT1_UNFOLLOW = "on";
      setFollowPaused(1, false, "test");
      setUnfollowPaused(1, false, "test");

      const followAt = taipei(9, 5);
      const fan = (id: string) => ({
        id, username: "fan", name: "中文名", description: "回关", verified: true, verified_type: "blue", connection_status: ["followed_by"],
      });
      expect(() => importEvidence(1, envelope("1933586991612080128", "get_users_me_followers", [fan("98001")], taipei(9, 0), taipei(10, 0))))
        .toThrow(/不属于这个槽/);
      importEvidence(1, envelope(SELF, "get_users_me_followers", [fan("98001"), fan("98002")], taipei(9, 0), taipei(10, 0)), followAt);
      expect(evidenceCoverage(1, followAt).sourceUserId).toBe(SELF);
      stockFollowReserve(1, {
        checkedAt: taipei(9, 0).toISOString(),
        candidates: [{ targetUserId: "98001", kind: "followback" }, { targetUserId: "98002", kind: "followback" }],
      }, taipei(9, 1));
      const follow = await submitFollowBatch({ accountId: 1, now: followAt, random: () => 0 });
      expect(follow.slot).toBe(`taipei:${DAY}T09:00`);
      expect(follow.followed).toBe(2);
      expect(fetches.calls.filter((call) => call.startsWith("POST"))).toEqual([
        `POST https://api.x.com/2/users/${SELF}/following`,
        `POST https://api.x.com/2/users/${SELF}/following`,
      ]);

      const unfollowAt = taipei(5, 20);
      importUnfollowCandidates(1, { candidates: [{ targetUserId: "98101", tier: "non_blue" }] });
      importEvidence(1, envelope(SELF, "get_users_me_following", [
        { id: "98101", verified: false, verified_type: "none", connection_status: ["following"] },
      ], taipei(5, 0), taipei(8, 0)), unfollowAt);
      const unfollow = await submitUnfollowBatch({ accountId: 1, now: unfollowAt });
      expect(unfollow.unfollowed).toBe(1);
      expect(fetches.calls).toContain(`DELETE https://api.x.com/2/users/${SELF}/following/98101`);
      expect(fetches.calls.some((call) => call.startsWith("GET"))).toBe(false);
      expect(fetches.calls.some((call) => call.includes("1933586991612080128"))).toBe(false);

      expect(stockFollowReserve(1, {
        checkedAt: taipei(9, 0).toISOString(),
        candidates: [{ targetUserId: "98101", kind: "followback" }, { targetUserId: "98001", kind: "followback" }],
      }, taipei(9, 1)).rejected).toEqual([
        { targetUserId: "98101", reason: "unfollowed" },
        { targetUserId: "98001", reason: "already_followed" },
      ]);
      expect(getFollowStatus(1, followAt)).toMatchObject({ identityConfirmed: true, identityState: "confirmed" });
      expect(getCredentialsRow(2)).toBeNull();
    } finally {
      fetches.restore();
    }
  });

  it("validates manual identity, keeps it on its own slot, and stops both slots on a shared id", async () => {
    const noKeys = await identityPut({ accountId: 1, userId: "555000111", username: "first" });
    expect(noKeys.status).toBe(400);
    expect((await noKeys.json()).code).toBe("credentials_missing");
    saveCredentials(1, keys("slotoneA"));
    saveCredentials(2, keys("slottwoB"));
    for (const body of [
      { accountId: 1, userId: "12ab", username: "first" },
      { accountId: 1, userId: 555000111, username: "first" },
      { accountId: 1, userId: "555000111", username: "has space" },
      { accountId: 1, userId: "555000111", username: "first", displayName: "x".repeat(51) },
      { accountId: 1, userId: "555000111", username: "first", displayName: 5 },
    ]) {
      const response = await identityPut(body);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_identity");
    }
    const reserved = await identityPut({ accountId: 1, userId: "1468479269701820422", username: "boylittle18" });
    expect(reserved.status).toBe(409);
    expect((await reserved.json()).code).toBe("identity_conflict");
    const saved = await identityPut({ accountId: 1, userId: "555000111", username: "first", displayName: "First" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ accountId: 1, state: "confirmed", source: "manual", userId: "555000111" });
    const clash = await identityPut({ accountId: 2, userId: "555000111", username: "second" });
    expect(clash.status).toBe(409);
    expect(getCredentialsRow(2)?.user_id ?? null).toBeNull();
    expect((await identityPut({ accountId: 2, userId: "555000222", username: "second" })).status).toBe(200);
    expect(await (await readIdentity(new Request("http://local/api/credentials/identity?accountId=1"))).json()).toMatchObject({ userId: "555000111" });
    expect(await (await readIdentity(new Request("http://local/api/credentials/identity?accountId=2"))).json()).toMatchObject({ userId: "555000222" });
    expect((await readIdentity(new Request("http://local/api/credentials/identity"))).status).toBe(400);

    updateAccount(2, { username: "first", displayName: "First", userId: "555000111" });
    expect(accountIdentity(1).state).toBe("conflict");
    expect(accountIdentity(2).state).toBe("conflict");
    process.env.XUTIE_ACCOUNT1_FOLLOW = "on";
    process.env.XUTIE_ACCOUNT2_FOLLOW = "on";
    process.env.XUTIE_ACCOUNT1_UNFOLLOW = "on";
    process.env.XUTIE_ACCOUNT2_UNFOLLOW = "on";
    for (const id of [1, 2] as const) {
      setFollowPaused(id, false, "test");
      setUnfollowPaused(id, false, "test");
    }
    const follow = { inspect: async () => { throw new Error("must not inspect"); }, follow: async () => { throw new Error("must not follow"); } };
    const unfollow = { inspect: async () => { throw new Error("must not inspect"); }, unfollow: async () => { throw new Error("must not unfollow"); } };
    expect((await submitFollowBatch({ accountId: 1, now: taipei(9, 5), hooks: follow })).reason).toBe("identity_unconfirmed");
    expect((await submitFollowBatch({ accountId: 2, now: taipei(9, 5), hooks: follow })).reason).toBe("identity_unconfirmed");
    expect((await submitUnfollowBatch({ accountId: 1, now: taipei(5, 20), hooks: unfollow })).reason).toBe("identity_unconfirmed");
    expect((await submitUnfollowBatch({ accountId: 2, now: taipei(5, 20), hooks: unfollow })).reason).toBe("identity_unconfirmed");
    expect(getFollowStatus(1, taipei(9, 5))).toMatchObject({ identityConfirmed: false, identityState: "conflict" });
    expect(getUnfollowStatus(2, taipei(5, 20))).toMatchObject({ identityConfirmed: false, identityState: "conflict" });

    saveCredentials(2, keys("slottwoC"));
    expect(accountIdentity(2).state).toBe("missing");
    expect(accountIdentity(1).state).toBe("confirmed");
    expect(executionUserId(1)).toBe("555000111");
    expect(executionUserId(2)).toBeNull();
  });

  it("refuses a live-verified id that the other slot already holds, after exactly one read", async () => {
    process.env.X_API_MODE = "live";
    const fetches = stubFetch(() => new Response(JSON.stringify({ data: { id: "444000111", username: "taken", name: "Taken" } }), { status: 200 }));
    try {
      saveCredentials(2, keys("slottwoB"));
      updateAccount(2, { username: "taken", displayName: "Taken", userId: "444000111" });
      saveCredentials(1, keys("slotoneA"));
      const response = await verify({ accountId: 1 });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("identity_conflict");
      expect(getCredentialsRow(1)?.user_id ?? null).toBeNull();
      expect(getCredentialsRow(2)?.user_id).toBe("444000111");
      expect(fetches.calls).toEqual([USERS_ME]);
    } finally {
      fetches.restore();
    }
  });

  it("falls back to manual identity when the explicit read is unavailable, then runs without another read", async () => {
    process.env.X_API_MODE = "live";
    const fetches = stubFetch(() => new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 }));
    try {
      saveCredentials(1, keys("slotoneA"));
      const failed = await verify({ accountId: 1 });
      expect(failed.status).toBe(400);
      const error = await failed.json();
      expect(error.code).toBe("x_error");
      expect(error.message).toContain("/api/credentials/identity");
      expect(JSON.stringify(error)).not.toContain("slotoneA-secret");
      expect((await identityPut({ accountId: 1, userId: "333000111", username: "manual_one" })).status).toBe(200);
      expect(getFollowStatus(1, taipei(9, 5)).identityConfirmed).toBe(true);
      expect(getUnfollowStatus(1, taipei(5, 20))).toMatchObject({ identityConfirmed: true, identityState: "confirmed" });
      const kept = await verify({ accountId: 1 });
      expect(await kept.json()).toMatchObject({ userId: "333000111", liveRead: false, identitySource: "manual" });
      expect(fetches.calls).toEqual([USERS_ME]);
    } finally {
      fetches.restore();
    }
  });

  it("gives each mock key its own verified identity so both slots can run", async () => {
    saveCredentials(1, keys("alphaKey"));
    saveCredentials(2, keys("betaKey"));
    const one = await testCredentials(1);
    const two = await testCredentials(2);
    expect(one.saved).toBe(true);
    expect(two.saved).toBe(true);
    expect(one.userId).not.toBe(two.userId);
    expect(accountIdentity(1)).toMatchObject({ state: "confirmed", source: "verify" });
    expect(accountIdentity(2)).toMatchObject({ state: "confirmed", source: "verify" });
    expect(executionUserId(1)).toBe(one.userId);
    expect(executionUserId(2)).toBe(two.userId);
  });
});
