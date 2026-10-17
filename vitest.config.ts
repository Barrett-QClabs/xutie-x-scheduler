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

export default defineConfig({
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
