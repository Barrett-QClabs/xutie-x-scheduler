import { afterEach, describe, expect, it } from "vitest";
import { GET as readAudit, POST as submitBatch } from "@/app/api/unfollow/batches/route";
import { POST as pauseUnfollow } from "@/app/api/unfollow/pause/route";
import { POST as resumeUnfollow } from "@/app/api/unfollow/resume/route";
import { GET as readUnfollow, POST as postUnfollow } from "@/app/api/unfollow/route";
import { getDb, getQueueSettings, updateAccount } from "@/lib/db";
import { profileFromLookup } from "@/lib/unfollow-live";
import { UNFOLLOW_WHITELIST } from "@/lib/unfollow-policy";
import { xDelete, xGet } from "@/lib/x-client";
import {
  classifyAction,
  halfHourSlot,
  importUnfollowCandidates,
  setUnfollowPaused,
  submitUnfollowBatch,
  type FreshProfile,
  type UnfollowHooks,
} from "@/lib/unfollow-queue";
import { getPublicState, importTweets, saveCredentials } from "@/lib/service";

const SECRET = "slot-one-secret-value";

function enable() {
  process.env.XUTIE_ACCOUNT1_UNFOLLOW = "on";
  saveCredentials(1, {
    apiKey: "acctoneA",
    apiSecret: SECRET,
    accessToken: "acctoneA-token",
    accessTokenSecret: "acctoneA-token-secret",
  });
  updateAccount(1, { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" });
  setUnfollowPaused(false, "test");
}

const confirmed: FreshProfile = {
  following: true,
  blue: false,
  followsBack: false,
  lastPostAt: null,
  lastPostKnown: true,
};

function hooks(map: Record<string, FreshProfile>, calls: string[]): UnfollowHooks {
  return {
    inspect: async (id) => map[id] ?? { following: null, blue: null, followsBack: null, lastPostAt: null, lastPostKnown: false },
    unfollow: async (id) => {
      calls.push(id);
    },
  };
}

afterEach(() => {
  delete process.env.XUTIE_ACCOUNT1_UNFOLLOW;
  delete (globalThis as { __xutiUnfollowHooks?: UnfollowHooks }).__xutiUnfollowHooks;
});

describe("account 1 unfollow batch", () => {
  it("does not report execution while the switch is off", async () => {
    const calls: string[] = [];
    const result = await submitUnfollowBatch({ hooks: hooks({}, calls) });
    expect(result.executed).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(result.unfollowed).toBe(0);
    expect(calls).toEqual([]);
  });

  it("rejects account 2 and whitelist ids, and does not touch the post queue", async () => {
    const posted = importTweets({
      accountId: 1,
      source: "把我取关的人，不要和我说话",
      format: "text",
      startAt: "2026-11-08T06:25:46.000Z",
      intervalMinutes: 15,
      randomMinSeconds: 0,
      randomMaxSeconds: 0,
    });
    const before = getQueueSettings(1);
    await expect(
      pauseUnfollow(
        new Request("http://local/api/unfollow/pause", {
          method: "POST",
          body: JSON.stringify({ accountId: 2 }),
        }),
      ).then((response) => response.status),
    ).resolves.toBe(403);
    const imported = importUnfollowCandidates({
      candidates: [
        { targetUserId: "25073877", tier: "non_blue" },
        { targetUserId: "555", tier: "non_blue" },
        { targetUserId: "555", tier: "inactive_48h" },
      ],
    });
    expect(imported.rejected.map((item) => item.reason)).toContain("whitelist");
    expect(imported.accepted).toEqual(["555"]);
    expect(imported.existing).toEqual(["555"]);
    expect(getPublicState().tweets[0].text).toBe("把我取关的人，不要和我说话");
    expect(getPublicState().tweets[0].scheduledAt).toBe(posted.queued[0].scheduledAt);
    expect(getQueueSettings(1).paused).toBe(before.paused);
    expect(UNFOLLOW_WHITELIST.has("44196397")).toBe(true);
  });

  it("unfollows only a fresh confirmed non-blue, fourteen at a time, without replay or overlap", async () => {
    enable();
    const ids = Array.from({ length: 16 }, (_, index) => String(1000 + index));
    importUnfollowCandidates({
      candidates: [
        ...ids.map((id) => ({ targetUserId: id, tier: "non_blue" as const })),
        { targetUserId: "2000", tier: "inactive_48h" as const },
        {
          targetUserId: "3000",
          tier: "no_followback_72h" as const,
          firstRecordedAt: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const calls: string[] = [];
    const fresh: Record<string, FreshProfile> = {};
    for (const id of ids) fresh[id] = confirmed;
    fresh["2000"] = { ...confirmed, lastPostAt: new Date().toISOString() };
    fresh["3000"] = confirmed;
    const now = new Date("2026-11-08T04:00:00.000Z");
    const first = await submitUnfollowBatch({ now, hooks: hooks(fresh, calls) });
    expect(halfHourSlot(now)).toBe("2026-11-08T12:00");
    expect(first.executed).toBe(true);
    expect(first.submitted).toBe(14);
    expect(first.unfollowed).toBe(14);
    expect(first.results.every((item) => item.tier === "non_blue" && item.result === "success")).toBe(true);
    expect(calls).toHaveLength(14);

    const replay = await submitUnfollowBatch({ now, hooks: hooks(fresh, calls) });
    expect(replay.replay).toBe(true);
    expect(calls).toHaveLength(14);

    const later = await submitUnfollowBatch({ now: new Date("2026-11-08T04:30:00.000Z"), hooks: hooks(fresh, calls) });
    expect(later.slot).toBe("2026-11-08T12:30");
    expect(later.submitted).toBe(3);
    expect(later.results.map((item) => item.result).sort()).toEqual(["skipped", "success", "success"]);
    expect(later.unfollowed).toBe(2);
    expect(calls).toHaveLength(16);
    expect(JSON.stringify(later)).not.toContain(SECRET);
  });

  it("keeps a post at exactly 48 hours and still unfollows an older one", async () => {
    enable();
    const now = new Date("2026-11-08T08:00:00.000Z");
    const hour = 60 * 60 * 1000;
    importUnfollowCandidates({
      candidates: [
        { targetUserId: "41", tier: "inactive_48h" },
        { targetUserId: "42", tier: "inactive_48h" },
        { targetUserId: "43", tier: "non_blue" },
      ],
    });
    expect(importUnfollowCandidates({ candidates: [{ targetUserId: "99", tier: "inactive_36h" }] }).rejected[0].reason).toBe(
      "invalid_tier",
    );
    const stamp = now.toISOString();
    getDb()
      .prepare(
        `INSERT INTO unfollow_candidates
          (account_id, target_user_id, username, tier, first_recorded_at, status, created_at, updated_at)
         VALUES (1, '44', NULL, 'inactive_36h', NULL, 'candidate', ?, ?)`,
      )
      .run(stamp, stamp);
    const calls: string[] = [];
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const result = await submitUnfollowBatch({
      now,
      hooks: hooks(
        {
          "41": { ...confirmed, lastPostAt: at(48 * hour) },
          "42": { ...confirmed, lastPostAt: at(48 * hour + 1) },
          "43": { ...confirmed, lastPostAt: at(hour) },
          "44": { ...confirmed, lastPostAt: at(40 * hour) },
        },
        calls,
      ),
    });
    expect(result.results.find((item) => item.targetUserId === "41")?.reason).toBe("not_older_than_48h");
    expect(result.results.find((item) => item.targetUserId === "44")?.reason).toBe("not_older_than_48h");
    expect(result.results.find((item) => item.targetUserId === "42")?.result).toBe("success");
    expect(result.results.find((item) => item.targetUserId === "43")?.result).toBe("success");
    expect(calls.sort()).toEqual(["42", "43"]);
  });

  it("does not act when following, blue, or the last post is unknown", async () => {
    enable();
    importUnfollowCandidates({
      candidates: [
        { targetUserId: "11", tier: "non_blue" },
        { targetUserId: "12", tier: "non_blue" },
        { targetUserId: "13", tier: "inactive_48h" },
      ],
    });
    const calls: string[] = [];
    const result = await submitUnfollowBatch({
      now: new Date("2026-11-08T05:00:00.000Z"),
      hooks: hooks(
        {
          "11": { following: null, blue: false, followsBack: false, lastPostAt: null, lastPostKnown: true },
          "12": { following: false, blue: false, followsBack: false, lastPostAt: null, lastPostKnown: true },
          "13": { following: true, blue: false, followsBack: false, lastPostAt: null, lastPostKnown: false },
        },
        calls,
      ),
    });
    expect(calls).toEqual([]);
    expect(result.unfollowed).toBe(0);
    expect(result.submitted).toBe(3);
    expect(result.results.map((item) => item.result)).toEqual(["unknown", "skipped", "unknown"]);
  });

  it("returns overlap instead of a second execution", async () => {
    enable();
    importUnfollowCandidates({ candidates: [{ targetUserId: "77", tier: "non_blue" }] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: UnfollowHooks = {
      inspect: async () => {
        await gate;
        return confirmed;
      },
      unfollow: async () => undefined,
    };
    const now = new Date("2026-11-08T06:00:00.000Z");
    const running = submitUnfollowBatch({ now, hooks: slow });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await submitUnfollowBatch({ now, hooks: slow });
    expect(second.executed).toBe(false);
    expect(second.reason).toBe("overlap");
    release();
    const first = await running;
    expect(first.unfollowed).toBe(1);
  });

  it("does not unfollow when account 1 is verified as a different user", async () => {
    process.env.XUTIE_ACCOUNT1_UNFOLLOW = "on";
    saveCredentials(1, {
      apiKey: "acctoneA",
      apiSecret: SECRET,
      accessToken: "acctoneA-token",
      accessTokenSecret: "acctoneA-token-secret",
    });
    updateAccount(1, { username: "other_user", displayName: "Other", userId: "1468479269701820422" });
    setUnfollowPaused(false, "test");
    importUnfollowCandidates({ candidates: [{ targetUserId: "11", tier: "non_blue" }] });
    const calls: string[] = [];
    const result = await submitUnfollowBatch({ now: new Date("2026-11-08T07:00:00.000Z"), hooks: hooks({ "11": confirmed }, calls) });
    expect(result.executed).toBe(false);
    expect(result.reason).toBe("identity_unconfirmed");
    expect(result.unfollowed).toBe(0);
    expect(calls).toEqual([]);
  });

  it("refuses the HTTP batch for account 2 and while disabled", async () => {
    const response = await submitBatch(new Request("http://local/api/unfollow/batches", {
      method: "POST",
      body: JSON.stringify({ accountId: 2 }),
    }));
    expect(response.status).toBe(403);
    const disabled = await submitBatch(new Request("http://local/api/unfollow/batches", {
      method: "POST",
      body: JSON.stringify({ accountId: 1 }),
    }));
    expect(disabled.status).toBe(200);
    const body = await disabled.json();
    expect(body.executed).toBe(false);
    expect(body.reason).toBe("disabled");
    expect(body.unfollowed).toBe(0);
  });

  it("does not retry an unknown lookup or a failed delete on the next slot", async () => {
    enable();
    importUnfollowCandidates({
      candidates: [
        { targetUserId: "11", tier: "non_blue" },
        { targetUserId: "12", tier: "non_blue" },
      ],
    });
    const calls: string[] = [];
    const failing: UnfollowHooks = {
      inspect: async (id) => (id === "11" ? { following: null, blue: null, followsBack: null, lastPostAt: null, lastPostKnown: false } : confirmed),
      unfollow: async (id) => {
        calls.push(id);
        throw new Error("delete failed");
      },
    };
    const first = await submitUnfollowBatch({ now: new Date("2026-11-08T05:00:00.000Z"), hooks: failing });
    expect(first.submitted).toBe(2);
    expect(first.unfollowed).toBe(0);
    expect(first.results.map((item) => item.result)).toEqual(["unknown", "failed"]);
    expect(calls).toEqual(["12"]);
    const second = await submitUnfollowBatch({ now: new Date("2026-11-08T05:30:00.000Z"), hooks: failing });
    expect(second.executed).toBe(true);
    expect(second.submitted).toBe(0);
    expect(second.unfollowed).toBe(0);
    expect(second.results).toEqual([]);
    expect(calls).toEqual(["12"]);
  });

  it("drops a stored whitelist id before any action", async () => {
    enable();
    const stamp = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO unfollow_candidates
          (account_id, target_user_id, username, tier, first_recorded_at, status, created_at, updated_at)
         VALUES (1, '25073877', NULL, 'non_blue', NULL, 'candidate', ?, ?)`,
      )
      .run(stamp, stamp);
    const calls: string[] = [];
    const result = await submitUnfollowBatch({
      now: new Date("2026-11-08T09:00:00.000Z"),
      hooks: hooks({ "25073877": confirmed }, calls),
    });
    expect(result.submitted).toBe(0);
    expect(result.unfollowed).toBe(0);
    expect(calls).toEqual([]);
    const row = getDb().prepare("SELECT status FROM unfollow_candidates WHERE target_user_id = '25073877'").get() as { status: string };
    expect(row.status).toBe("candidate");
  });

  it("stops before the next target when pause arrives mid-batch", async () => {
    enable();
    importUnfollowCandidates({
      candidates: [
        { targetUserId: "81", tier: "non_blue" },
        { targetUserId: "82", tier: "non_blue" },
      ],
    });
    const calls: string[] = [];
    const result = await submitUnfollowBatch({
      now: new Date("2026-11-08T10:00:00.000Z"),
      hooks: {
        inspect: async () => confirmed,
        unfollow: async (id) => {
          calls.push(id);
          setUnfollowPaused(true, "manual");
        },
      },
    });
    expect(calls).toEqual(["81"]);
    expect(result.submitted).toBe(1);
    expect(result.unfollowed).toBe(1);
    const left = getDb().prepare("SELECT status FROM unfollow_candidates WHERE target_user_id = '82'").get() as { status: string };
    expect(left.status).toBe("candidate");
  });
});

const dummyCredentials = {
  apiKey: "acctoneA",
  apiSecret: SECRET,
  accessToken: "acctoneA-token",
  accessTokenSecret: "acctoneA-token-secret",
};

describe("unfollow network gate", () => {
  it("keeps mock mode off the network even when the account-1 gates are open", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      throw new Error("network");
    };
    try {
      enable();
      importUnfollowCandidates({ candidates: [{ targetUserId: "555", tier: "non_blue" }] });
      const response = await submitBatch(new Request("http://local/api/unfollow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.executed).toBe(false);
      expect(body.reason).toBe("mock_mode");
      expect(body.submitted).toBe(0);
      expect(body.unfollowed).toBe(0);
      await expect(xGet(dummyCredentials, "/2/users", { ids: "555" })).rejects.toThrow(/模拟模式/);
      await expect(xDelete(dummyCredentials, "/2/users/1933586991612080128/following/555")).rejects.toThrow(/模拟模式/);
      expect(calls).toEqual([]);
      const status = await readUnfollow(new Request("http://local/api/unfollow?accountId=1"));
      const state = await status.json();
      expect(state.apiMode).toBe("mock");
      expect(state.enabled).toBe(true);
      expect(state.paused).toBe(false);
      expect(state.identityConfirmed).toBe(true);
      expect(state.batchSize).toBe(14);
      expect(state.inactiveAfterMs).toBe(48 * 60 * 60 * 1000);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("calls the stubbed X endpoints only after live, flag, resume, and identity all pass", async () => {
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      expect(url.startsWith("https://api.x.com/")).toBe(true);
      if (method === "DELETE") return new Response(JSON.stringify({ data: { following: false } }), { status: 200 });
      if (url.includes("/tweets")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({
        data: [{ id: "555", connection_status: ["following"], verified: false, verified_type: "none" }],
      }), { status: 200 });
    };
    try {
      importUnfollowCandidates({ candidates: [{ targetUserId: "555", tier: "non_blue" }] });
      const blocked = await submitBatch(new Request("http://local/api/unfollow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      expect((await blocked.json()).reason).toBe("disabled");
      expect(calls).toEqual([]);

      process.env.XUTIE_ACCOUNT1_UNFOLLOW = "on";
      saveCredentials(1, dummyCredentials);
      updateAccount(1, { username: "other_user", displayName: "Other", userId: "1468479269701820422" });
      setUnfollowPaused(false, "test");
      const wrong = await submitBatch(new Request("http://local/api/unfollow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      expect((await wrong.json()).reason).toBe("identity_unconfirmed");
      expect(calls).toEqual([]);
      setUnfollowPaused(true, "test");
      updateAccount(1, { username: "barrett_tt", displayName: "Barrett", userId: "1933586991612080128" });
      const paused = await submitBatch(new Request("http://local/api/unfollow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      expect((await paused.json()).reason).toBe("paused");
      expect(calls).toEqual([]);

      const resumed = await resumeUnfollow(new Request("http://local/api/unfollow/resume", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      expect(await resumed.json()).toMatchObject({ ok: true, paused: false });
      const done = await submitBatch(new Request("http://local/api/unfollow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      const body = await done.json();
      expect(body.executed).toBe(true);
      expect(body.replay).toBe(false);
      expect(body.submitted).toBe(1);
      expect(body.unfollowed).toBe(1);
      expect(body.results).toEqual([{ targetUserId: "555", tier: "non_blue", result: "success", reason: "confirmed" }]);
      expect(calls.filter((item) => item.startsWith("DELETE"))).toHaveLength(1);
      const replay = await submitBatch(new Request("http://local/api/unfollow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      expect((await replay.json()).replay).toBe(true);
      expect(calls.filter((item) => item.startsWith("DELETE"))).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previous;
    }
  });

  it("does not delete when the live lookup has no connection_status, and does not retry it", async () => {
    const previous = process.env.X_API_MODE;
    process.env.X_API_MODE = "live";
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/tweets")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: "555" }] }), { status: 200 });
    };
    try {
      enable();
      importUnfollowCandidates({ candidates: [{ targetUserId: "555", tier: "non_blue" }] });
      const response = await submitBatch(new Request("http://local/api/unfollow/batches", {
        method: "POST",
        body: JSON.stringify({ accountId: 1 }),
      }));
      const body = await response.json();
      expect(body.submitted).toBe(1);
      expect(body.unfollowed).toBe(0);
      expect(body.results[0]).toMatchObject({ result: "unknown", reason: "following_unconfirmed" });
      expect(calls.some((item) => item.startsWith("DELETE"))).toBe(false);
      const later = await submitUnfollowBatch({
        now: new Date(Date.now() + 60 * 60 * 1000),
        hooks: hooks({ "555": confirmed }, []),
      });
      expect(later.submitted).toBe(0);
      expect(later.unfollowed).toBe(0);
      expect(calls.some((item) => item.startsWith("DELETE"))).toBe(false);
    } finally {
      globalThis.fetch = original;
      process.env.X_API_MODE = previous;
    }
  });
});

describe("unfollow contract routes", () => {
  it("imports the documented candidate schema and pages the audit", async () => {
    enable();
    const imported = await postUnfollow(new Request("http://local/api/unfollow", {
      method: "POST",
      body: JSON.stringify({
        accountId: 1,
        candidates: [
          { targetUserId: "555", username: "someone", tier: "non_blue" },
          { targetUserId: "556", tier: "no_followback_72h", firstRecordedAt: "2026-08-01T00:00:00.000Z" },
          { targetUserId: "557", tier: "inactive_48h" },
          { targetUserId: "558", tier: "no_followback_72h" },
          { targetUserId: "abc", tier: "non_blue" },
          { targetUserId: "25073877", tier: "non_blue" },
          { targetUserId: "559", tier: "inactive_36h" },
        ],
      }),
    }));
    const body = await imported.json();
    expect(body.accepted).toEqual(["555", "556", "557"]);
    expect(body.rejected).toEqual([
      { targetUserId: "558", reason: "first_recorded_required" },
      { targetUserId: "abc", reason: "invalid_id" },
      { targetUserId: "25073877", reason: "whitelist" },
      { targetUserId: "559", reason: "invalid_tier" },
    ]);
    const now = new Date("2026-11-08T04:00:00.000Z");
    const first = await submitUnfollowBatch({
      now,
      hooks: hooks({ "555": confirmed, "556": confirmed, "557": { ...confirmed, lastPostAt: now.toISOString() } }, []),
    });
    expect(first.submitted).toBe(3);
    expect(first.unfollowed).toBe(2);
    importUnfollowCandidates({ candidates: [{ targetUserId: "560", tier: "non_blue" }] });
    await submitUnfollowBatch({
      now: new Date("2026-11-08T04:30:00.000Z"),
      hooks: hooks({ "560": confirmed }, []),
    });
    const page = await readAudit(new Request("http://local/api/unfollow/batches?accountId=1&limit=1"));
    const audit = await page.json();
    expect(audit.limit).toBe(1);
    expect(audit.batches).toHaveLength(1);
    expect(audit.batches[0].slot).toBe("2026-11-08T12:30");
    expect(audit.batches[0].unfollowed).toBe(1);
    expect(audit.nextBefore).toBe("2026-11-08T12:30");
    const older = await readAudit(new Request("http://local/api/unfollow/batches?accountId=1&limit=1&before=2026-11-08T12:30"));
    const olderBody = await older.json();
    expect(olderBody.batches[0].slot).toBe("2026-11-08T12:00");
    expect(olderBody.batches[0].submitted).toBe(3);
    expect(olderBody.batches[0].unfollowed).toBe(2);
    expect(olderBody.nextBefore).toBeNull();
    const account2 = await readAudit(new Request("http://local/api/unfollow/batches?accountId=2"));
    expect(account2.status).toBe(403);
    const resume2 = await resumeUnfollow(new Request("http://local/api/unfollow/resume", {
      method: "POST",
      body: JSON.stringify({ accountId: 2 }),
    }));
    expect(resume2.status).toBe(403);
    const import2 = await postUnfollow(new Request("http://local/api/unfollow", {
      method: "POST",
      body: JSON.stringify({ accountId: 2, candidates: [{ targetUserId: "555", tier: "non_blue" }] }),
    }));
    expect(import2.status).toBe(403);
  });
});

describe("fresh profile parsing", () => {
  it("leaves blue and following unknown when the fields are absent", () => {
    const profile = profileFromLookup({ id: "9" }, { data: [] });
    expect(profile.following).toBeNull();
    expect(profile.blue).toBeNull();
    expect(profile.lastPostKnown).toBe(true);
    const decision = classifyAction({
      tier: "non_blue",
      firstRecordedAt: null,
      fresh: { ...confirmed, ...profile, following: null },
      now: new Date(),
      whitelisted: false,
    });
    expect(decision.result).toBe("unknown");
  });
});
