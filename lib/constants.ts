/** Maximum number of valid posts accepted from one import. */
export const MAX_IMPORT_BATCH = 50;

/**
 * How long a successful or failed timeline read can be reused.
 * While the cached post is still inside the interval, the read is reused
 * until that interval ends, so a wait does not trigger another paid read.
 */
export const TIMELINE_CACHE_TTL_MS = 60_000;
