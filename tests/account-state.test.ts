import { describe, expect, it } from "vitest";
import { shouldApplyAccountState } from "@/lib/account-state";

describe("account state responses", () => {
  it("drops a late response for the slot the user has left", () => {
    expect(shouldApplyAccountState({ requestedId: 1, selectedId: 2, responseId: 1 })).toBe(false);
    expect(shouldApplyAccountState({ requestedId: 2, selectedId: 2, responseId: 1 })).toBe(false);
  });

  it("applies a response only to the slot that is still selected", () => {
    expect(shouldApplyAccountState({ requestedId: 2, selectedId: 2, responseId: 2 })).toBe(true);
    expect(shouldApplyAccountState({ requestedId: 1, selectedId: 1, responseId: 1 })).toBe(true);
  });
});
