import { describe, expect, it, vi } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import type { SaveTextResult, WorkbenchRepository } from "../workbench/contracts.js";
import { WorkbenchBufferEditor } from "../workbench/ui/buffer-editor.js";
import { projectHighlightedSourceLineDelta } from "../workbench/highlight.js";

function createRepository(files: Record<string, { text: string; revision: string }>, saveText?: WorkbenchRepository["saveText"]): WorkbenchRepository {
  const save = saveText ?? vi.fn<WorkbenchRepository["saveText"]>(async (_path, text) => ({ status: "success", effect: "saved", revision: `revision:${text}` }));
  return {
    listFiles: async () => `${Object.keys(files).join("\0")}\0`,
    readText: async (path) => files[path]!,
    saveText: save,
    maxReadBytes: 1024,
  };
}

async function openWorkbench(repository: WorkbenchRepository, path = "one.ts") {
  const workbench = createWorkbench(repository);
  await workbench.start();
  await workbench.selectFile(path);
  return workbench;
}

describe("workbench source editing", () => {
  it("applies editor deltas exactly while preserving untouched colors and line counts", async () => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    const text = "first\r\nsecond\n🙂";
    const repository = createRepository({ "one.ts": { text, revision: "r1" } });
    repository.sourceHighlighter = { highlight: async (_path, source) => source.split(/\r\n|\r|\n/).map(red) };
    const workbench = await openWorkbench(repository);
    const editor = new WorkbenchBufferEditor(text, { selectedLine: 2 });
    const untouched = workbench.highlightedLines![0];
    const apply = (input: string) => {
      const update = editor.handleInput(input);
      expect(update.deltas).toBeDefined();
      workbench.applyBufferDeltas(update.deltas!, editor.getCursor().line + 1);
    };

    apply("!");
    apply("\r");
    apply("\x1b[200~x\n\ty\x1b[201~");
    expect(workbench.bufferText).toBe(editor.getText());
    expect(workbench.highlightedLines).toHaveLength(editor.getLineCount());
    expect(workbench.selectedLine).toBe(editor.getCursor().line + 1);
    expect(workbench.highlightedLines![0]).toBe(untouched);

    apply("\x1a");
    expect(workbench.bufferText).toBe(editor.getText());
    expect(workbench.highlightedLines).toHaveLength(editor.getLineCount());
    expect(workbench.highlightedLines!.join("\n").replace(/\u001b\[[0-9;]*m/g, "")).toBe(editor.getText().replace(/\r\n|\r/g, "\n"));
  });

  it("bounds whole resync after a CR-before-LF editor delta rejection", async () => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    const first = "x".repeat(6_000);
    const text = `${first}\nnext`;
    const repository = createRepository({ "one.ts": { text, revision: "r1" } });
    repository.sourceHighlighter = { highlight: async (_path, source) => source.split(/\r\n|\r|\n/).map(red) };
    const workbench = await openWorkbench(repository);
    const untouched = workbench.highlightedLines![1];
    const editor = new WorkbenchBufferEditor(text, { selectedLine: 1 });
    const update = editor.handleInput(`\x1b[200~${"Y".repeat(6_000)}\r\x1b[201~`);
    expect(update.deltas).toHaveLength(1);

    let rejected = false;
    try {
      workbench.applyBufferDeltas(update.deltas!, editor.getCursor().line + 1);
    } catch {
      rejected = true;
      workbench.replaceBuffer(editor.getText(), editor.getCursor().line + 1);
    }

    expect(rejected).toBe(true);
    expect(workbench.bufferText).toBe(`${first}${"Y".repeat(6_000)}\r\nnext`);
    expect(workbench.highlightedLines).toHaveLength(2);
    expect(workbench.highlightedLines![0]).toBe(`${first}${"Y".repeat(6_000)}`);
    expect(workbench.highlightedLines![0]).not.toMatch(/\u001b\[/);
    expect(workbench.highlightedLines![1]).toBe(untouched);
  });

  it("preflights a 25,000-LF bracketed paste before style allocation and keeps outside colors", async () => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    const text = "a\noutside";
    const repository = createRepository({ "one.ts": { text, revision: "r1" } });
    repository.sourceHighlighter = { highlight: async (_path, source) => source.split("\n").map(red) };
    const workbench = await openWorkbench(repository);
    const editor = new WorkbenchBufferEditor(text, { selectedLine: 1 });
    const update = editor.handleInput(`\x1b[200~${"\n".repeat(25_000)}\x1b[201~`);
    expect(update.deltas).toHaveLength(1);
    const delta = update.deltas![0]!;
    const projection = projectHighlightedSourceLineDelta(
      ["a", "outside"], ["a", "outside"], [red("a"), red("outside")], delta,
    )!;

    expect(projection.stats).toMatchObject({
      affectedOldLines: 1, affectedNewLines: 25_001,
      plannedStyleSlots: 25_003,
      allocatedStyleSlots: 0, parsedStyleCodeUnits: 0, renderedCodeUnits: 0,
      sanitizedCodeUnits: 0, budgetExceeded: true,
    });
    workbench.applyBufferDeltas(update.deltas!, editor.getCursor().line + 1);
    expect(workbench.bufferText).toBe(editor.getText());
    expect(workbench.highlightedLines).toHaveLength(editor.getLineCount());
    expect(workbench.highlightedLines!.slice(0, 25_001)).toEqual(["a", ...Array.from({ length: 25_000 }, () => "")]);
    expect(workbench.highlightedLines![25_001]).toBe(red("outside"));
  });

  it("keeps untouched colors when an over-budget edited line becomes exact plain text", async () => {
    const red = (text: string) => `\u001b[38;2;255;0;0m${text}\u001b[0m`;
    const text = `colored\n${"x".repeat(255 * 1024)}`;
    const repository = createRepository({ "one.ts": { text, revision: "r1" } });
    repository.sourceHighlighter = { highlight: async (_path, source) => source.split("\n").map(red) };
    const workbench = await openWorkbench(repository);
    const editor = new WorkbenchBufferEditor(text, { selectedLine: 2 });
    const update = editor.handleInput("!");

    workbench.applyBufferDeltas(update.deltas!, 2);

    expect(workbench.bufferText).toBe(editor.getText());
    expect(workbench.highlightedLines).toHaveLength(2);
    expect(workbench.highlightedLines![0]).toBe(red("colored"));
    expect(workbench.highlightedLines![1]).toBe(`${"x".repeat(255 * 1024)}!`);
  });

  it("atomically derives ordered deltas and rejects tampering without partial commits", async () => {
    const workbench = await openWorkbench(createRepository({ "one.ts": { text: "abc\ndef", revision: "r1" } }));
    const first = { startOffset: 0, deletedText: "", insertedText: "X", oldStart: { line: 0, column: 0 }, oldEnd: { line: 0, column: 0 }, newStart: { line: 0, column: 0 }, newEnd: { line: 0, column: 1 }, oldLineCount: 2, newLineCount: 2 };
    const second = { startOffset: 5, deletedText: "d", insertedText: "D", oldStart: { line: 1, column: 0 }, oldEnd: { line: 1, column: 1 }, newStart: { line: 1, column: 0 }, newEnd: { line: 1, column: 1 }, oldLineCount: 2, newLineCount: 2 };
    workbench.applyBufferDeltas([first, second]);
    expect(workbench.bufferText).toBe("Xabc\nDef");
    expect(workbench.highlightedLines!.join("\n").replace(/\u001b\[[0-9;]*m/g, "")).toBe("Xabc\nDef");

    const before = workbench.bufferText;
    expect(() => workbench.applyBufferDeltas([{ ...first, oldLineCount: 2 }, { ...second, startOffset: 99 }])).toThrow("Invalid buffer delta batch.");
    expect(workbench.bufferText).toBe(before);
    expect(() => workbench.applyBufferDeltas([{ ...first, startOffset: 1, deletedText: "" }])).toThrow("Invalid buffer delta batch.");
    expect(() => workbench.applyBufferDeltas([{ ...first, startOffset: 0, insertedText: "", deletedText: "X", oldStart: { line: 0, column: 0 }, oldEnd: { line: 0, column: 1 }, newStart: { line: 0, column: 0 }, newEnd: { line: 0, column: 0 } }])).not.toThrow();
  });

  it("tracks exact buffer edits and becomes clean when the original text is restored", async () => {
    const workbench = await openWorkbench(createRepository({ "one.ts": { text: "const one = 1;\r\n\treturn one;\r\n", revision: "r1" } }));

    workbench.replaceBuffer("const one = 2;\r\n\treturn one;\r\n");
    expect(workbench.bufferText).toBe("const one = 2;\r\n\treturn one;\r\n");
    expect(workbench.isDirty).toBe(true);

    workbench.replaceBuffer("const one = 1;\r\n\treturn one;\r\n");
    expect(workbench.isDirty).toBe(false);
  });

  it("treats an identical whole-buffer replacement as a true no-op", async () => {
    const text = "first\r\n\tsecond\r\nthird";
    const workbench = await openWorkbench(createRepository({ "one.ts": { text, revision: "r1" } }));
    const highlighted = workbench.highlightedLines;

    workbench.replaceBuffer(text);

    expect(workbench.bufferText).toBe(text);
    expect(workbench.highlightedLines).toBe(highlighted);
    expect(workbench.isDirty).toBe(false);
  });

  it("saves a dirty buffer and refreshes the revision only after success", async () => {
    const saveText = vi.fn<WorkbenchRepository["saveText"]>(async () => ({ status: "success", effect: "saved", revision: "r2" }));
    const workbench = await openWorkbench(createRepository({ "one.ts": { text: "old", revision: "r1" } }, saveText));
    workbench.replaceBuffer("new");

    await expect(workbench.save()).resolves.toEqual({ status: "success", effect: "saved", revision: "r2" });

    expect(saveText).toHaveBeenCalledExactlyOnceWith("one.ts", "new", "r1");
    expect(workbench.selectedRevision).toBe("r2");
    expect(workbench.isDirty).toBe(false);
    expect(workbench.changedPaths).toEqual(["one.ts"]);
  });

  it("treats a cleanup warning as committed success and refreshes clean revision state", async () => {
    const saveText = vi.fn<WorkbenchRepository["saveText"]>(async () => ({
      status: "success", effect: "saved", revision: "r2", warning: "Saved, but temporary cleanup failed.",
    }));
    const workbench = await openWorkbench(createRepository({ "one.ts": { text: "old", revision: "r1" } }, saveText));
    workbench.replaceBuffer("new");

    await expect(workbench.save()).resolves.toEqual({
      status: "success", effect: "saved", revision: "r2", warning: "Saved, but temporary cleanup failed.",
    });
    expect(workbench.selectedRevision).toBe("r2");
    expect(workbench.isDirty).toBe(false);
    expect(workbench.changedPaths).toEqual(["one.ts"]);
  });

  it.each<SaveTextResult>([
    { status: "conflict", message: "File changed outside the workbench." },
    { status: "error", message: "Atomic replacement failed." },
  ])("keeps the buffer dirty and the loaded revision after a $status save", async (result) => {
    const saveText = vi.fn<WorkbenchRepository["saveText"]>(async () => result);
    const workbench = await openWorkbench(createRepository({ "one.ts": { text: "old", revision: "r1" } }, saveText));
    workbench.replaceBuffer("unsaved");

    await expect(workbench.save()).resolves.toEqual(result);

    expect(workbench.bufferText).toBe("unsaved");
    expect(workbench.selectedRevision).toBe("r1");
    expect(workbench.isDirty).toBe(true);
    expect(workbench.changedPaths).toEqual([]);
  });

  it("verifies a no-op save but reports it unchanged without recording a changed path", async () => {
    const saveText = vi.fn<WorkbenchRepository["saveText"]>(async () => ({ status: "success", effect: "unchanged", revision: "r1" }));
    const workbench = await openWorkbench(createRepository({ "one.ts": { text: "same", revision: "r1" } }, saveText));

    await expect(workbench.save()).resolves.toEqual({ status: "success", effect: "unchanged", revision: "r1" });
    expect(saveText).toHaveBeenCalledExactlyOnceWith("one.ts", "same", "r1");
    expect(workbench.changedPaths).toEqual([]);
  });

  it("cannot open or save a path absent from the repository listing", async () => {
    const saveText = vi.fn<WorkbenchRepository["saveText"]>();
    const workbench = createWorkbench(createRepository({ "listed.ts": { text: "listed", revision: "r1" } }, saveText));
    await workbench.start();

    await expect(workbench.selectFile("missing.ts")).rejects.toThrow("not in the repository listing");
    expect(workbench.selectedPath).toBeNull();
    expect(saveText).not.toHaveBeenCalled();
  });
});

