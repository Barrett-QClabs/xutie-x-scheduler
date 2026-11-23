import type { AccountId } from "@/lib/account";
import { londonClock, zonedClock } from "@/lib/london";
import { FOLLOW_BATCH_LIMIT, FOLLOW_DAILY_CAP } from "@/lib/unfollow-policy";

/** Account 1 follow clock. No daylight-saving shift; the zone is still read from Intl. */
export const ACCOUNT1_FOLLOW_ZONE = "Asia/Taipei";

/** First work window of each Taipei day starts at 00:00. The window closes at 05:00. */
export const ACCOUNT1_ANCHOR_MINUTES = 0;

/** Quiet hours start. Account 1 does not follow from 05:00 inclusive until 09:00. */
export const ACCOUNT1_FOLLOW_WINDOW_END_MINUTES = 5 * 60;

/** Work resumes at 09:00 Taipei. The 15/18 cycle is anchored here, including across midnight until 05:00. */
export const ACCOUNT1_OPEN_START_MINUTES = 9 * 60;

/** Account 1 combined follow + follow-back cap for one Taipei civil day. Account 2 stays on FOLLOW_DAILY_CAP. */
export const ACCOUNT1_FOLLOW_DAILY_CAP = 350;

/**
 * History before 2026-11-23 14:27 Asia/Taipei is not backfilled.
 * Confirmed unfollow successes already stored are kept; later successes are recorded as they happen.
 */
export const ACCOUNT1_UNFOLLOW_BASELINE_AT = "2026-11-23T06:27:00.000Z";

export const ACCOUNT1_WORK_MINUTES = 15;

export const ACCOUNT1_REST_MINUTES = 18;

/** 15 minutes of work, then 18 of rest. Re-anchors at 00:00 each Taipei day. */
export const ACCOUNT1_CYCLE_MINUTES = ACCOUNT1_WORK_MINUTES + ACCOUNT1_REST_MINUTES;

export const ACCOUNT1_FOLLOW_BATCH_LIMIT = 13;

/** Evening kind=new window. 15 minutes of work, then 20 of rest, anchored at 18:00. */
export const ACCOUNT1_NEW_ANCHOR_MINUTES = 18 * 60;
export const ACCOUNT1_NEW_WORK_MINUTES = 15;
export const ACCOUNT1_NEW_REST_MINUTES = 20;
export const ACCOUNT1_NEW_CYCLE_MINUTES = ACCOUNT1_NEW_WORK_MINUTES + ACCOUNT1_NEW_REST_MINUTES;
export const ACCOUNT1_NEW_BATCH_LIMIT = 9;

/** Distinct from historical London keys such as `2026-11-11T03:00`. */
export const ACCOUNT1_SLOT_PREFIX = "taipei:";
/** Evening kind=new keys, distinct from follow-back slots. */
export const ACCOUNT1_NEW_SLOT_PREFIX = "taipei-new:";

const DAY_MINUTES = 24 * 60;

const TAIPEI_SLOT = /^taipei:(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function taipeiMidnightUtc(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date, 0, 0, 0) - TAIPEI_OFFSET_MS;
}

/**
 * Account 1 follow-back checked before 05:00 is usable until that 05:00.
 * A check at 23:00 is usable until 05:00 the next Taipei morning, then stops.
 * This does not extend evidence expiry.
 */
export function account1FollowbackDeadline(checkedAt: string): number | null {
  const checked = Date.parse(checkedAt);
  if (Number.isNaN(checked)) return null;
  const clock = zonedClock(new Date(checked), ACCOUNT1_FOLLOW_ZONE);
  const sameMorning = taipeiMidnightUtc(clock.day) + ACCOUNT1_FOLLOW_WINDOW_END_MINUTES * 60 * 1000;
  if (checked < sameMorning) return sameMorning;
  const nextMidnight = sameMorning + (24 * 60 - ACCOUNT1_FOLLOW_WINDOW_END_MINUTES) * 60 * 1000;
  const nextDay = zonedClock(new Date(nextMidnight), ACCOUNT1_FOLLOW_ZONE).day;
  return taipeiMidnightUtc(nextDay) + ACCOUNT1_FOLLOW_WINDOW_END_MINUTES * 60 * 1000;
}

/** The morning hold no longer gates execution. Inventory stays until it is used or blocked. */
export function account1FollowbackHeld(checkedAt: string, now: Date): boolean {
  void checkedAt;
  void now;
  return false;
}

