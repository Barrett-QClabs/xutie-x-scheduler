/** Europe/London clock, including BST/GMT. Slots are derived from this, not from a fixed offset. */

const ZONE = "Europe/London";

export type LondonClock = {
  day: string;
  hour: number;
  minute: number;
  minutes: number;
};

export function londonClock(now: Date): LondonClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
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

function clock(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Unfollow windows start at 00:15 and repeat every 30 minutes.
 * 00:00–00:14 is outside the day's first window.
 */
export function londonUnfollowSlot(now: Date): string | null {
  const clockNow = londonClock(now);
  if (clockNow.minutes < 15) return null;
  const start = 15 + Math.floor((clockNow.minutes - 15) / 30) * 30;
  return `${clockNow.day}T${clock(start)}`;
}

/**
 * Follow cycle is 30 minutes from 00:00: 15 minutes of work, then 15 minutes of rest.
 * Both accounts use this same clock. Returns the work-window start, or null during rest.
 */
export function londonFollowSlot(now: Date): string | null {
  const clockNow = londonClock(now);
  const offset = clockNow.minutes % 30;
  if (offset >= 15) return null;
  return `${clockNow.day}T${clock(clockNow.minutes - offset)}`;
}