describe("workbench dirty navigation guard", () => {
  it.each(["save", "discard", "cancel"] as const)("handles file-switch %s explicitly", async (choice) => {
    const repository = createRepository({
      "one.ts": { text: "one", revision: "r1" },
      "two.ts": { text: "two", revision: "r2" },
    });
    const workbench = await openWorkbench(repository);
    workbench.replaceBuffer("changed one");

    await expect(workbench.selectFile("two.ts")).resolves.toEqual({
      status: "confirmation-required",
      action: "switch",
      targetPath: "two.ts",
    });
    const result = await workbench.resolveDirtyChoice(choice);

    if (choice === "cancel") {
      expect(result).toEqual({ status: "cancelled", action: "switch", changedPaths: [] });
      expect(workbench.selectedPath).toBe("one.ts");
      expect(workbench.bufferText).toBe("changed one");
      expect(workbench.isDirty).toBe(true);
    } else {
      expect(result).toEqual({ status: "opened", path: "two.ts", line: 1, changedPaths: choice === "save" ? ["one.ts"] : [] });
      expect(workbench.selectedPath).toBe("two.ts");
      expect(workbench.bufferText).toBe("two");
      expect(workbench.isDirty).toBe(false);
    }
  });

  it.each(["save", "discard", "cancel"] as const)("handles exit %s explicitly", async (choice) => {
    const workbench = await openWorkbench(createRepository({ "one.ts": { text: "one", revision: "r1" } }));
    workbench.replaceBuffer("changed one");

    expect(workbench.requestExit()).toEqual({ status: "confirmation-required", action: "exit" });
    const result = await workbench.resolveDirtyChoice(choice);

    if (choice === "cancel") {
      expect(result).toEqual({ status: "cancelled", action: "exit", changedPaths: [] });
      expect(workbench.bufferText).toBe("changed one");
      expect(workbench.isDirty).toBe(true);
    } else {
      expect(result).toEqual({ status: "closed", changedPaths: choice === "save" ? ["one.ts"] : [] });
      expect(workbench.isDirty).toBe(false);
    }
  });

  it("continues a warned Save-to-switch but keeps a warned Save-to-exit open for acknowledgement", async () => {
    const warning = "Saved, but temporary cleanup failed.";
    const repository = createRepository({
      "one.ts": { text: "one", revision: "r1" },
      "two.ts": { text: "two", revision: "r2" },
    }, async () => ({ status: "success", effect: "saved", revision: "saved", warning }));
    const workbench = await openWorkbench(repository);
    workbench.replaceBuffer("changed one");

    await workbench.selectFile("two.ts");
    await expect(workbench.resolveDirtyChoice("save")).resolves.toEqual({
      status: "opened", path: "two.ts", line: 1, changedPaths: ["one.ts"], warning,
    });
    expect(workbench.selectedPath).toBe("two.ts");
    expect(workbench.isDirty).toBe(false);

    workbench.replaceBuffer("changed two");
    expect(workbench.requestExit()).toEqual({ status: "confirmation-required", action: "exit" });
    await expect(workbench.resolveDirtyChoice("save")).resolves.toEqual({
      status: "warning", action: "exit", warning, changedPaths: ["one.ts", "two.ts"],
    });
    expect(workbench.pendingAction).toBeNull();
    expect(workbench.isDirty).toBe(false);
    expect(workbench.requestExit()).toEqual({ status: "closed", changedPaths: ["one.ts", "two.ts"] });
  });

  it("keeps a failed save dirty and keeps the pending action available", async () => {
    const saveText = vi.fn<WorkbenchRepository["saveText"]>(async () => ({ status: "conflict", message: "external change" }));
    const workbench = await openWorkbench(createRepository({ "one.ts": { text: "one", revision: "r1" } }, saveText));
    workbench.replaceBuffer("changed");
    expect(workbench.requestExit()).toEqual({ status: "confirmation-required", action: "exit" });

    await expect(workbench.resolveDirtyChoice("save")).resolves.toEqual({
      status: "save-failed",
      action: "exit",
      save: { status: "conflict", message: "external change" },
      changedPaths: [],
    });
    expect(workbench.pendingAction).toEqual({ action: "exit" });
    expect(workbench.isDirty).toBe(true);
  });

});