/** A 23:00 new-follow check stays usable through 24:00 the next Taipei day. */
export function account1NewFollowDeadline(checkedAt: string): number | null {
  const checked = Date.parse(checkedAt);
  if (Number.isNaN(checked)) return null;
  const clock = zonedClock(new Date(checked), ACCOUNT1_FOLLOW_ZONE);
  const midnight = taipeiMidnightUtc(clock.day);
  const days = clock.minutes >= ACCOUNT1_NEW_ANCHOR_MINUTES ? 2 : 1;
  return midnight + days * 24 * 60 * 60 * 1000;
}

/** The evening hold no longer gates execution. Inventory stays until it is used or blocked. */
export function account1NewFollowHeld(checkedAt: string, now: Date): boolean {
  void checkedAt;
  void now;
  return false;
}

/**
 * Account 1 inventory does not expire by calendar day.
 * A real checked time stays in the permanent pool; a missing or future stamp does not.
 */
export function account1PoolInUse(kind: "followback" | "new", checkedAt: string, now: Date): boolean {
  void kind;
  const checked = Date.parse(checkedAt);
  if (Number.isNaN(checked)) return false;
  return checked <= now.getTime() + 5 * 60 * 1000;
}

export function account1QuietHours(minutes: number): boolean {
  return minutes >= ACCOUNT1_FOLLOW_WINDOW_END_MINUTES && minutes < ACCOUNT1_OPEN_START_MINUTES;
}

/** Open during the 20 hours outside 05:00–09:00. Kind no longer selects a separate window. */
export function account1FollowPhase(now: Date): "unified" | null {
  const minutes = zonedClock(now, ACCOUNT1_FOLLOW_ZONE).minutes;
  if (account1QuietHours(minutes)) return null;
  return "unified";
}

export function followDailyCap(accountId: AccountId): number {
  return accountId === 1 ? ACCOUNT1_FOLLOW_DAILY_CAP : FOLLOW_DAILY_CAP;
}

export function followBatchLimit(accountId: AccountId, now?: Date): number {
  void now;
  return accountId === 1 ? ACCOUNT1_FOLLOW_BATCH_LIMIT : FOLLOW_BATCH_LIMIT;
}

/** Day key stored in `follow_success.london_day` and used for the daily cap. */
export function followCapDay(accountId: AccountId, now: Date): string {
  if (accountId === 1) return zonedClock(now, ACCOUNT1_FOLLOW_ZONE).day;
  return londonClock(now).day;
}

/** Account 2 keeps 15 minutes of work and 15 of rest, 10 per round, anchored at 00:00 Taipei. */
export const ACCOUNT2_FOLLOW_CYCLE_MINUTES = 30;
export const ACCOUNT2_FOLLOW_WORK_MINUTES = 15;

/**
 * Work-window start for this account, or null during rest.
 * Account 1 works 15 minutes and rests 18, anchored at 09:00, and is closed 05:00–09:00.
 * The cycle continues from 09:00 through midnight until 05:00. Account 2 is unchanged.
 */
export function followSlot(accountId: AccountId, now: Date): string | null {
  if (accountId === 2) return account2FollowSlot(now);
  return account1UnifiedSlot(now);
}

export function account1UnifiedSlot(now: Date): string | null {
  const clock = zonedClock(now, ACCOUNT1_FOLLOW_ZONE);
  if (account1QuietHours(clock.minutes)) return null;
  const since = clock.minutes >= ACCOUNT1_OPEN_START_MINUTES
    ? clock.minutes - ACCOUNT1_OPEN_START_MINUTES
    : clock.minutes + DAY_MINUTES - ACCOUNT1_OPEN_START_MINUTES;
  const offset = since % ACCOUNT1_CYCLE_MINUTES;
  if (offset >= ACCOUNT1_WORK_MINUTES) return null;
  let start = clock.minutes - offset;
  let day = clock.day;
  if (start < 0) {
    start += DAY_MINUTES;
    day = previousCivilDay(day);
  }
  if (account1QuietHours(start)) return null;
  return `${ACCOUNT1_SLOT_PREFIX}${day}T${hhmm(start)}`;
}

