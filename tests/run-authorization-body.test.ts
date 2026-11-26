import { describe, expect, it } from "vitest";
import {
  authorizeRunBody,
  authorizeRunRequest,
  formatInZone,
  instantToZonedInput,
  RUN_AUTHORIZATION_NOTE_MAX,
  runAuthorizationActions,
  runAuthorizationPhase,
  runControlBody,
  zonedInputToInstant,
} from "@/lib/run-authorization-body";

describe("run authorization bodies and state", () => {
  it("authorizes only account 1, omitting an unspecified or empty expiry and an unedited note", () => {
    const expected = { accountId: 1, action: "authorize" };
    expect(authorizeRunBody()).toEqual(expected);
    expect(authorizeRunBody({})).toEqual(expected);
    expect(authorizeRunBody({ expiresAt: undefined, note: undefined })).toEqual(expected);
    expect(authorizeRunBody({ expiresAt: "" })).toEqual(expected);
    expect(authorizeRunBody({ expiresAt: null })).toEqual(expected);
    expect(authorizeRunBody({ expiresAt: "2026-12-01T00:00:00.000Z" })).toEqual({
      ...expected, expiresAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it.each(["", "  \t\n", null])("sends null to clear note %j", (note) => {
    expect(authorizeRunBody({ note })).toEqual({ accountId: 1, action: "authorize", note: null });
  });

  it("trims an edited note", () => {
    expect(authorizeRunBody({ note: "  operator approved  " })).toEqual({ accountId: 1, action: "authorize", note: "operator approved" });
  });

  it.each(["pause", "resume", "revoke"] as const)("builds only the account and %s control action", (action) => {
    expect(runControlBody(action)).toEqual({ accountId: 1, action });
  });

  it("distinguishes an expired active record from an active authorization", () => {
    expect(runAuthorizationPhase({ status: "active", active: true })).toBe("active");
    expect(runAuthorizationPhase({ status: "active", active: false })).toBe("expired");
  });

  it.each(["paused", "revoked", "none"] as const)("passes the %s phase through regardless of active", (status) => {
    expect(runAuthorizationPhase({ status, active: false })).toBe(status);
    expect(runAuthorizationPhase({ status, active: true })).toBe(status);
  });

  it.each(["active", "paused", "revoked", "none"] as const)("offers only server-accepted controls for %s", (status) => {
    expect(runAuthorizationActions({ status })).toEqual({
      authorize: true, pause: status === "active", resume: status === "paused", revoke: true,
    });
  });
});

describe("authorization wall times", () => {
  it.each([
    { zone: "Asia/Taipei", wall: "2026-07-02T04:34", iso: "2026-07-01T20:34:00.000Z" },
    { zone: "Europe/London", wall: "2026-07-01T21:34", iso: "2026-07-01T20:34:00.000Z" },
    { zone: "Europe/London", wall: "2026-01-01T20:34", iso: "2026-01-01T20:34:00.000Z" },
    { zone: "Asia/Taipei", wall: "2028-02-29T00:00", iso: "2028-02-28T16:00:00.000Z" },
  ])("round-trips $wall in $zone with the zone's seasonal offset", ({ zone, wall, iso }) => {
    expect(zonedInputToInstant(wall, zone)?.toISOString()).toBe(iso);
    expect(instantToZonedInput(iso, zone)).toBe(wall);
    expect(formatInZone(iso, zone)).toBe(wall.replace("T", " "));
  });

  it.each(["Asia/Taipei", "Europe/London"])("drops seconds and fractions in %s", (zone) => {
    const minute = zonedInputToInstant("2026-07-01T12:34", zone)?.toISOString();
    expect(zonedInputToInstant(" 2026-07-01T12:34:56.789 ", zone)?.toISOString()).toBe(minute);
    expect(zonedInputToInstant("2026-07-01T12:34:56", zone)?.toISOString()).toBe(minute);
    expect(instantToZonedInput("2026-07-01T12:34:56.789Z", zone)).toBe(zone === "Asia/Taipei" ? "2026-07-01T20:34" : "2026-07-01T13:34");
    expect(formatInZone("2026-07-01T12:34:56.789Z", zone)).toBe(zone === "Asia/Taipei" ? "2026-07-01 20:34" : "2026-07-01 13:34");
  });

  it.each([
    "", " ", "not a date", "2026-07-01", "2026-07-01 12:00", "2026-7-1T12:00", "2026-07-01T12:00Z",
    "2026-07-01T24:00", "2026-07-01T23:60", "2026-00-01T12:00", "2026-13-01T12:00",
    "2026-01-00T12:00", "2026-02-29T12:00", "2026-02-30T12:00", "2026-04-31T12:00", "2026-01-32T12:00",
  ])("rejects malformed or impossible wall time %j", (value) => {
    expect(zonedInputToInstant(value, "Asia/Taipei")).toBeNull();
    expect(zonedInputToInstant(value, "Europe/London")).toBeNull();
  });

  it.each([null, "", "invalid", "2026-13-01T00:00:00Z"])("leaves invalid instant %j empty", (iso) => {
    expect(instantToZonedInput(iso, "Asia/Taipei")).toBe("");
    expect(formatInZone(iso, "Asia/Taipei")).toBe("");
  });

  it("rejects an unknown zone in conversions and display", () => {
    expect(zonedInputToInstant("2026-07-01T12:00", "Mars/Olympus")).toBeNull();
    expect(instantToZonedInput("2026-07-01T12:00:00.000Z", "Mars/Olympus")).toBe("");
    expect(formatInZone("2026-07-01T12:00:00.000Z", "Mars/Olympus")).toBe("");
  });
});

describe("authorize form request", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");
  const input = () => ({ expiry: "", zone: "Asia/Taipei", note: "stored note", noteEdited: false, now });

  it.each(["", "  \t"])("authorizes without an expiresAt for blank expiry %j, even before the zone loads", (expiry) => {
    expect(authorizeRunRequest({ ...input(), expiry, zone: null })).toEqual({
      body: { accountId: 1, action: "authorize" }, expiresAt: null, issues: [],
    });
  });

  it.each([
    { zone: "Asia/Taipei", expiry: "2026-07-02T09:00", iso: "2026-07-02T01:00:00.000Z" },
    { zone: "Europe/London", expiry: "2026-07-02T09:00", iso: "2026-07-02T08:00:00.000Z" },
  ])("sends a future $zone expiry as an ISO instant", ({ zone, expiry, iso }) => {
    expect(authorizeRunRequest({ ...input(), zone, expiry })).toEqual({
      body: { accountId: 1, action: "authorize", expiresAt: iso }, expiresAt: iso, issues: [],
    });
  });

  it.each([
    { expiry: "2026-07-01T07:59", zone: "Asia/Taipei" },
    { expiry: "2026-07-01T08:00", zone: "Asia/Taipei" },
    { expiry: "2026-07-02T09:00", zone: null },
    { expiry: "not a date", zone: "Asia/Taipei" },
    { expiry: "2026-02-30T09:00", zone: "Asia/Taipei" },
    { expiry: "2026-07-02T09:00", zone: "Mars/Olympus" },
  ])("refuses expiry $expiry in $zone with no request body", ({ expiry, zone }) => {
    const result = authorizeRunRequest({ ...input(), expiry, zone });
    expect(result.body).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.issues).toEqual([{ field: "expiresAt", zh: expect.any(String), en: expect.any(String) }]);
  });

  it("sends the note only when edited, including an explicit clear", () => {
    expect(authorizeRunRequest(input()).body).not.toHaveProperty("note");
    expect(authorizeRunRequest({ ...input(), note: "  renewed  ", noteEdited: true }).body)
      .toEqual({ accountId: 1, action: "authorize", note: "renewed" });
    expect(authorizeRunRequest({ ...input(), note: "  ", noteEdited: true }).body)
      .toEqual({ accountId: 1, action: "authorize", note: null });
  });

  it("enforces the trimmed note limit only when edited", () => {
    const atLimit = "n".repeat(RUN_AUTHORIZATION_NOTE_MAX);
    expect(authorizeRunRequest({ ...input(), note: ` ${atLimit} `, noteEdited: true })).toEqual({
      body: { accountId: 1, action: "authorize", note: atLimit }, expiresAt: null, issues: [],
    });
    const tooLong = "n".repeat(RUN_AUTHORIZATION_NOTE_MAX + 1);
    expect(authorizeRunRequest({ ...input(), note: tooLong, noteEdited: true })).toEqual({
      body: null, expiresAt: null, issues: [{ field: "note", zh: expect.any(String), en: expect.any(String) }],
    });
    expect(authorizeRunRequest({ ...input(), note: tooLong })).toEqual({
      body: { accountId: 1, action: "authorize" }, expiresAt: null, issues: [],
    });
  });

  it("reports expiry and note issues together and sends neither", () => {
    const result = authorizeRunRequest({ ...input(), expiry: "invalid", note: "n".repeat(RUN_AUTHORIZATION_NOTE_MAX + 1), noteEdited: true });
    expect(result).toMatchObject({ body: null, expiresAt: null });
    expect(result.issues.map((issue) => issue.field)).toEqual(["expiresAt", "note"]);
  });
});
