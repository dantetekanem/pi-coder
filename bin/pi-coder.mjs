#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  process.stderr.write(`pi-coder requires Node.js 22.19.0 or newer (current: ${process.version}).\n`);
  process.exit(1);
}

function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  return resolve(configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured);
}

// jiti's default cache is a shared folder in the system temp directory; keep compiled sources in a folder only this user can write.
let fsCache = false;
try {
  const cacheDir = join(agentDir(), "cache", "pi-coder", "jiti");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fsCache = cacheDir;
} catch {}

const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { fsCache });
const { main } = await jiti.import("../src/cli/main.ts");
process.exitCode = await main(process.argv.slice(2));