export function taipeiNewFollowSlot(now: Date): string | null {
  const clock = zonedClock(now, ACCOUNT1_FOLLOW_ZONE);
  if (clock.minutes < ACCOUNT1_NEW_ANCHOR_MINUTES) return null;
  const since = clock.minutes - ACCOUNT1_NEW_ANCHOR_MINUTES;
  const offset = since % ACCOUNT1_NEW_CYCLE_MINUTES;
  if (offset >= ACCOUNT1_NEW_WORK_MINUTES) return null;
  const start = clock.minutes - offset;
  if (start < ACCOUNT1_NEW_ANCHOR_MINUTES) return null;
  return `${ACCOUNT1_NEW_SLOT_PREFIX}${clock.day}T${hhmm(start)}`;
}

export function account2FollowSlot(now: Date): string | null {
  const clock = zonedClock(now, ACCOUNT1_FOLLOW_ZONE);
  const offset = clock.minutes % ACCOUNT2_FOLLOW_CYCLE_MINUTES;
  if (offset >= ACCOUNT2_FOLLOW_WORK_MINUTES) return null;
  return `${ACCOUNT1_SLOT_PREFIX}${clock.day}T${hhmm(clock.minutes - offset)}`;
}

export function taipeiFollowSlot(now: Date): string | null {
  const clock = zonedClock(now, ACCOUNT1_FOLLOW_ZONE);
  if (clock.minutes < ACCOUNT1_ANCHOR_MINUTES || clock.minutes >= ACCOUNT1_FOLLOW_WINDOW_END_MINUTES) return null;
  const sinceAnchor = clock.minutes >= ACCOUNT1_ANCHOR_MINUTES
    ? clock.minutes - ACCOUNT1_ANCHOR_MINUTES
    : clock.minutes + DAY_MINUTES - ACCOUNT1_ANCHOR_MINUTES;
  const offset = sinceAnchor % ACCOUNT1_CYCLE_MINUTES;
  if (offset >= ACCOUNT1_WORK_MINUTES) return null;
  let start = clock.minutes - offset;
  let day = clock.day;
  if (start < 0) {
    start += DAY_MINUTES;
    day = previousCivilDay(day);
  }
  return `${ACCOUNT1_SLOT_PREFIX}${day}T${hhmm(start)}`;
}

/** Audit cursor: account 1 still accepts completed historical keys plus the unified grid. */
export function isFollowAuditCursor(accountId: AccountId, slot: string): boolean {
  if (accountId === 1) return isAccount1FollowSlot(slot) || isAccount1NewFollowSlot(slot);
  return isAccount2FollowSlot(slot);
}

export function isAccount1NewFollowSlot(slot: string): boolean {
  const match = /^taipei-new:(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(slot);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return false;
  const probe = new Date(Date.UTC(year, month - 1, date));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) return false;
  const minutes = hour * 60 + minute;
  if (minutes < ACCOUNT1_NEW_ANCHOR_MINUTES) return false;
  return (minutes - ACCOUNT1_NEW_ANCHOR_MINUTES) % ACCOUNT1_NEW_CYCLE_MINUTES === 0;
}

export function isAccount2FollowSlot(slot: string): boolean {
  const match = TAIPEI_SLOT.exec(slot);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || (minute !== 0 && minute !== 30)) return false;
  const probe = new Date(Date.UTC(year, month - 1, date));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === date;
}

export function isAccount1FollowSlot(slot: string): boolean {
  return isAccount1UnifiedSlot(slot) || isLegacyAccount1FollowbackSlot(slot);
}

export function isAccount1UnifiedSlot(slot: string): boolean {
  const minutes = taipeiSlotMinutes(slot);
  if (minutes === null || account1QuietHours(minutes)) return false;
  if (minutes >= ACCOUNT1_OPEN_START_MINUTES) {
    return (minutes - ACCOUNT1_OPEN_START_MINUTES) % ACCOUNT1_CYCLE_MINUTES === 0;
  }
  return (minutes + DAY_MINUTES - ACCOUNT1_OPEN_START_MINUTES) % ACCOUNT1_CYCLE_MINUTES === 0;
}

/** Completed 00:00–05:00 keys stay valid cursors. They are not generated again. */
function isLegacyAccount1FollowbackSlot(slot: string): boolean {
  const minutes = taipeiSlotMinutes(slot);
  if (minutes === null || minutes >= ACCOUNT1_FOLLOW_WINDOW_END_MINUTES) return false;
  return minutes % ACCOUNT1_CYCLE_MINUTES === 0;
}

function taipeiSlotMinutes(slot: string): number | null {
  const match = TAIPEI_SLOT.exec(slot);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const probe = new Date(Date.UTC(year, month - 1, date));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) return null;
  return hour * 60 + minute;
}

function hhmm(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function previousCivilDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}
