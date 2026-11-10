import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const chrome = ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((item) => existsSync(item));
const port = 3877;
const origin = `http://127.0.0.1:${port}`;

const account1 = {
  apiKey: "acctoneA",
  apiSecret: "acctoneA-secret",
  accessToken: "acctoneA-token",
  accessTokenSecret: "acctoneA-token-secret",
  handle: "@mock_acctonea",
};
const account2 = {
  apiKey: "accttwoB",
  apiSecret: "accttwoB-secret",
  accessToken: "accttwoB-token",
  accessTokenSecret: "accttwoB-token-secret",
  handle: "@mock_accttwob",
};

describe.skipIf(!chrome)("settings account switch in the browser", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const bodies: Array<{ url: string; accountId?: unknown }> = [];

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "xuti-browser-"));
    server = spawn(process.execPath, ["scripts/serve.mjs", "dev"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        X_API_MODE: "mock",
        XUTIE_AUTOMATION_SUPERVISOR: "off",
        CREDENTIALS_ENCRYPTION_KEY: "browser-test-encryption-key",
        DATABASE_PATH: path.join(dir, "xqueue.sqlite"),
      },
      stdio: "ignore",
    });
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/api/state?accountId=1`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!ready) throw new Error("mock server did not start");
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on("request", (request) => {
      if (!request.url().includes("/api/credentials")) return;
      const raw = request.postData() ?? "";
      let accountId: unknown;
      try {
        accountId = JSON.parse(raw).accountId;
      } catch {
        accountId = new URL(request.url()).searchParams.get("accountId");
      }
      bodies.push({ url: request.url(), accountId });
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill("SIGTERM");
  });

  async function fill(slot: 1 | 2, values: typeof account1) {
    await page.click(`[data-testid="settings-slot-${slot}"]`);
    await page.waitForFunction((expected) => document.querySelector('[data-testid="slot-label"]')?.textContent === expected, {}, slot === 1 ? "账号1" : "账号2");
    await page.locator(`#apiKey-${slot}`).fill(values.apiKey);
    await page.locator(`#apiSecret-${slot}`).fill(values.apiSecret);
    await page.locator(`#accessToken-${slot}`).fill(values.accessToken);
    await page.locator(`#accessTokenSecret-${slot}`).fill(values.accessTokenSecret);
    await page.waitForSelector('[data-testid="save-and-test"]:not([disabled])');
  }

  it("keeps each verified account when the user switches slots", async () => {
    await page.goto(`${origin}/settings`, { waitUntil: "networkidle0" });
    await fill(1, account1);
    await page.click('[data-testid="save-and-test"]');
    await page.waitForFunction((handle) => document.querySelector('[data-testid="connected-handle"]')?.textContent === handle, {}, account1.handle);

    await fill(2, account2);
    const before = bodies.length;
    await page.click('[data-testid="save-and-test"]');
    await page.waitForFunction((handle) => document.querySelector('[data-testid="connected-handle"]')?.textContent === handle, {}, account2.handle);
    const written = bodies.slice(before).map((item) => item.accountId);
    expect(written).toEqual([2, 2]);

    await page.click('[data-testid="settings-slot-1"]');
    await page.waitForFunction((handle) => document.querySelector('[data-testid="connected-handle"]')?.textContent === handle, {}, account1.handle);

    const first = await fetch(`${origin}/api/state?accountId=1`).then((response) => response.json());
    const second = await fetch(`${origin}/api/state?accountId=2`).then((response) => response.json());
    expect(first.account.username).toBe("mock_acctonea");
    expect(second.account.username).toBe("mock_accttwob");
    expect(first.credentialsConfigured).toBe(true);
    expect(second.credentialsConfigured).toBe(true);
  }, 60_000);

  it("does not retarget an in-flight save when the user switches slots", async () => {
    await page.goto(`${origin}/settings`, { waitUntil: "networkidle0" });
    await page.setViewport({ width: 500, height: 800 });
    await fill(2, { ...account2, apiKey: "accttwoC" });
    const marker = bodies.length;
    await page.evaluate(() => {
      (document.querySelector('[data-testid="save-and-test"]') as HTMLButtonElement).click();
      (document.querySelector('[data-testid="settings-slot-1"]') as HTMLButtonElement).click();
    });
    await page.waitForResponse((response) => response.url().includes("/api/credentials/test"));
    await page.waitForFunction(() => document.querySelector('[data-testid="slot-label"]')?.textContent === "账号1");
    const written = bodies.slice(marker).filter((item) => item.url.includes("/api/credentials")).map((item) => item.accountId);
    expect(written).toEqual([2, 2]);
    const first = await fetch(`${origin}/api/state?accountId=1`).then((response) => response.json());
    expect(first.account.username).toBe("mock_acctonea");
    expect(JSON.stringify(first)).not.toContain("accttwoC-secret");
  }, 60_000);
});
