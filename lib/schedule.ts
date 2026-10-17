import { AppError } from "@/lib/errors";

export function assertSchedule(intervalMinutes: number, jitterMinutes: number): void {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 24 * 60) {
    throw new AppError("invalid_interval", "间隔需为 1 到 1440 之间的整数分钟。");
  }
  if (!Number.isInteger(jitterMinutes) || jitterMinutes < 0 || jitterMinutes >= intervalMinutes) {
    throw new AppError("invalid_jitter", "抖动需为整数分钟，且不小于 0、小于间隔。");
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

export function computeSchedule(options: {
  count: number;
  startAt: Date;
  intervalMinutes: number;
  jitterMinutes: number;
  random?: () => number;
}): Date[] {
  const random = options.random ?? Math.random;
  const intervalMs = options.intervalMinutes * 60_000;
  const jitterMs = options.jitterMinutes * 60_000;
  const times: Date[] = [];
  let cursor = options.startAt.getTime();
  for (let index = 0; index < options.count; index += 1) {
    const swing = jitterMs === 0 ? 0 : Math.round((random() * 2 - 1) * jitterMs);
    let at = cursor + swing;
    if (times.length > 0) {
      const minimum = times[times.length - 1].getTime() + 15_000;
      if (at < minimum) at = minimum;
    }
    times.push(new Date(at));
    cursor += intervalMs;
  }
  return times;
}
