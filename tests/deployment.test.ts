import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "@/lib/automation";
import { getQueueSettings, reopenDatabase } from "@/lib/db";
import { apiMode, deploymentPosture } from "@/lib/deployment";
import { getPublicState } from "@/lib/service";
import { createXClient, isMockMode } from "@/lib/x-client";

const originals = {
  mode: process.env.X_API_MODE,
  supervisor: process.env.XUTIE_AUTOMATION_SUPERVISOR,
  database: process.env.DATABASE_PATH,
};

afterEach(() => {
  restore("X_API_MODE", originals.mode);
  restore("XUTIE_AUTOMATION_SUPERVISOR", originals.supervisor);
  restore("DATABASE_PATH", originals.database);
  reopenDatabase();
});

function restore(name: "X_API_MODE" | "XUTIE_AUTOMATION_SUPERVISOR" | "DATABASE_PATH", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("deployment posture", () => {
  it("treats only an exact live value as a real X mode", () => {
    for (const value of [undefined, "", "mock", "MOCK", "live "]) {
      restore("X_API_MODE", value);
      expect(apiMode()).toBe("mock");
      expect(isMockMode()).toBe(true);
    }
    process.env.X_API_MODE = "live";
    expect(apiMode()).toBe("live");
    expect(isMockMode()).toBe(false);
  });

  it("does not send a mock post to the network", async () => {
    const calls: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("network");
    }) as typeof fetch;
    delete process.env.X_API_MODE;
    try {
      const posted = await createXClient({
        apiKey: "local-key",
        apiSecret: "local-secret",
        accessToken: "local-token",
        accessTokenSecret: "local-token-secret",
      }).postTweet("offline check");
      expect(posted.id.startsWith("mock_")).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("starts a brand-new database paused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xuti-safe-"));
    process.env.DATABASE_PATH = path.join(dir, "fresh.sqlite");
    reopenDatabase();
    expect(getQueueSettings()).toMatchObject({ paused: true, pauseReason: "safe_start" });

    const state = getPublicState();
    expect(state.deployment).toMatchObject({
      apiMode: "mock",
      queuePaused: true,
      pauseReason: "safe_start",
      credentialsConfigured: false,
      automationSupervisor: "off",
      sendsWhenDue: false,
    });
    expect(state.mockMode).toBe(true);
    expect(JSON.stringify(state)).not.toContain("local-secret");
    expect(JSON.stringify(state)).not.toContain(process.env.CREDENTIALS_ENCRYPTION_KEY);
  });

  it("reports live mode without arming sends while the queue is paused", () => {
    process.env.X_API_MODE = "live";
    const posture = deploymentPosture({ paused: true, pauseReason: "manual", credentialsConfigured: false });
    expect(posture).toMatchObject({ apiMode: "live", queuePaused: true, sendsWhenDue: false, automationSupervisor: "off" });
    process.env.XUTIE_AUTOMATION_SUPERVISOR = "on";
    expect(deploymentPosture({ paused: false, pauseReason: null, credentialsConfigured: false }).sendsWhenDue).toBe(true);
    expect(deploymentPosture({ paused: false, pauseReason: null, credentialsConfigured: false }).automationSupervisor).toBe("on");
  });

  it("refuses to start follow daemons unless the supervisor is explicitly on", () => {
    delete process.env.XUTIE_AUTOMATION_SUPERVISOR;
    expect(() => startDaemon("followback")).toThrowError(
      expect.objectContaining({ code: "automation_disabled", status: 403 }),
    );
    expect(() => startDaemon("keywordfollow")).toThrowError(
      expect.objectContaining({ code: "automation_disabled" }),
    );
  });
});
