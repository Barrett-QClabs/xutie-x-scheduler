export function shouldReuseTimelineCache(input: {
  checkedAt: string | null;
  latestAt: string | null;
  ok: boolean;
  now: Date;
  intervalMs: number;
  ttlMs: number;
}): boolean {
  if (!input.checkedAt) return false;
  const checked = new Date(input.checkedAt).getTime();
  if (Number.isNaN(checked)) return false;
  // Only a short TTL: keeping the cache "until the interval passes" hid manual
  // posts made shortly after ours, so the queue never re-anchored to them.
  return input.now.getTime() - checked < input.ttlMs;
}
