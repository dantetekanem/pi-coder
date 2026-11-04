import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliRunResult, LaunchRequest, TerminalSettings } from "../cli/contract.js";
import { createLauncher, runScript, scriptQuote, type LauncherDependencies } from "../cli/launch.js";

let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-coder-launch-"));
});
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

type Call = { file: string; args: string[] };

function fakes(handler: (call: Call) => string | Error = () => "") {
  const calls: Call[] = [];
  const spawned: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  let counter = 0;
  const deps: Partial<LauncherDependencies> = {
    exec: async (file, args) => {
      calls.push({ file, args });
      const out = handler({ file, args });
      if (out instanceof Error) throw out;
      return out;
    },
    spawnDetached: async (file, args, options) => {
      spawned.push({ file, args, ...options });
    },
    randomId: () => `launch-${++counter}`,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    delay: async () => undefined,
    resultPollMs: 5,
    livenessPollMs: 10,
  };
  return { calls, spawned, deps };
}

function paneNotFound(): Error {
  return Object.assign(new Error("Command failed"), { stdout: "", stderr: '{"error":{"code":"pane_not_found","message":"pane w1:p9 not found"}}' });
}

function launcher(settings: TerminalSettings, env: Record<string, string | undefined>, handler?: (call: Call) => string | Error) {
  const f = fakes(handler);
  return { ...f, launcher: createLauncher({ agentDir, nodePath: "/usr/bin/node", binPath: "/opt/pi-coder/bin/pi-coder.mjs", settings, env }, f.deps) };
}

const request: LaunchRequest = { argv: ["tool", "open_code_diff"], cwd: "/work/repo", toolInput: { target: "main" }, mode: "auto" };

function runResult(overrides: Partial<CliRunResult> = {}): CliRunResult {
  return { piCoder: 1, command: "tool", tool: "open_code_diff", ok: true, started: true, text: "Review finished", messages: [], notices: [], ...overrides };
}

const herdrEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };

function herdrHandler(call: Call): string | Error {
  if (call.args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "w1:p2" }, type: "pane_info" } });
  return "{}";
}

