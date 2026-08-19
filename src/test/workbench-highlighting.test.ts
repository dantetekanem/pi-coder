import { describe, expect, it, vi } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import type { BufferEditDelta, WorkbenchRepository } from "../workbench/contracts.js";
import { createNodeShikiHighlighter, tokensToAnsi } from "../workbench/node/shiki.js";
import {
  HIGHLIGHT_EDIT_CODE_UNIT_BUDGET,
  projectHighlightedSourceLineDelta,
  projectHighlightedSourceLines,
  validateHighlightedSourceLines,
} from "../workbench/highlight.js";

function delta(overrides: Partial<BufferEditDelta> = {}): BufferEditDelta {
  return {
    startOffset: 1, deletedText: "", insertedText: "!",
    oldStart: { line: 0, column: 1 }, oldEnd: { line: 0, column: 1 },
    newStart: { line: 0, column: 1 }, newEnd: { line: 0, column: 2 },
    oldLineCount: 3, newLineCount: 3,
    ...overrides,
  };
}

function repository(highlighter?: WorkbenchRepository["sourceHighlighter"]): WorkbenchRepository {
  return {
    listFiles: async () => "one.ts\0two.txt\0",
    readText: async (path) => ({ text: path === "one.ts" ? "const value = 1;\n\treturn value;" : "two\u001b[31m", revision: path }),
    saveText: async (_path, text) => ({ status: "success", effect: "saved", revision: text }),
    maxReadBytes: 1024,
    sourceHighlighter: highlighter,
  };
}

async function opened(highlighter?: WorkbenchRepository["sourceHighlighter"]) {
  const workbench = createWorkbench(repository(highlighter));
  await workbench.start();
  return workbench;
}

