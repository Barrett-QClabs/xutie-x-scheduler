/** Europe/London clock, including BST/GMT. Slots are derived from this, not from a fixed offset. */

const ZONE = "Europe/London";

export type LondonClock = {
  day: string;
  hour: number;
  minute: number;
  minutes: number;
};

export function zonedClock(now: Date, zone: string): LondonClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(read("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(read("minute"));
  return {
    day: `${read("year")}-${read("month")}-${read("day")}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

export function londonClock(now: Date): LondonClock {
  return zonedClock(now, ZONE);
}

function clock(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Unfollow windows start at 00:15 and repeat every 30 minutes.
 * 00:00–00:14 is outside the day's first window.
 * Account 2 uses this clock. Account 1 uses the same :15/:45 alignment inside 05:00–09:00 Taipei.
 */
export function londonUnfollowSlot(now: Date): string | null {
  const clockNow = londonClock(now);
  if (clockNow.minutes < 15) return null;
  const start = 15 + Math.floor((clockNow.minutes - 15) / 30) * 30;
  return `${clockNow.day}T${clock(start)}`;
}

const TAIPEI = "Asia/Taipei";
/** Inclusive start of account 1's daily unfollow window. */
export const ACCOUNT1_UNFOLLOW_START_MINUTES = 5 * 60;
/** Exclusive end. The 08:45 slot is open only until 09:00. */
export const ACCOUNT1_UNFOLLOW_END_MINUTES = 9 * 60;

/**
 * Account 1 unfollow slots: Taipei :15 and :45 from 05:15 through 08:45.
 * 05:00–05:14 has no slot. 09:00 and later are closed, so the 08:45 slot finishes before 09:00.
 * The `taipei:` prefix does not collide with historical London keys such as `2026-11-12T05:15`.
 */
export function account1UnfollowSlot(now: Date): string | null {
  const clockNow = zonedClock(now, TAIPEI);
  if (clockNow.minutes < ACCOUNT1_UNFOLLOW_START_MINUTES || clockNow.minutes >= ACCOUNT1_UNFOLLOW_END_MINUTES) return null;
  const start = 15 + Math.floor((clockNow.minutes - 15) / 30) * 30;
  if (start < ACCOUNT1_UNFOLLOW_START_MINUTES || start >= ACCOUNT1_UNFOLLOW_END_MINUTES) return null;
  return `taipei:${clockNow.day}T${clock(start)}`;
}

/** Both accounts unfollow on the Taipei 05:15–08:45 slots. */
export function unfollowSlot(accountId: 1 | 2, now: Date): string | null {
  void accountId;
  return account1UnfollowSlot(now);
}

/**
 * Account 2 follow cycle: 30 minutes from 00:00 London, 15 minutes of work, then 15 of rest.
 * Returns the work-window start, or null during rest. Account 1 does not use this clock.
 */
export function londonFollowSlot(now: Date): string | null {
  const clockNow = londonClock(now);
  const offset = clockNow.minutes % 30;
  if (offset >= 15) return null;
  return `${clockNow.day}T${clock(clockNow.minutes - offset)}`;
}
