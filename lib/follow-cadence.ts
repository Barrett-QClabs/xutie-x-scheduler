import type { AccountId } from "@/lib/account";
import { londonClock, zonedClock } from "@/lib/london";
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

export function account1FollowPhase(now: Date): "followback" | "new" | null {
  const minutes = zonedClock(now, ACCOUNT1_FOLLOW_ZONE).minutes;
  if (minutes < ACCOUNT1_FOLLOW_WINDOW_END_MINUTES) return "followback";
  if (minutes >= ACCOUNT1_NEW_ANCHOR_MINUTES) return "new";
  return null;
}

export function followBatchLimit(accountId: AccountId, now?: Date): number {
  if (accountId === 1 && now && account1FollowPhase(now) === "new") return ACCOUNT1_NEW_BATCH_LIMIT;
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
 * Account 1 is the 33-minute Taipei cycle, open only until 05:00.
 * Account 2 is 15/15 from 00:00 Taipei. The 05:00 pause is external.
 */
export function followSlot(accountId: AccountId, now: Date): string | null {
  if (accountId === 2) return account2FollowSlot(now);
  const phase = account1FollowPhase(now);
  if (phase === "new") return taipeiNewFollowSlot(now);
  if (phase === "followback") return taipeiFollowSlot(now);
  return null;
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

/** Audit cursor: each account accepts only its own Taipei work-window starts. */
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
