import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureRuntime, copyText, getAgentDir, highlightLine, languageForPath, resetRuntime } from "../host/runtime.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  resetRuntime();
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("runtime defaults", () => {
  it("uses the Pi agent directory without Pi", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(getAgentDir()).toBe(join(homedir(), ".pi", "agent"));
    process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
    expect(getAgentDir()).toBe(join(homedir(), "custom-agent"));
    process.env.PI_CODING_AGENT_DIR = "/srv/agent";
    expect(getAgentDir()).toBe(resolve("/srv/agent"));
  });

  it("leaves highlighting plain until a host configures it", () => {
    expect(highlightLine("const a = 1;", "typescript")).toBe("const a = 1;");
    expect(languageForPath("a.ts")).toBeUndefined();
  });
});

describe("configureRuntime", () => {
  it("replaces only the services it is given and resets to the defaults", async () => {
    const copy = vi.fn(async () => undefined);
    configureRuntime({ copyText: copy, agentDir: () => "/host/agent" });
    configureRuntime({ languageForPath: () => "ruby" });

    await copyText("selected");

    expect(copy).toHaveBeenCalledExactlyOnceWith("selected");
    expect(getAgentDir()).toBe("/host/agent");
    expect(languageForPath("anything")).toBe("ruby");
    expect(highlightLine("x", "ruby")).toBe("x");

    resetRuntime();
    expect(languageForPath("anything")).toBeUndefined();
    expect(getAgentDir()).not.toBe("/host/agent");
  });
});
