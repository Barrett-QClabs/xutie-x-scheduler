import { AppError } from "@/lib/errors";

/** Default random extra delay added on top of the interval, in seconds (1–2 minutes). */
export const DEFAULT_RANDOM_MIN_SECONDS = 60;
export const DEFAULT_RANDOM_MAX_SECONDS = 120;

export type SchedulePace = {
  intervalMinutes: number;
  randomMinSeconds: number;
  randomMaxSeconds: number;
};

export function assertSchedule(intervalMinutes: number, randomMinSeconds: number, randomMaxSeconds: number): void {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 24 * 60) {
    throw new AppError("invalid_interval", "间隔需为 1 到 1440 之间的整数分钟。");
  }
  const intervalSeconds = intervalMinutes * 60;
  if (
    !Number.isInteger(randomMinSeconds) ||
    !Number.isInteger(randomMaxSeconds) ||
    randomMinSeconds < 0 ||
    randomMaxSeconds < randomMinSeconds ||
    randomMaxSeconds >= intervalSeconds
  ) {
    throw new AppError("invalid_random", "随机延迟需为整数秒，0 ≤ 最少 ≤ 最多，且最多要小于间隔。");
  }
}

export function assertStartAt(startAt: string): Date {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) {
    throw new AppError("invalid_start", "开始时间无法识别。");
  }
  const drift = start.getTime() - Date.now();
  if (drift > 366 * 24 * 60 * 60 * 1000) {
    throw new AppError("start_too_late", "开始时间不能晚于一年后。");
  }
  if (drift < -7 * 24 * 60 * 60 * 1000) {
    throw new AppError("start_too_early", "开始时间不能早于 7 天前。");
  }
  return start;
}

/** Round a timestamp up to the next whole second, so gaps are never shortened. */
export function ceilToSecond(ms: number): number {
  return Math.ceil(ms / 1000) * 1000;
}

/** Uniform random whole number of seconds in [min, max], returned in milliseconds. */
export function randomExtraMs(pace: Pick<SchedulePace, "randomMinSeconds" | "randomMaxSeconds">, random: () => number = Math.random): number {
  const min = pace.randomMinSeconds;
  const span = pace.randomMaxSeconds - min;
  const roll = Math.min(Math.max(random(), 0), 0.999999999);
  return (min + Math.floor(roll * (span + 1))) * 1000;
}

/** One gap between consecutive posts: the interval plus a fresh random extra delay. */
export function nextGapMs(pace: SchedulePace, random: () => number = Math.random): number {
  return pace.intervalMinutes * 60_000 + randomExtraMs(pace, random);
}

/**
 * First post exactly at startAt; every later post is
 * previous + interval + uniform random extra in [randomMinSeconds, randomMaxSeconds].
 */
export function computeSchedule(options: {
  count: number;
  startAt: Date;
  intervalMinutes: number;
  randomMinSeconds: number;
  randomMaxSeconds: number;
  random?: () => number;
}): Date[] {
  const random = options.random ?? Math.random;
  const times: Date[] = [];
  let cursor = options.startAt.getTime();
  for (let index = 0; index < options.count; index += 1) {
    if (index > 0) cursor += nextGapMs(options, random);
    times.push(new Date(cursor));
  }
  return times;
}

/**
 * Push a chain of posts (already in send order) so that the first is no earlier
 * than firstMinAt and each following post is at least interval + random extra
 * after the previous one. Posts are never moved earlier. Returns the new times.
 */
export function pushChain(options: {
  originals: Date[];
  firstMinAt: Date;
  pace: SchedulePace;
  random?: () => number;
}): Date[] {
  const random = options.random ?? Math.random;
  const result: Date[] = [];
  let previous = 0;
  options.originals.forEach((original, index) => {
    const floor = index === 0 ? ceilToSecond(options.firstMinAt.getTime()) : previous + nextGapMs(options.pace, random);
    const at = Math.max(original.getTime(), floor);
    result.push(new Date(at));
    previous = at;
  });
  return result;
}
