/**
 * Process-wide safety posture. Reads environment flags only.
 * Never reads, returns, or logs credential material.
 */

export type ApiMode = "mock" | "live";

/** Real X calls happen only when this variable is exactly `live`. */
export function apiMode(): ApiMode {
  return process.env.X_API_MODE === "live" ? "live" : "mock";
}

/** Follow/unfollow daemons start only when this variable is exactly `on`. */
export function automationSupervisorEnabled(): boolean {
  return process.env.XUTIE_AUTOMATION_SUPERVISOR === "on";
}

/** True when a key long enough to encrypt credentials is configured. The key itself is not returned. */
export function encryptionKeyConfigured(): boolean {
  return (process.env.CREDENTIALS_ENCRYPTION_KEY?.trim().length ?? 0) >= 16;
}

export type DeploymentPosture = {
  apiMode: ApiMode;
  queuePaused: boolean;
  pauseReason: string | null;
  credentialsConfigured: boolean;
  encryptionKeyConfigured: boolean;
  automationSupervisor: "on" | "off";
  /** True only when a due post would call X. Mock mode never sets this. */
  sendsWhenDue: boolean;
};

export function deploymentPosture(input: {
  paused: boolean;
  pauseReason: string | null;
  credentialsConfigured: boolean;
}): DeploymentPosture {
  const mode = apiMode();
  return {
    apiMode: mode,
    queuePaused: input.paused,
    pauseReason: input.pauseReason,
    credentialsConfigured: input.credentialsConfigured,
    encryptionKeyConfigured: encryptionKeyConfigured(),
    automationSupervisor: automationSupervisorEnabled() ? "on" : "off",
    sendsWhenDue: mode === "live" && !input.paused,
  };
}
