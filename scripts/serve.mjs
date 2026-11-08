/**
 * Start Next on HOST (default 127.0.0.1) and PORT (default 3847).
 * Loopback is the safe default. Docker sets HOST=0.0.0.0 inside the container
 * so a published port can reach the process. This does not open a public preview.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("usage: node scripts/serve.mjs dev|start");
  process.exit(1);
}

const host = process.env.HOST?.trim() || "127.0.0.1";
const rawPort = process.env.PORT?.trim() || "3847";
if (!/^\d+$/.test(rawPort)) {
  console.error("PORT must be an integer");
  process.exit(1);
}
const portNumber = Number(rawPort);
if (portNumber < 1 || portNumber > 65535) {
  console.error("PORT must be between 1 and 65535");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const args =
  mode === "dev"
    ? [nextBin, "dev", "--turbopack", "-H", host, "-p", String(portNumber)]
    : [nextBin, "start", "-H", host, "-p", String(portNumber)];

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
