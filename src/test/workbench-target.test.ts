import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import {
  MAX_NORMALIZED_LAUNCH_BYTES,
  hashTargetSlice,
  normalizeWorkbenchLaunch,
  rawTextSliceForRange,
} from "../workbench/target.js";

const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

describe("workbench target launch contracts", () => {
  it.each([
    { name: "BOM", text: "\uFEFFfirst\nsecond", range: { startLine: 1, endLine: 1 }, slice: "\uFEFFfirst" },
    { name: "mixed separators", text: "one\r\ntwo\rthree\nfour", range: { startLine: 1, endLine: 3 }, slice: "one\r\ntwo\rthree" },
    { name: "trailing separator final empty line", text: "one\n", range: { startLine: 2, endLine: 2 }, slice: "" },
    { name: "empty buffer", text: "", range: { startLine: 1, endLine: 1 }, slice: "" },
    { name: "astral UTF-8", text: "🙂\nend", range: { startLine: 1, endLine: 1 }, slice: "🙂" },
  ])("uses exact raw UTF-8 $name slices", ({ text, range, slice }) => {
    expect(rawTextSliceForRange(text, range)).toBe(slice);
    expect(hashTargetSlice(text, range)).toEqual({ algorithm: "sha256", value: sha256(slice) });
  });

  it.each([
    { label: "zero start", target: { path: "a.ts", range: { startLine: 0, endLine: 1 } } },
    { label: "reversed range", target: { path: "a.ts", range: { startLine: 2, endLine: 1 } } },
    { label: "fractional line", target: { path: "a.ts", range: { startLine: 1.5, endLine: 2 } } },
    { label: "absolute path", target: { path: "/a.ts", range: { startLine: 1, endLine: 1 } } },
    { label: "bad hash", target: { path: "a.ts", range: { startLine: 1, endLine: 1 }, anchor: { algorithm: "sha256" as const, value: "A".repeat(64) } } },
  ])("rejects malformed $label", ({ target }) => {
    expect(() => normalizeWorkbenchLaunch({ initialTarget: target })).toThrow();
  });

  it("preserves contract key and caller story order while enforcing story limits", () => {
    const launch = normalizeWorkbenchLaunch({
      initialTarget: { path: "a.ts", range: { startLine: 1, endLine: 1 } },
      stories: [
        { id: "second", target: { path: "b.ts", range: { startLine: 2, endLine: 2 } }, prose: "two" },
        { id: "first", target: { path: "a.ts", range: { startLine: 1, endLine: 1 } }, prose: "one" },
      ],
      capabilities: { discuss: true },
    });
    expect(Object.keys(launch)).toEqual(["initialTarget", "stories", "capabilities"]);
    expect(launch.stories?.map((story) => story.id)).toEqual(["second", "first"]);
    expect(() => normalizeWorkbenchLaunch({ stories: Array.from({ length: 51 }, (_, index) => ({ id: String(index), target: { path: "a.ts", range: { startLine: 1, endLine: 1 } }, prose: "" })) })).toThrow();
    const sparseStories = Array<{ id: string; target: { path: string; range: { startLine: number; endLine: number } }; prose: string }>(2);
    sparseStories[1] = { id: "second", target: { path: "b.ts", range: { startLine: 1, endLine: 1 } }, prose: "two" };
    expect(() => normalizeWorkbenchLaunch({ stories: sparseStories })).toThrow(/missing/i);
    expect(() => normalizeWorkbenchLaunch({ stories: [{ id: "same", target: { path: "a.ts", range: { startLine: 1, endLine: 1 } }, prose: "" }, { id: "same", target: { path: "b.ts", range: { startLine: 1, endLine: 1 } }, prose: "" }] })).toThrow();
  });

  it("accepts exactly and rejects over the normalized launch byte cap", () => {
    const base = normalizeWorkbenchLaunch({ initialTarget: { path: "a", range: { startLine: 1, endLine: 1 } } });
    const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
    const exactPath = "a".repeat(MAX_NORMALIZED_LAUNCH_BYTES - overhead + 1);
    expect(() => normalizeWorkbenchLaunch({ initialTarget: { path: exactPath, range: { startLine: 1, endLine: 1 } } })).not.toThrow();
    expect(() => normalizeWorkbenchLaunch({ initialTarget: { path: `${exactPath}a`, range: { startLine: 1, endLine: 1 } } })).toThrow(/131072/);
  });

  it("opens, clamps and marks stale target hints without inventing missing files", async () => {
    const workbench = createWorkbench({
      listFiles: async () => "a.ts\0",
      readText: async () => ({ text: "one\ntwo", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: 1024,
    });
    await workbench.start();

    expect(await workbench.openTarget({ path: "a.ts", range: { startLine: 2, endLine: 9 }, anchor: hashTargetSlice("one\ntwo", { startLine: 2, endLine: 2 }) })).toEqual({ status: "opened", path: "a.ts", range: { startLine: 2, endLine: 2 }, stale: true, message: "Target range was clamped to the current file." });
    expect(workbench.selectedLine).toBe(2);
    expect(await workbench.openTarget({ path: "missing.ts", range: { startLine: 1, endLine: 1 } })).toEqual({ status: "missing", path: "missing.ts", message: "Target file is not available in this repository." });
    expect(workbench.selectedPath).toBe("a.ts");
  });
});