describe("workbench source highlighting", () => {
  it("projects only the affected line envelope and reports deterministic local work", () => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    const source = ["a", "middle", "z"];
    const highlighted = source.map(red);
    const edit = delta({
      startOffset: 4, deletedText: "dd", insertedText: "X\nY",
      oldStart: { line: 1, column: 2 }, oldEnd: { line: 1, column: 4 },
      newStart: { line: 1, column: 2 }, newEnd: { line: 2, column: 1 },
      oldLineCount: 3, newLineCount: 4,
    });

    const projected = projectHighlightedSourceLineDelta(source, source, highlighted, edit)!;
    expect(projected.sourceLines).toEqual(["a", "miX", "Yle", "z"]);
    expect(projected.highlightedLines[0]).toBe(highlighted[0]);
    expect(projected.highlightedLines[3]).toBe(highlighted[2]);
    expect(projected.highlightedLines.join("\n").replace(/\u001b\[[0-9;]*m/g, "")).toBe("a\nmiX\nYle\nz");
    expect(projected.stats).toMatchObject({ affectedOldLines: 1, affectedNewLines: 2, budgetExceeded: false });

    const tenTimesMore = projectHighlightedSourceLineDelta(
      [...Array.from({ length: 10 }, () => "untouched"), ...source],
      [...Array.from({ length: 10 }, () => "untouched"), ...source],
      [...Array.from({ length: 10 }, () => red("untouched")), ...highlighted],
      { ...edit, oldStart: { line: 11, column: 2 }, oldEnd: { line: 11, column: 4 }, newStart: { line: 11, column: 2 }, newEnd: { line: 12, column: 1 }, oldLineCount: 13, newLineCount: 14 },
    )!;
    expect(tenTimesMore.stats.plannedStyleSlots).toBe(projected.stats.plannedStyleSlots);
    expect(tenTimesMore.stats.sanitizedCodeUnits).toBe(projected.stats.sanitizedCodeUnits);
    expect(tenTimesMore.stats.allocatedStyleSlots).toBe(projected.stats.allocatedStyleSlots);
    expect(tenTimesMore.stats.parsedStyleCodeUnits).toBe(projected.stats.parsedStyleCodeUnits);
    expect(tenTimesMore.stats.renderedCodeUnits).toBe(projected.stats.renderedCodeUnits);
  });

  it("bounds repeated projection for an adverse near-256KiB line and keeps untouched colors", () => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    let source = ["colored", "x".repeat(255 * 1024)];
    let highlighted = source.map(red);
    for (let index = 0; index < 5; index += 1) {
      const line = source[1]!;
      const projected = projectHighlightedSourceLineDelta(source, source, highlighted, delta({
        startOffset: source[0]!.length + 1 + line.length,
        insertedText: "x",
        oldStart: { line: 1, column: line.length }, oldEnd: { line: 1, column: line.length },
        newStart: { line: 1, column: line.length }, newEnd: { line: 1, column: line.length + 1 },
        oldLineCount: 2, newLineCount: 2,
      }))!;
      expect(projected.stats.budgetExceeded).toBe(true);
      expect(projected.stats.plannedStyleSlots).toBeGreaterThan(HIGHLIGHT_EDIT_CODE_UNIT_BUDGET);
      expect(projected.stats.allocatedStyleSlots).toBe(0);
      expect(projected.stats.parsedStyleCodeUnits).toBe(0);
      expect(projected.stats.renderedCodeUnits).toBe(0);
      expect(projected.highlightedLines[0]).toBe(highlighted[0]);
      expect(projected.highlightedLines[1]).toBe(`${line}x`);
      source = [...projected.sourceLines];
      highlighted = [...projected.highlightedLines];
    }
  });
  it.each([
    ["exact", "y", true],
    ["one unit over", "yy", false],
  ] as const)("keeps styled output at the %s no-EOL budget boundary", (_label, insertedText, styled) => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    const oldText = "x".repeat(5_461);
    const projected = projectHighlightedSourceLineDelta([oldText], [oldText], [red(oldText)], delta({
      startOffset: oldText.length, insertedText,
      oldStart: { line: 0, column: oldText.length }, oldEnd: { line: 0, column: oldText.length },
      newStart: { line: 0, column: oldText.length }, newEnd: { line: 0, column: oldText.length + insertedText.length },
      oldLineCount: 1, newLineCount: 1,
    }))!;

    expect(projected.highlightedLines[0]).toBe(styled ? red(`${oldText}${insertedText}`) : `${oldText}${insertedText}`);
  });

  it("preflights whole compatibility projections at the exact budget boundary", () => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    const oldLine = "x".repeat(5_461);
    const oldText = `${oldLine}\ntail`;
    const exactNextLine = `${oldLine}y`;
    const exact = projectHighlightedSourceLines(oldText, [red(oldLine), red("tail")], `${exactNextLine}\ntail`);
    expect(exact[0]).toMatch(/\u001b\[[0-9;]+m/);
    expect(exact[1]).toBe(red("tail"));

    const over = projectHighlightedSourceLines(oldText, [red(oldLine), red("tail")], `${oldLine}yy\ntail`);
    expect(over[0]).toBe(`${oldLine}yy`);
    expect(over[0]).not.toMatch(/\u001b\[/);
    expect(over[1]).toBe(red("tail"));
  });

  it("resynchronizes EOL-boundary changes without normalizing untouched lines", () => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    const crossLeft = projectHighlightedSourceLines(
      "left\rnext", [red("left"), red("next")], "leftX\r\nnext",
    );
    expect(crossLeft).toEqual([expect.stringContaining("leftX"), red("next")]);
    expect(crossLeft[0]!.replace(/\u001b\[[0-9;]*m/g, "")).toBe("leftX");
    expect(crossLeft[1]).toBe(red("next"));

    const deletionCreatedCrlf = projectHighlightedSourceLines(
      "left\rX\nnext", [red("left"), red("X"), red("next")], "left\r\nnext",
    );
    expect(deletionCreatedCrlf).toEqual([red("left"), red("next")]);
    expect(deletionCreatedCrlf[0]).toBe(red("left"));
    expect(deletionCreatedCrlf[1]).toBe(red("next"));
  });

  it("falls back to a plain mismatched line while retaining the styled tail", () => {
    const source = ["old", "tail"];
    const projected = projectHighlightedSourceLineDelta(source, source, ["\u001b[1mwrong\u001b[0m", "\u001b[38;2;255;0;0mtail\u001b[0m"], delta({
      startOffset: 3, insertedText: "!",
      oldStart: { line: 0, column: 3 }, oldEnd: { line: 0, column: 3 },
      newStart: { line: 0, column: 3 }, newEnd: { line: 0, column: 4 },
      oldLineCount: 2, newLineCount: 2,
    }))!;

    expect(projected.highlightedLines).toEqual(["old!", "\u001b[38;2;255;0;0mtail\u001b[0m"]);
  });

  it("does not initialize while starting or filtering, then highlights exactly the selected buffer", async () => {
    const highlight = vi.fn(async (_path: string, text: string) => text.split("\n").map((line) => `\u001b[38;2;255;0;0m${line}\u001b[0m`));
    const workbench = await opened({ highlight });

    expect(workbench.repositoryTree.searchFiles("one")?.map((file) => file.path)).toEqual(["one.ts"]);
    expect(highlight).not.toHaveBeenCalled();

    await workbench.selectFile("one.ts");
    expect(highlight).toHaveBeenCalledExactlyOnceWith("one.ts", "const value = 1;\n\treturn value;");
    expect(workbench.highlightedLines).toEqual(["\u001b[38;2;255;0;0mconst value = 1;\u001b[0m", "\u001b[38;2;255;0;0m\treturn value;\u001b[0m"]);
  });

  it("falls back to sanitized plain source when highlighting is unavailable or fails", async () => {
    const workbench = await opened({ highlight: async () => { throw new Error("Shiki unavailable"); } });

    await expect(workbench.selectFile("two.txt")).resolves.toMatchObject({ status: "opened" });
    expect(workbench.highlightedLines).toEqual(["two�[31m"]);
  });

  it("falls back to the entire sanitized source when the exact refresh is invalid", async () => {
    const highlight = vi.fn(async (_path: string, text: string) => [`<${text}>`]);
    const workbench = await opened({ highlight });
    await workbench.selectFile("one.ts");

    workbench.replaceBuffer("changed\u001b[2J");
    expect(workbench.highlightedLines).toEqual(["changed�[2J"]);

    await workbench.save();
    expect(highlight).toHaveBeenLastCalledWith("one.ts", "changed\u001b[2J");
    expect(workbench.highlightedLines).toEqual(["changed�[2J"]);
  });

  it("keeps sanitized dirty source after a conflicted save rather than stale highlights", async () => {
    const highlight = vi.fn(async (_path: string, text: string) => [`<${text}>`]);
    const workbench = createWorkbench({ ...repository({ highlight }), saveText: async () => ({ status: "conflict", message: "changed outside" }) });
    await workbench.start();
    await workbench.selectFile("one.ts");
    workbench.replaceBuffer("dirty\u001b[2J");

    await expect(workbench.save()).resolves.toMatchObject({ status: "conflict" });
    expect(workbench.highlightedLines).toEqual(["dirty�[2J"]);
  });

  it("does not let an older asynchronous highlight overwrite a newer buffer", async () => {
    let resolveFirst!: (lines: readonly string[]) => void;
    const first = new Promise<readonly string[]>((resolve) => { resolveFirst = resolve; });
    const highlight = vi.fn((path: string) => path === "one.ts" ? first : Promise.resolve(["two�[31m"]));
    const workbench = await opened({ highlight });

    const openingOne = workbench.selectFile("one.ts");
    await Promise.resolve();
    const openingTwo = workbench.selectFile("two.txt");
    await openingTwo;
    resolveFirst(["one highlighted"]);
    await openingOne;

    expect(workbench.selectedPath).toBe("two.txt");
    expect(workbench.highlightedLines).toEqual(["two�[31m"]);
  });

  it("highlights TypeScript with real Shiki output", async () => {
    const lines = await createNodeShikiHighlighter().highlight("smoke.ts", "const value = 1;");
    const output = lines.join("\n");

    expect(output.replace(/\u001b\[[0-9;]*m/g, "")).toContain("const value = 1;");
    expect(output).toMatch(/\u001b\[[0-9;]+m/);
  });

  it("validates canonical Shiki styles against every exact source line", () => {
    const source = "🙂\tconst value = 1;\nreturn value;";
    const candidate = tokensToAnsi([
      [{ content: "🙂\t" }, { content: "const", color: "#ffffff", fontStyle: 7 }, { content: " value", color: "#123456", fontStyle: 2 }, { content: " = 1;", color: "#000000", fontStyle: 0 }],
      [{ content: "return", color: "#ff0000", fontStyle: 1 }, { content: " value;", color: "#00ff00", fontStyle: 0 }],
    ]);

    expect(validateHighlightedSourceLines(source, candidate)).toEqual(candidate);
    expect(validateHighlightedSourceLines(source, ["🙂\tconst value = 1;"])).toBeNull();
  });

  it.each([
    ["added text", ["source!"], "source"],
    ["removed text", ["sourc"], "source"],
    ["reordered text", ["ourcse"], "source"],
    ["missing line", ["one"], "one\ntwo"],
    ["extra line", ["one", "two", "three"], "one\ntwo"],
    ["reordered lines", ["two", "one"], "one\ntwo"],
    ["conceal", ["\u001b[8msecret\u001b[0m"], "secret"],
    ["background", ["\u001b[48;2;0;0;0msource\u001b[0m"], "source"],
    ["arbitrary color", ["\u001b[38;5;1msource\u001b[0m"], "source"],
    ["standalone reset", ["\u001b[0msource"], "source"],
    ["unclosed style", ["\u001b[1msource"], "source"],
    ["nested style", ["\u001b[1ms\u001b[3mt\u001b[0m"], "st"],
    ["odd params", ["\u001b[01msource\u001b[0m"], "source"],
    ["leading zero color", ["\u001b[38;2;00;1;2msource\u001b[0m"], "source"],
    ["out of range color", ["\u001b[38;2;256;0;0msource\u001b[0m"], "source"],
    ["reversed modes", ["\u001b[3;1msource\u001b[0m"], "source"],
    ["empty styled token", ["\u001b[1m\u001b[0m"], "source"],
    ["embedded controls", ["so\u001b[2Jurce"], "source"],
    ["oversized control overhead", [`\u001b[${"1;".repeat(5000)}m`], "source"],
  ] as const)("rejects $0", (_label, candidate, source) => {
    expect(validateHighlightedSourceLines(source, candidate)).toBeNull();
  });

  it("keeps real Shiki styles attached to edited text before and after an exact refresh", async () => {
    const highlighter = createNodeShikiHighlighter();
    const workbench = await opened(highlighter);
    await workbench.selectFile("one.ts");
    const edited = "const value = 2;\n\treturn value;";

    workbench.replaceBuffer(edited);
    const projected = workbench.highlightedLines!.join("\n");
    expect(projected.replace(/\u001b\[[0-9;]*m/g, "")).toBe(edited);
    expect(projected).toMatch(/\u001b\[[0-9;]+m/);

    await workbench.refreshHighlight();
    const refreshed = workbench.highlightedLines!.join("\n");
    expect(refreshed.replace(/\u001b\[[0-9;]*m/g, "")).toBe(edited);
    expect(refreshed).toMatch(/\u001b\[[0-9;]+m/);

    workbench.replaceBuffer("const value = 2;");
    expect(workbench.highlightedLines).toHaveLength(1);
    expect(workbench.highlightedLines![0]!.replace(/\u001b\[[0-9;]*m/g, "")).toBe("const value = 2;");
    expect(workbench.highlightedLines![0]).toMatch(/\u001b\[[0-9;]+m/);
  });

  it("renders only validated Shiki colors/styles and strips token control characters", () => {
    expect(tokensToAnsi([[{ content: "const", color: "#ff0080", fontStyle: 3 }, { content: "\u001b[2Jx", color: "not-a-color", fontStyle: 64 }]])).toEqual([
      "\u001b[1;3;38;2;255;0;128mconst\u001b[0m�[2Jx",
    ]);
    expect(validateHighlightedSourceLines("const�[2Jx", ["\u001b[1;3;38;2;255;0;128mconst\u001b[0m�[2Jx"])).toEqual([
      "\u001b[1;3;38;2;255;0;128mconst\u001b[0m�[2Jx",
    ]);
  });
});
