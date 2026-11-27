/**
 * Client-safe request bodies for `/api/follow/authorization`: account 1's persistent run
 * authorization for kind=new follows. It is not the one-day `POST /api/follow/new-approval`.
 * Server rules live in `lib/follow-new-admission.ts`; only `import type` reaches that module.
 */
import type { RunAuthorizationView } from "@/lib/follow-new-admission";
import { zonedClock } from "@/lib/zoned-clock";

/** Same ceiling the server applies to `note`. */
export const RUN_AUTHORIZATION_NOTE_MAX = 200;

export type RunAuthorizationAction = "authorize" | "pause" | "resume" | "revoke";

export type AuthorizeRunBody = { accountId: 1; action: "authorize"; expiresAt?: string; note?: string | null };

export type RunControlBody = { accountId: 1; action: "pause" | "resume" | "revoke" };

/**
 * `authorize` body. `expiresAt` is left out for "no expiry". `note` is left out when the operator did
 * not edit it, so the server keeps the stored note; an emptied note is sent as null to clear it.
 */
export function authorizeRunBody(input: { expiresAt?: string | null; note?: string | null } = {}): AuthorizeRunBody {
  const body: AuthorizeRunBody = { accountId: 1, action: "authorize" };
  if (typeof input.expiresAt === "string" && input.expiresAt.length > 0) body.expiresAt = input.expiresAt;
  if (input.note !== undefined) body.note = input.note === null ? null : input.note.trim() || null;
  return body;
}

/** One-click pause, resume, or revoke. Nothing else goes in the body. */
export function runControlBody(action: "pause" | "resume" | "revoke"): RunControlBody {
  return { accountId: 1, action };
}

export type RunAuthorizationPhase = "active" | "expired" | "paused" | "revoked" | "none";

/** `active` with a passed `expiresAt` is reported as `expired`: it no longer authorizes anything. */
export function runAuthorizationPhase(view: Pick<RunAuthorizationView, "status" | "active">): RunAuthorizationPhase {
  if (view.status === "active") return view.active ? "active" : "expired";
  return view.status;
}

/**
 * Which actions the server accepts in this state. Revoke always works (it also stops an older
 * one-day approval). Pause needs an active record; resume needs a paused one. Authorize always works.
 */
export function runAuthorizationActions(view: Pick<RunAuthorizationView, "status">): Record<RunAuthorizationAction, boolean> {
  return {
    authorize: true,
    pause: view.status === "active",
    resume: view.status === "paused",
    revoke: true,
  };
}

function offsetMs(at: number, zone: string): number {
  const clock = zonedClock(new Date(at), zone);
  const [year, month, date] = clock.day.split("-").map(Number);
  return Date.UTC(year, month - 1, date, clock.hour, clock.minute) - Math.floor(at / 60_000) * 60_000;
}

/**
 * Instant for a `YYYY-MM-DDTHH:MM` wall time (the `datetime-local` format) read in `zone`, or null
 * when the text or the zone is invalid. Seconds, if present, are dropped.
 */
export function zonedInputToInstant(value: string, zone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/.exec(value.trim());
  if (!match) return null;
  const [year, month, date, hour, minute] = match.slice(1, 6).map(Number);
  if (month < 1 || month > 12 || date < 1 || hour > 23 || minute > 59) return null;
  const probe = new Date(Date.UTC(year, month - 1, date));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) return null;
  const target = Date.UTC(year, month - 1, date, hour, minute);
  try {
    let guess = target - offsetMs(target, zone);
    for (let step = 0; step < 4; step += 1) {
      const next = target - offsetMs(guess, zone);
      if (next === guess) break;
      guess = next;
    }
    return new Date(guess);
  } catch {
    return null;
  }
}

/** `YYYY-MM-DDTHH:MM` wall time of `iso` in `zone`, for prefilling a `datetime-local` input. */
export function instantToZonedInput(iso: string | null, zone: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "";
  try {
    const clock = zonedClock(new Date(iso), zone);
    return `${clock.day}T${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

/** `YYYY-MM-DD HH:MM` in `zone`, for display. */
export function formatInZone(iso: string | null, zone: string): string {
  const value = instantToZonedInput(iso, zone);
  return value ? value.replace("T", " ") : "";
}

export type AuthorizationIssue = { field: "expiresAt" | "note"; zh: string; en: string };

/**
 * Validates the authorize form and builds its body. `expiry` is a wall time in `zone` (blank for no
 * expiry). The note is sent only when the operator edited it.
 */
export function authorizeRunRequest(input: {
  expiry: string;
  zone: string | null;
  note: string;
  noteEdited: boolean;
  now: Date;
}): { body: AuthorizeRunBody | null; expiresAt: string | null; issues: AuthorizationIssue[] } {
  const issues: AuthorizationIssue[] = [];
  let expiresAt: string | null = null;
  if (input.expiry.trim()) {
    if (!input.zone) {
      issues.push({ field: "expiresAt", zh: "还没读到排程时区，暂时不能设到期时间。可以先不设到期。", en: "The schedule time zone has not loaded yet, so an expiry cannot be read. Leave it blank for now." });
    } else {
      const instant = zonedInputToInstant(input.expiry, input.zone);
      if (!instant) {
        issues.push({ field: "expiresAt", zh: "到期时间无法识别。请用日期时间选择器，或留空表示不设到期。", en: "The expiry is not a valid date and time. Use the picker, or leave it blank for no expiry." });
      } else if (instant.getTime() <= input.now.getTime()) {
        issues.push({ field: "expiresAt", zh: "到期时间必须晚于现在。", en: "The expiry must be later than now." });
      } else expiresAt = instant.toISOString();
    }
  }
  if (input.noteEdited && input.note.trim().length > RUN_AUTHORIZATION_NOTE_MAX) {
    issues.push({
      field: "note",
      zh: `备注不能超过 ${RUN_AUTHORIZATION_NOTE_MAX} 个字符。`,
      en: `The note cannot be longer than ${RUN_AUTHORIZATION_NOTE_MAX} characters.`,
    });
  }
  if (issues.length > 0) return { body: null, expiresAt: null, issues };
  return {
    body: authorizeRunBody({ expiresAt, note: input.noteEdited ? input.note : undefined }),
    expiresAt,
    issues,
  };
}
