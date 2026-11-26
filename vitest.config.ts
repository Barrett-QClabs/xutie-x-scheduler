import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xuti-"));
process.env.DATABASE_PATH ??= path.join(dir, "test.sqlite");
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "test-encryption-key";
process.env.X_API_MODE ??= "mock";
// lib/automation.ts falls back to the live shared worker directory when X_AUTOMATION_DIR is unset.
// Tests must never read or write it, so every run gets its own empty directory and sees the
// compiled DEFAULT_CONFIG. This is assigned unconditionally: inheriting a value exported in the
// operator's shell would bring the leak back. Tests that spawn workers still pass their own dir.
const automationDir = path.join(dir, "automation");
fs.mkdirSync(automationDir, { recursive: true });
process.env.X_AUTOMATION_DIR = automationDir;

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": root,
    },
  },
});