describe("launcher start", () => {
  it("opens a focused Herdr split beside the caller and runs the launch script", async () => {
    const { launcher: l, calls } = launcher({}, herdrEnv, herdrHandler);
    const record = await l.start(request);

    expect(record).toMatchObject({ id: "launch-1", state: "open", cwd: "/work/repo", argv: ["tool", "open_code_diff"], pane: { kind: "herdr", id: "w1:p2" }, createdAt: "2026-01-02T03:04:05.000Z" });
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).toEqual(["pane get w1:p1", "pane split w1:p1", "pane run w1:p2"]);
    expect(calls[1]?.args).toEqual(["pane", "split", "w1:p1", "--direction", "right", "--ratio", "0.5", "--cwd", "/work/repo", "--focus"]);
    const dir = join(agentDir, "cache", "pi-coder", "launches", "launch-1");
    expect(calls[2]?.args[3]).toBe(`exec /bin/sh '${dir}/run.sh'`);
    expect(readFileSync(join(dir, "run.sh"), "utf8")).toBe(
      `#!/bin/sh\n(umask 077 && echo $$ > '${dir}/pid')\nexec 'env' 'PI_CODING_AGENT_DIR=${agentDir}' '/usr/bin/node' '/opt/pi-coder/bin/pi-coder.mjs' 'tool' 'open_code_diff' '--terminal' 'inline' '--cwd' '/work/repo' '--result-file' '${dir}/result.json' '--input-file' '${dir}/input.json'\n`,
    );
    expect(statSync(join(dir, "run.sh")).mode & 0o777).toBe(0o700);
  });

  it("forwards the caller's pi-coder settings environment to the pane child", async () => {
    const env = { ...herdrEnv, PI_CODER_SESSIONS_DIR: "/tmp/sessions", NO_COLOR: "1", PI_CODER_SETTINGS_PATH: "/tmp/my settings.json", HOME: "/home/user" };
    const { launcher: l } = launcher({}, env, herdrHandler);
    await l.start(request);

    const script = readFileSync(join(agentDir, "cache", "pi-coder", "launches", "launch-1", "run.sh"), "utf8");
    expect(script).toContain(`exec 'env' 'PI_CODING_AGENT_DIR=${agentDir}' 'NO_COLOR=1' 'PI_CODER_SESSIONS_DIR=/tmp/sessions' 'PI_CODER_SETTINGS_PATH=/tmp/my settings.json' '/usr/bin/node' `);
    expect(script).not.toContain("HOME=");
  });

  it("keeps agent-supplied values out of the typed line, so control characters cannot start a command", async () => {
    const { launcher: l, calls } = launcher({}, herdrEnv, herdrHandler);
    const hostile = "/tmp/x\x03touch /tmp/pwned;echo '";
    await l.start({ argv: ["tool", "open_code_diff"], cwd: hostile, toolInput: { args: "$(touch /tmp/pwned)" }, mode: "auto" });

    const dir = join(agentDir, "cache", "pi-coder", "launches", "launch-1");
    expect(calls[2]?.args[3]).toBe(`exec /bin/sh '${dir}/run.sh'`);
    expect(readFileSync(join(dir, "run.sh"), "utf8")).toContain(`'--cwd' '/tmp/x\x03touch /tmp/pwned;echo '\\'''`);
  });

  it("writes a script that sh runs with every value intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-coder-script-"));
    try {
      const values = ["a b", "it's", "$HOME", "`id`", "$(id)", "=ls", "line\nbreak", "tab\there", "back\\slash\\", "\x03ctrl", "{\"x\":1}"];
      const script = join(dir, "run.sh");
      writeFileSync(script, runScript([process.execPath, "-e", "process.stdout.write(JSON.stringify({ pid: process.pid, argv: process.argv.slice(1) }))", ...values], join(dir, "pid")));
      const output = JSON.parse(execFileSync("/bin/sh", [script], { encoding: "utf8" }));

      expect(output.argv).toEqual(values);
      expect(Number(readFileSync(join(dir, "pid"), "utf8").trim())).toBe(output.pid);
      expect(statSync(join(dir, "pid")).mode & 0o777).toBe(0o600);
      expect(() => scriptQuote("nul\0byte")).toThrow(/NUL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores the request, input, and pane with private permissions", async () => {
    const { launcher: l } = launcher({}, herdrEnv, herdrHandler);
    await l.start(request);
    const dir = join(agentDir, "cache", "pi-coder", "launches", "launch-1");

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of ["request.json", "input.json", "pane.json"]) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, "input.json"), "utf8"))).toEqual({ target: "main" });
    expect(JSON.parse(readFileSync(join(dir, "pane.json"), "utf8"))).toEqual({ kind: "herdr", id: "w1:p2" });
  });

  it("omits --input-file when the request has no tool input", async () => {
    const { launcher: l } = launcher({}, herdrEnv, herdrHandler);
    await l.start({ argv: ["diff", "main...HEAD"], cwd: "/work/repo", mode: "auto" });

    const script = readFileSync(join(agentDir, "cache", "pi-coder", "launches", "launch-1", "run.sh"), "utf8");
    expect(script).not.toContain("--input-file");
    expect(script).toContain("'diff' 'main...HEAD' '--terminal' 'inline'");
  });

  it("quotes paths with spaces and apostrophes in the script", async () => {
    const { launcher: l } = launcher({}, herdrEnv, herdrHandler);
    await l.start({ argv: ["diff", "it's here"], cwd: "/work/my repo", mode: "auto" });

    const script = readFileSync(join(agentDir, "cache", "pi-coder", "launches", "launch-1", "run.sh"), "utf8");
    expect(script).toContain(`'diff' 'it'\\''s here' '--terminal' 'inline' '--cwd' '/work/my repo'`);
  });

  it("retries pane run while the new shell is starting", async () => {
    let runs = 0;
    const { launcher: l, calls } = launcher({}, herdrEnv, (call) => {
      if (call.args[1] === "run" && ++runs < 3) return new Error("shell starting");
      return herdrHandler(call);
    });
    const record = await l.start(request);

    expect(record.state).toBe("open");
    expect(calls.filter((call) => call.args[1] === "run")).toHaveLength(3);
  });

  it("closes its pane and records a failure when the command never runs", async () => {
    const { launcher: l, calls } = launcher({}, herdrEnv, (call) => (call.args[1] === "run" ? new Error("no shell") : herdrHandler(call)));

    await expect(l.start(request)).rejects.toThrow(/Could not open a herdr pane for pi-coder: no shell/);
    expect(calls.at(-1)?.args).toEqual(["pane", "close", "w1:p2"]);
    expect(l.get("launch-1")).toMatchObject({ state: "failed", error: "no shell" });
  });

  it("reads Herdr's JSON error message from stderr", async () => {
    const { launcher: l } = launcher({}, herdrEnv, (call) =>
      call.args[1] === "split" ? Object.assign(new Error("Command failed: herdr pane split"), { stderr: '{"error":{"code":"pane_not_found","message":"pane w1:p1 not found"}}' }) : "{}",
    );

    await expect(l.start(request)).rejects.toThrow("pane w1:p1 not found");
  });

  it("prefers tmux when Herdr is not running but TMUX is set", async () => {
    const { launcher: l, calls } = launcher({}, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3" }, (call) => {
      if (call.file === "herdr") return new Error("herdr: command not found");
      return "%7\n";
    });
    const record = await l.start(request);

    expect(record.pane).toEqual({ kind: "tmux", id: "%7", socket: "/tmp/tmux-1/default" });
    const tmux = calls.find((call) => call.file === "tmux");
    expect(tmux?.args.slice(0, 9)).toEqual(["split-window", "-h", "-t", "%3", "-c", "/work/repo", "-P", "-F", "#{pane_id}"]);
    expect(tmux?.args[9]).toBe(`exec /bin/sh '${join(agentDir, "cache", "pi-coder", "launches", "launch-1", "run.sh")}'`);
  });

  it("uses the configured command with {cwd} replaced and the child argv appended", async () => {
    const { launcher: l, spawned } = launcher({ command: ["open-term", "--dir", "{cwd}", "--"] }, { FOO: "bar" });
    const record = await l.start({ ...request, mode: "command" });

    expect(record.pane).toEqual({ kind: "command" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ file: "open-term", cwd: "/work/repo" });
    expect(spawned[0]?.args).toEqual(["--dir", "/work/repo", "--", "/bin/sh", join(agentDir, "cache", "pi-coder", "launches", "launch-1", "run.sh")]);
    expect(spawned[0]?.env.PI_CODING_AGENT_DIR).toBe(agentDir);
  });

  it("falls back to the configured command when neither Herdr nor tmux is present", async () => {
    const { launcher: l, spawned } = launcher({ command: ["open-term"] }, {});
    await l.start(request);

    expect(spawned[0]?.file).toBe("open-term");
  });

  it("names the three options when no terminal is available", async () => {
    const { launcher: l } = launcher({}, {});

    await expect(l.start(request)).rejects.toThrow(/Herdr.*tmux.*terminal\.command/s);
  });

  it("rejects an explicit mode whose environment is missing", async () => {
    const { launcher: l } = launcher({}, {});

    await expect(l.start({ ...request, mode: "herdr" })).rejects.toThrow(/HERDR_PANE_ID/);
    await expect(l.start({ ...request, mode: "tmux" })).rejects.toThrow(/TMUX/);
    await expect(l.start({ ...request, mode: "command" })).rejects.toThrow(/terminal\.command/);
  });

  it("records a failure when the terminal command cannot spawn", async () => {
    const f = fakes();
    f.deps.spawnDetached = async () => {
      throw new Error("spawn open-term ENOENT");
    };
    const l = createLauncher({ agentDir, nodePath: "node", binPath: "bin", settings: { command: ["open-term"] }, env: {} }, f.deps);

    await expect(l.start(request)).rejects.toThrow(/spawn open-term ENOENT/);
    expect(l.get("launch-1")?.state).toBe("failed");
  });
});

