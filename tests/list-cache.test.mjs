import { describe, expect, it } from "vitest";
import { USER_LOOKUP_BATCH, creditsBackoffMs } from "../automation/unfollow.mjs";

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
});
