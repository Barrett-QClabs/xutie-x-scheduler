import { afterEach, describe, expect, it } from "vitest";
import { POST as submitBatch } from "@/app/api/unfollow/batches/route";
import { POST as pauseUnfollow } from "@/app/api/unfollow/pause/route";
import { getQueueSettings, updateAccount } from "@/lib/db";
import { profileFromLookup } from "@/lib/unfollow-live";
import { UNFOLLOW_WHITELIST } from "@/lib/unfollow-policy";
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
        { targetUserId: "555", tier: "inactive_36h" },
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
        { targetUserId: "2000", tier: "inactive_36h" as const },
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

  it("does not act when following, blue, or the last post is unknown", async () => {
    enable();
    importUnfollowCandidates({
      candidates: [
        { targetUserId: "11", tier: "non_blue" },
        { targetUserId: "12", tier: "non_blue" },
        { targetUserId: "13", tier: "inactive_36h" },
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
