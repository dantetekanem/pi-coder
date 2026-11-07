import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bin = resolve(import.meta.dirname, "../../bin/pi-coder.mjs");

function run(args: string[]) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-coder-bin-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.PI_PACKAGE_DIR;
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env, timeout: 30_000 });
}

describe("bin/pi-coder.mjs", () => {
  it("prints the package version", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints help", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: pi-coder");
  });

  it("exits 2 on a usage error", () => {
    const result = run(["nonsense"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown command nonsense");
  });
});
