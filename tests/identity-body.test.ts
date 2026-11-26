import { describe, expect, it } from "vitest";
import {
  credentialsTestBody,
  DISPLAY_NAME_MAX,
  emptyManualIdentity,
  identityExecutionAllowed,
  manualIdentityRequest,
} from "@/lib/identity-body";

describe("identity test bodies", () => {
  it.each([1, 2] as const)("requests an ordinary account %s retest without reverify", (accountId) => {
    expect(credentialsTestBody(accountId)).toEqual({ accountId });
    expect(credentialsTestBody(accountId, {})).toEqual({ accountId });
    expect(credentialsTestBody(accountId, { reverify: undefined })).toEqual({ accountId });
    expect(credentialsTestBody(accountId, { reverify: false })).toEqual({ accountId });
    expect(credentialsTestBody(accountId, { reverify: true })).toEqual({ accountId, reverify: true });
  });

  it("creates a fresh empty manual identity each time", () => {
    const first = emptyManualIdentity();
    expect(first).toEqual({ userId: "", username: "", displayName: "" });
    const second = emptyManualIdentity();
    expect(second).not.toBe(first);
    first.username = "edited";
    expect(second).toEqual({ userId: "", username: "", displayName: "" });
  });
});

describe("manual identity request", () => {
  const input = () => ({ userId: "1234567890123456789", username: "operator_1", displayName: "" });

  it.each([1, 2] as const)("sends only the provided account %s with a string user id", (accountId) => {
    expect(manualIdentityRequest(accountId, input())).toEqual({
      body: { accountId, userId: "1234567890123456789", username: "operator_1" }, issues: [],
    });
  });

  it.each([
    { userId: "0", username: "a" },
    { userId: "9".repeat(32), username: "A0_".repeat(5) },
    { userId: "000123", username: "_" },
  ])("accepts boundary identity $userId / $username without converting the id to a number", ({ userId, username }) => {
    expect(manualIdentityRequest(1, { userId, username, displayName: "" })).toEqual({
      body: { accountId: 1, userId, username }, issues: [],
    });
  });

  it("trims fields, removes a leading @, and includes a non-blank display name", () => {
    const draft = { userId: " 123 ", username: " @Operator_2 ", displayName: "  操作者  " };
    expect(manualIdentityRequest(2, draft)).toEqual({
      body: { accountId: 2, userId: "123", username: "Operator_2", displayName: "操作者" }, issues: [],
    });
    expect(draft).toEqual({ userId: " 123 ", username: " @Operator_2 ", displayName: "  操作者  " });
  });

  it.each(["", "  \t\n"])("omits blank display name %j so the server can use the username", (displayName) => {
    expect(manualIdentityRequest(1, { ...input(), displayName }).body).toEqual({
      accountId: 1, userId: "1234567890123456789", username: "operator_1",
    });
  });

  it.each(["", " ", "abc", "12a", "1.5", "-1", "+1", "1e3", "12 34", "9".repeat(33)])("rejects invalid user id %j with no body", (userId) => {
    const result = manualIdentityRequest(1, { ...input(), userId });
    expect(result.body).toBeNull();
    expect(result.issues).toEqual([{ field: "userId", zh: expect.any(String), en: expect.any(String) }]);
  });

  it.each(["", " ", "@", "@@operator", "a".repeat(16), "two words", "with-dash", "with.dot", "中文", "name!"])("rejects invalid username %j with no body", (username) => {
    const result = manualIdentityRequest(2, { ...input(), username });
    expect(result.body).toBeNull();
    expect(result.issues).toEqual([{ field: "username", zh: expect.any(String), en: expect.any(String) }]);
  });

  it("accepts a trimmed display name at the limit and rejects one character more", () => {
    const displayName = "名".repeat(DISPLAY_NAME_MAX);
    expect(manualIdentityRequest(1, { ...input(), displayName: ` ${displayName} ` })).toEqual({
      body: { accountId: 1, userId: "1234567890123456789", username: "operator_1", displayName }, issues: [],
    });
    expect(manualIdentityRequest(1, { ...input(), displayName: `${displayName}名` })).toEqual({
      body: null, issues: [{ field: "displayName", zh: expect.any(String), en: expect.any(String) }],
    });
  });

  it("collects all invalid fields without returning a partial identity", () => {
    const result = manualIdentityRequest(2, { userId: "not numeric", username: "bad-handle", displayName: "n".repeat(DISPLAY_NAME_MAX + 1) });
    expect(result.body).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toEqual(["userId", "username", "displayName"]);
  });
});

describe("identity execution gate", () => {
  it.each(["confirmed", "missing", "conflict", "reserved"] as const)("allows execution only for confirmed, including state %s", (state) => {
    expect(identityExecutionAllowed(state)).toBe(state === "confirmed");
  });
});
