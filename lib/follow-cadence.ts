import type { AccountId } from "@/lib/account";
import { londonClock, londonFollowSlot, zonedClock } from "@/lib/london";
import { FOLLOW_BATCH_LIMIT } from "@/lib/unfollow-policy";

/** Account 1 follow clock. No daylight-saving shift; the zone is still read from Intl. */
export const ACCOUNT1_FOLLOW_ZONE = "Asia/Taipei";

/** First work window of each Taipei day starts at 00:00. The window closes at 05:00. */
export const ACCOUNT1_ANCHOR_MINUTES = 0;

/** Exclusive end of account 1's follow-back window. A round open at 04:57 closes at 05:00. */
export const ACCOUNT1_FOLLOW_WINDOW_END_MINUTES = 5 * 60;

export const ACCOUNT1_WORK_MINUTES = 15;

export const ACCOUNT1_REST_MINUTES = 18;

/** 15 minutes of work, then 18 of rest. Re-anchors at 00:00 each Taipei day. */
export const ACCOUNT1_CYCLE_MINUTES = ACCOUNT1_WORK_MINUTES + ACCOUNT1_REST_MINUTES;

export const ACCOUNT1_FOLLOW_BATCH_LIMIT = 13;

/** Distinct from historical London keys such as `2026-11-11T03:00`. */
export const ACCOUNT1_SLOT_PREFIX = "taipei:";

const DAY_MINUTES = 24 * 60;

const LONDON_AUDIT_SLOT = /^\d{4}-\d{2}-\d{2}T\d{2}:(00|15|30|45)$/;
const TAIPEI_SLOT = /^taipei:(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function followBatchLimit(accountId: AccountId): number {
  return accountId === 1 ? ACCOUNT1_FOLLOW_BATCH_LIMIT : FOLLOW_BATCH_LIMIT;
}

/** Day key stored in `follow_success.london_day` and used for the daily cap. */
export function followCapDay(accountId: AccountId, now: Date): string {
  if (accountId === 1) return zonedClock(now, ACCOUNT1_FOLLOW_ZONE).day;
  return londonClock(now).day;
}

/**
 * Work-window start for this account, or null during rest.
 * Account 2 is the London 00:00 / 15+15 clock. Account 1 is Taipei, anchored at 00:00.
 */
export function followSlot(accountId: AccountId, now: Date): string | null {
  if (accountId === 2) return londonFollowSlot(now);
  return taipeiFollowSlot(now);
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

/** Audit cursor: account 2 keeps quarter-hour London strings; account 1 only accepts its own work starts. */
export function isFollowAuditCursor(accountId: AccountId, slot: string): boolean {
  if (accountId === 1) return isAccount1FollowSlot(slot);
  return LONDON_AUDIT_SLOT.test(slot);
}

export function isAccount1FollowSlot(slot: string): boolean {
  const match = TAIPEI_SLOT.exec(slot);
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
  if (minutes < ACCOUNT1_ANCHOR_MINUTES || minutes >= ACCOUNT1_FOLLOW_WINDOW_END_MINUTES) return false;
  let since = minutes - ACCOUNT1_ANCHOR_MINUTES;
  if (since < 0) since += DAY_MINUTES;
  return since % ACCOUNT1_CYCLE_MINUTES === 0;
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
