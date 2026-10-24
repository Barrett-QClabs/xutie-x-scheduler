import { describe, expect, it } from "vitest";
import { USER_LOOKUP_BATCH, creditsBackoffMs, FULL_REFRESH_MS } from "../automation/unfollow.mjs";

describe("shared list cache helpers", () => {
  it("batches user lookups by 14", () => {
    expect(USER_LOOKUP_BATCH).toBe(14);
  });

  it("credits backoff is 5–10 minutes", () => {
    for (let i = 0; i < 20; i += 1) {
      const ms = creditsBackoffMs();
      expect(ms).toBeGreaterThanOrEqual(5 * 60_000);
      expect(ms).toBeLessThan(10 * 60_000);
    }
  });

  it("full list refresh is at most once per 7 days", () => {
    expect(FULL_REFRESH_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
