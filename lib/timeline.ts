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
  if (input.now.getTime() - checked < input.ttlMs) return true;
  if (!input.ok || !input.latestAt) return false;
  const latest = new Date(input.latestAt).getTime();
  if (Number.isNaN(latest)) return false;
  return latest + input.intervalMs > input.now.getTime();
}
