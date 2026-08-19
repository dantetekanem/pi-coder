#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const launcher = resolve(homedir(), ".pi/agent/bin/pi-code-workbench");
const child = spawn(launcher, process.argv.slice(2), { stdio: "inherit" });
child.once("error", (error) => {
  process.stderr.write(`Could not start global workbench launcher: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal != null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
