/**
 * Client-safe bounds for the persisted automation settings. The server validator in
 * `lib/automation-settings.ts` and the operator form helpers in `lib/automation-settings-form.ts`
 * (used by `components/automation-settings-panel.tsx`) both read this object, so the page checks the
 * same ranges the API enforces. The server stays authoritative: its `invalid_settings` answer is shown
 * in the form as well.
 */

export const DAY_MINUTES = 24 * 60;

/** Documented bounds. A save outside them fails with `invalid_settings`. */
export const SETTINGS_LIMITS = {
  batchSize: { min: 1, max: 50 },
  followDailyCap: { min: 0, max: 400 },
  unfollowDailyCap: { min: 0, max: 400, nullMeans: "no daily cap" },
  workMinutes: { min: 1, max: 720 },
  restMinutes: { min: 0, max: 720 },
  cycleMinutes: { max: DAY_MINUTES },
  anchorMinute: { min: 0, max: DAY_MINUTES - 1 },
  windows: { min: 1, max: 12, minuteMin: 0, minuteMax: DAY_MINUTES },
} as const;

export type SettingsLimits = typeof SETTINGS_LIMITS;
