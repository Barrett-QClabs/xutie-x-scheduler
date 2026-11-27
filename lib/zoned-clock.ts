/** Civil clock in an IANA zone, read from Intl, so daylight-saving shifts follow the zone itself. */

export type ZonedClock = {
  day: string;
  hour: number;
  minute: number;
  minutes: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let cached = formatters.get(zone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, cached);
  }
  return cached;
}

export function zonedClock(now: Date, zone: string): ZonedClock {
  const parts = formatter(zone).formatToParts(now);
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

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** Canonical IANA name, or null. Offsets such as `+08:00` and unknown names are rejected. */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = value.trim();
  if (zone.length === 0 || zone.length > 64 || !ZONE_NAME.test(zone)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Civil day `n` days after `day` (YYYY-MM-DD). */
export function shiftCivilDay(day: string, n: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + n)).toISOString().slice(0, 10);
}

/** Local wall time minus UTC, in milliseconds, at instant `at`. Minute precision. */
function zoneOffsetMs(at: number, zone: string): number {
  const clock = zonedClock(new Date(at), zone);
  const [year, month, date] = clock.day.split("-").map(Number);
  const local = Date.UTC(year, month - 1, date, clock.hour, clock.minute);
  return local - Math.floor(at / 60_000) * 60_000;
}

/** UTC instant of 00:00 on civil `day` in `zone`, including days that are 23 or 25 hours long. */
export function zonedMidnight(day: string, zone: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const target = Date.UTC(year, month - 1, date);
  let guess = target - zoneOffsetMs(target, zone);
  for (let step = 0; step < 4; step += 1) {
    const next = target - zoneOffsetMs(guess, zone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** The civil day containing `now` in `zone`, with its [start, end) instants. */
export function zonedDayRange(now: Date, zone: string): { day: string; start: Date; end: Date } {
  const day = zonedClock(now, zone).day;
  return {
    day,
    start: new Date(zonedMidnight(day, zone)),
    end: new Date(zonedMidnight(shiftCivilDay(day, 1), zone)),
  };
}
