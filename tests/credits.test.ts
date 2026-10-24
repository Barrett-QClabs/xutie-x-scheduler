import { describe, expect, it } from "vitest";
import { updateAccount } from "@/lib/db";
import { getPublicState, importTweets, saveCredentials } from "@/lib/service";
import { tick } from "@/lib/scheduler";
import { classifyStatus, XApiError, type XClient } from "@/lib/x-client";

const user = { id: "42", username: "demo", name: "Demo" };

function connect() {
  saveCredentials({ apiKey: "abc12345", apiSecret: "s3cret-value", accessToken: "tok-value", accessTokenSecret: "toksecret" });
  updateAccount({ username: user.username, displayName: user.name, userId: user.id });
}

describe("X reads only when due", () => {
  it("does not read the timeline while the next post is still in the future", async () => {
    connect();
    const now = new Date("2026-10-25T00:00:00.000Z");
    importTweets({ source: "一\n二", format: "text", startAt: new Date(now.getTime() + 5 * 60_000).toISOString(), intervalMinutes: 30 });
    let reads = 0;
    const client: XClient = {
      verify: async () => user,
      postTweet: async () => ({ id: "x" }),
      latestTweet: async () => {
        reads += 1;
        return null;
      },
    };
    for (let s = 0; s < 50; s += 1) {
      await tick({ now: new Date(now.getTime() + s * 5_000), client });
    }
    expect(reads).toBe(0);
    expect(getPublicState().counts.posted).toBe(0);
  });
});

describe("402 credits depleted", () => {
  it("classifies 402 as credits", () => {
    expect(classifyStatus(402, "credits depleted", {})).toBe("credits");
  });

  it("pauses ~10 min instead of failing the post", async () => {
    connect();
    const now = new Date("2026-10-25T01:00:00.000Z");
    importTweets({ source: "一\n二", format: "text", startAt: new Date(now.getTime() - 1000).toISOString(), intervalMinutes: 30 });
    const result = await tick({
      now,
      client: {
        verify: async () => user,
        postTweet: async () => {
          throw new XApiError("credits depleted", "credits", 402);
        },
        latestTweet: async () => null,
      },
    });
    expect(result).toMatchObject({ action: "rate_limited" });
    const until = new Date((result as { until: string }).until).getTime();
    expect(until - now.getTime()).toBe(10 * 60_000);
    const state = getPublicState();
    expect(state.tweets.filter((t) => t.status === "failed")).toHaveLength(0);
    expect(state.tweets.filter((t) => t.status === "pending")).toHaveLength(2);
  });
});
