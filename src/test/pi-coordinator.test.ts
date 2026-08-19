import { describe, expect, it, vi } from "vitest";
import {
  composeCodeDiscussionPrompt,
  parseDirectCodeArgs,
  runGuardedPiWorkbench,
  tokenizeCodeArgs,
} from "../adapters/pi/coordinator.js";
import type { WorkbenchCompletionResult } from "../workbench/contracts.js";

const closed: WorkbenchCompletionResult = { status: "closed", changedPaths: [] };

describe("Pi code coordinator", () => {
  it("tokenizes deterministically without shell interpretation", () => {
    expect(tokenizeCodeArgs(`--path 'src/a b.ts' --line 2 --story-json "{\\"id\\":\\"$HOME * $(bad)\\",\\"target\\":{\\"path\\":\\"a.ts\\",\\"range\\":{\\"startLine\\":1,\\"endLine\\":1}},\\"prose\\":\\"x\\"}"`))
      .toEqual(["--path", "src/a b.ts", "--line", "2", "--story-json", '{"id":"$HOME * $(bad)","target":{"path":"a.ts","range":{"startLine":1,"endLine":1}},"prose":"x"}']);
    expect(tokenizeCodeArgs(String.raw`--path src/a\ b.ts --line 1`)).toEqual(["--path", "src/a b.ts", "--line", "1"]);
    expect(() => tokenizeCodeArgs("--path 'unterminated")).toThrow(/unterminated/i);
    expect(() => tokenizeCodeArgs(String.raw`--path "bad\n"`)).toThrow(/double-quote escape/i);
  });

  it("parses the exact direct grammar through normalized launch validation", () => {
    expect(parseDirectCodeArgs("--path src/app.ts --line 4 --end-line 7 --anchor-sha256 " + "a".repeat(64))).toEqual({
      initialTarget: { path: "src/app.ts", range: { startLine: 4, endLine: 7 }, anchor: { algorithm: "sha256", value: "a".repeat(64) } },
      capabilities: { discuss: true },
    });
    expect(parseDirectCodeArgs("")).toEqual({ capabilities: { discuss: true } });
  });

  it.each([
    ["unknown", "--wat value"],
    ["duplicate", "--path a.ts --path b.ts --line 1"],
    ["missing value", "--path"],
    ["missing pair", "--path a.ts"],
    ["bad line", "--path a.ts --line 0"],
    ["bad normalized path", "--path ../a.ts --line 1"],
    ["bad story JSON", "--story-json nope"],
  ])("rejects %s before launch", (_label, args) => {
    expect(() => parseDirectCodeArgs(args)).toThrow();
  });

  it("shares one process guard, rejects overlap, and releases after success and failure", async () => {
    let finish!: (result: WorkbenchCompletionResult) => void;
    const firstRunner = vi.fn(() => new Promise<WorkbenchCompletionResult>((resolve) => { finish = resolve; }));
    const first = runGuardedPiWorkbench("direct-code", firstRunner);
    await vi.waitFor(() => expect(firstRunner).toHaveBeenCalledOnce());

    const blockedRunner = vi.fn(async () => closed);
    await expect(runGuardedPiWorkbench("open-code", blockedRunner)).resolves.toMatchObject({ status: "failed", code: "PI_WORKBENCH_ACTIVE" });
    expect(blockedRunner).not.toHaveBeenCalled();

    finish(closed);
    await expect(first).resolves.toEqual(closed);
    await expect(runGuardedPiWorkbench("open-code", blockedRunner)).resolves.toEqual(closed);

    const rejecting = vi.fn(async () => { throw new Error("boom"); });
    await expect(runGuardedPiWorkbench("review-bridge", rejecting)).resolves.toMatchObject({ status: "failed", message: "boom" });
    await expect(runGuardedPiWorkbench("direct-code", blockedRunner)).resolves.toEqual(closed);
  });

  it("builds a bounded location-only DISCUSS prompt", () => {
    const result = {
      status: "discuss" as const,
      changedPaths: ["src/a.ts"],
      target: { path: "src/app.ts", range: { startLine: 4, endLine: 7 }, anchor: { algorithm: "sha256" as const, value: "a".repeat(64) } },
      note: "Why this shape?",
    };
    const prompt = composeCodeDiscussionPrompt("/repo", result);
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("src/app.ts");
    expect(prompt).toContain("4-7");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("Why this shape?");
    expect(prompt).toContain("Do not edit files");
  });
});