describe("launcher wait", () => {
  const resultPath = () => join(agentDir, "cache", "pi-coder", "launches", "launch-1", "result.json");

  it("finishes when the child writes its result and closes the Herdr pane", async () => {
    const { launcher: l, calls } = launcher({}, herdrEnv, herdrHandler);
    await l.start(request);
    const waiting = l.wait("launch-1", { timeoutSeconds: 5 });
    setTimeout(() => writeFileSync(resultPath(), JSON.stringify(runResult({ text: "done" }))), 20);
    const record = await waiting;

    expect(record.state).toBe("finished");
    expect(record.result?.text).toBe("done");
    expect(calls.at(-1)?.args).toEqual(["pane", "close", "w1:p2"]);
    expect(l.get("launch-1")?.state).toBe("finished");
  });

  it("ignores a half-written result until it parses", async () => {
    const { launcher: l } = launcher({}, herdrEnv, herdrHandler);
    await l.start(request);
    writeFileSync(resultPath(), '{"piCoder":1,"text"');
    const waiting = l.wait("launch-1", { timeoutSeconds: 5 });
    setTimeout(() => writeFileSync(resultPath(), JSON.stringify(runResult())), 30);

    expect((await waiting).state).toBe("finished");
  });

  it("returns finished at once for a launch that already has a result", async () => {
    const { launcher: l, calls } = launcher({}, herdrEnv, herdrHandler);
    await l.start(request);
    writeFileSync(resultPath(), JSON.stringify(runResult()));
    const before = calls.length;

    expect((await l.wait("launch-1")).state).toBe("finished");
    expect(calls.length).toBe(before);
  });

  it("reports closed when the Herdr pane disappears without a result", async () => {
    let gone = false;
    const { launcher: l } = launcher({}, herdrEnv, (call) => {
      if (call.args[1] === "get" && call.args[2] === "w1:p2" && gone) return paneNotFound();
      return herdrHandler(call);
    });
    await l.start(request);
    setTimeout(() => {
      gone = true;
    }, 20);
    const record = await l.wait("launch-1", { timeoutSeconds: 5 });

    expect(record.state).toBe("closed");
    expect(l.get("launch-1")?.state).toBe("closed");
  });

  it("prefers a result written just before the pane closed", async () => {
    const { launcher: l } = launcher({}, herdrEnv, (call) => {
      if (call.args[1] === "get" && call.args[2] === "w1:p2") {
        writeFileSync(resultPath(), JSON.stringify(runResult({ text: "last words" })));
        return paneNotFound();
      }
      return herdrHandler(call);
    });
    await l.start(request);
    const record = await l.wait("launch-1", { timeoutSeconds: 5 });

    expect(record).toMatchObject({ state: "finished", result: { text: "last words" } });
  });

  it("keeps waiting when a liveness check fails for another reason", async () => {
    const { launcher: l } = launcher({}, herdrEnv, (call) => (call.args[1] === "get" && call.args[2] === "w1:p2" ? new Error("herdr timed out") : herdrHandler(call)));
    await l.start(request);

    expect((await l.wait("launch-1", { timeoutSeconds: 0.1 })).state).toBe("open");
  });

  it("reports closed when the tmux pane leaves the server's pane list", async () => {
    let gone = false;
    const { launcher: l, calls } = launcher({}, { TMUX: "/tmp/tmux-1/work,1,0", TMUX_PANE: "%1" }, (call) => {
      if (call.args.includes("list-panes")) return gone ? "%1\n" : "%1\n%7\n";
      return "%7\n";
    });
    await l.start(request);
    setTimeout(() => {
      gone = true;
    }, 20);

    expect((await l.wait("launch-1", { timeoutSeconds: 5 })).state).toBe("closed");
    expect(calls.find((call) => call.args.includes("list-panes"))?.args).toEqual(["-S", "/tmp/tmux-1/work", "list-panes", "-a", "-F", "#{pane_id}"]);
  });

  it("keeps a tmux launch open when the check cannot tell, and closes it when the server is gone", async () => {
    let failure = new Error("tmux: unexpected failure");
    const { launcher: l } = launcher({}, { TMUX: "/tmp/tmux-1/work,1,0", TMUX_PANE: "%1" }, (call) => {
      if (call.args.includes("list-panes")) return Object.assign(failure, { stderr: failure.message });
      return "%7\n";
    });
    await l.start(request);

    expect((await l.wait("launch-1", { timeoutSeconds: 0.1 })).state).toBe("open");
    failure = new Error("no server running on /tmp/tmux-1/work");
    expect((await l.wait("launch-1", { timeoutSeconds: 5 })).state).toBe("closed");
  });

  it("reads a child that died from its pid file, even when the pane kind cannot be checked", async () => {
    const f = fakes();
    const alive = new Map<number, boolean>([[4242, true]]);
    const l = createLauncher({ agentDir, nodePath: "node", binPath: "bin", settings: { command: ["open-term"] }, env: {} }, { ...f.deps, processAlive: (pid) => alive.get(pid) ?? false });
    await l.start({ ...request, mode: "command" });
    writeFileSync(join(agentDir, "cache", "pi-coder", "launches", "launch-1", "pid"), "4242\n");

    expect((await l.wait("launch-1", { timeoutSeconds: 0.1 })).state).toBe("open");
    alive.set(4242, false);
    expect((await l.wait("launch-1", { timeoutSeconds: 5 })).state).toBe("closed");
  });

  it("removes launches older than seven days when a new one starts", async () => {
    const root = join(agentDir, "cache", "pi-coder", "launches");
    const store = (id: string, createdAt: string) => {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, "request.json"), JSON.stringify({ id, argv: [], cwd: "/", mode: "auto", createdAt, hasInput: false }));
    };
    store("old-launch", "2025-12-20T00:00:00.000Z");
    store("recent-launch", "2026-01-01T00:00:00.000Z");
    const { launcher: l } = launcher({}, herdrEnv, herdrHandler);
    await l.start(request);

    expect(existsSync(join(root, "old-launch"))).toBe(false);
    expect(existsSync(join(root, "recent-launch"))).toBe(true);
    expect(existsSync(join(root, "launch-1"))).toBe(true);
  });

  it("returns the open record when the timeout passes", async () => {
    const { launcher: l } = launcher({}, herdrEnv, herdrHandler);
    await l.start(request);
    const started = Date.now();
    const record = await l.wait("launch-1", { timeoutSeconds: 0.05 });

    expect(record.state).toBe("open");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("checks once and returns when the timeout is zero", async () => {
    const { launcher: l } = launcher({}, herdrEnv, herdrHandler);
    await l.start(request);

    expect((await l.wait("launch-1", { timeoutSeconds: 0 })).state).toBe("open");
  });

  it("returns the open record when the signal aborts, leaving the pane alone", async () => {
    const { launcher: l, calls } = launcher({}, herdrEnv, herdrHandler);
    await l.start(request);
    const controller = new AbortController();
    const waiting = l.wait("launch-1", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    expect((await waiting).state).toBe("open");
    expect(calls.some((call) => call.args[1] === "close")).toBe(false);
  });

  it("cannot see the end of a command-mode terminal, so it waits for the result or the timeout", async () => {
    const { launcher: l } = launcher({ command: ["open-term"] }, {});
    await l.start(request);

    expect((await l.wait("launch-1", { timeoutSeconds: 0.05 })).state).toBe("open");
    writeFileSync(resultPath(), JSON.stringify(runResult()));
    expect((await l.wait("launch-1", { timeoutSeconds: 1 })).state).toBe("finished");
  });

  it("lets a second launcher collect a launch it did not start", async () => {
    const first = launcher({}, herdrEnv, herdrHandler);
    await first.launcher.start(request);
    writeFileSync(resultPath(), JSON.stringify(runResult({ text: "from elsewhere" })));
    const second = launcher({}, {});

    expect(second.launcher.get("launch-1")).toMatchObject({ state: "finished", result: { text: "from elsewhere" } });
    expect((await second.launcher.wait("launch-1")).result?.text).toBe("from elsewhere");
  });

  it("rejects an unknown launch id and refuses ids that escape the store", async () => {
    const { launcher: l } = launcher({}, herdrEnv, herdrHandler);

    expect(l.get("nope")).toBeUndefined();
    expect(l.get("../../etc")).toBeUndefined();
    await expect(l.wait("nope")).rejects.toThrow(/Unknown pi-coder launch nope/);
  });
});
