import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { WorkbenchBufferEditor } from "../workbench/ui/buffer-editor.js";

function changed(editor: WorkbenchBufferEditor, input: string) {
  const result = editor.handleInput(input);
  expect(result.textChanged).toBe(true);
  expect(result.deltas).toHaveLength(1);
  return result.deltas![0]!;
}

describe("workbench buffer editor", () => {
  it("emits exact UTF-16 edit deltas for insertion, deletion, newline, astral text, paste, and undo", () => {
    const editor = new WorkbenchBufferEditor("a🙂\r\nb", { selectedLine: 1 });
    const insertion = changed(editor, "!");
    expect(insertion).toMatchObject({
      startOffset: 3, deletedText: "", insertedText: "!",
      oldStart: { line: 0, column: 3 }, oldEnd: { line: 0, column: 3 },
      newStart: { line: 0, column: 3 }, newEnd: { line: 0, column: 4 },
      oldLineCount: 2, newLineCount: 2,
    });

    editor.handleInput("\x1b[D");
    expect(changed(editor, "\x7f")).toMatchObject({ startOffset: 1, deletedText: "🙂", insertedText: "" });
    expect(changed(editor, "\r")).toMatchObject({ deletedText: "", insertedText: "\r\n", oldStart: { line: 0, column: 1 }, newEnd: { line: 1, column: 0 } });
    expect(changed(editor, "\x1b[200~x\n\ty\x1b[201~")).toMatchObject({ deletedText: "", insertedText: "x\n\ty", oldLineCount: 3, newLineCount: 4 });

    const undo = changed(editor, "\x1a");
    expect(undo.deletedText).toBe("x\n\ty");
    expect(undo.insertedText).toBe("");
    expect(editor.getText()).toBe("a\r\n!\r\nb");
    expect(editor.getLineCount()).toBe(3);
  });

  it("carries multiple ordered deltas from one input chunk", () => {
    const editor = new WorkbenchBufferEditor("", { selectedLine: 1 });
    const result = editor.handleInput("\x1b[200~x\x1b[201~!");

    expect(result.deltas).toHaveLength(2);
    expect(result.deltas![0]).toMatchObject({ startOffset: 0, deletedText: "", insertedText: "x" });
    expect(result.deltas![1]).toMatchObject({ startOffset: 1, deletedText: "", insertedText: "!" });
    expect(editor.getText()).toBe("x!");
  });

  it("reports LF joins and exact word deletion deltas", () => {
    const lines = new WorkbenchBufferEditor("a\nb", { selectedLine: 2 });
    lines.handleInput("\x1b[H");
    expect(changed(lines, "\x7f")).toMatchObject({ deletedText: "\n", oldStart: { line: 0, column: 1 }, oldEnd: { line: 1, column: 0 } });
    expect(lines.getText()).toBe("ab");

    const words = new WorkbenchBufferEditor("alpha beta", { selectedLine: 1 });
    expect(changed(words, "\x17")).toMatchObject({ startOffset: 6, deletedText: "beta", insertedText: "" });
  });

  it("keeps CRLF indivisible in forward deletion and reports incremental UTF-8 bytes", () => {
    const editor = new WorkbenchBufferEditor("a\r\n🙂", { selectedLine: 1 });
    expect(editor.getByteCount()).toBe(7);
    const delta = changed(editor, "\x1b[3~");
    expect(delta).toMatchObject({ startOffset: 1, deletedText: "\r\n", insertedText: "", oldLineCount: 2, newLineCount: 1 });
    expect(editor.getText()).toBe("a🙂");
    expect(editor.getByteCount()).toBe(5);
  });

  it("preserves exact mixed EOL bytes and starts at the selected logical line end", () => {
    const editor = new WorkbenchBufferEditor("one\r\ntwo\rthree\nfour\n", { selectedLine: 2 });

    expect(editor.getText()).toBe("one\r\ntwo\rthree\nfour\n");
    expect(editor.getCursor().offset).toBe(8);
    editor.handleInput("!");

    expect(editor.getText()).toBe("one\r\ntwo!\rthree\nfour\n");
  });

  it("inserts multiline bracketed paste atomically while retaining tabs and EOL form", () => {
    const editor = new WorkbenchBufferEditor("start\r\n", { selectedLine: 1 });

    expect(editor.handleInput("\x1b[200~one\t\r\ntwo\rthree\n\u0007\x1b[201~")).toMatchObject({ handled: true, textChanged: true, cursorChanged: true });
    expect(editor.getText()).toBe("startone\t\r\ntwo\rthree\n\r\n");
    editor.handleInput("\x1a");
    expect(editor.getText()).toBe("start\r\n");
  });

  it("navigates and deletes across whole EOL terminators, supports local Enter and undo", () => {
    const editor = new WorkbenchBufferEditor("a\r\nb\rc\n", { selectedLine: 2 });

    editor.handleInput("\x1b[D");
    editor.handleInput("\x7f");
    expect(editor.getText()).toBe("ab\rc\n");
    editor.handleInput("\x1a");
    expect(editor.getText()).toBe("a\r\nb\rc\n");
    editor.handleInput("\x1b[F");
    editor.handleInput("\r");
    expect(editor.getText()).toBe("a\r\nb\r\rc\n");
  });

  it("accepts Kitty printable input and keeps grapheme word edits safe", () => {
    const editor = new WorkbenchBufferEditor("x 👩‍💻 word", { selectedLine: 1 });

    editor.handleInput("\x1b[233u");
    expect(editor.getText()).toBe("x 👩‍💻 wordé");
    editor.handleInput("\x7f");
    editor.handleInput("\x1b[H");
    editor.handleInput("\x1b[C");
    editor.handleInput("\x1b[C");
    editor.handleInput("\x1b[C");
    editor.handleInput("\x7f");
    expect(editor.getText()).toBe("x  word");
    editor.handleInput("\x1b[F");
    editor.handleInput("\x17");
    expect(editor.getText()).toBe("x  ");
  });

  it("preserves preferred visual column across wrapped tab and wide-grapheme rows", () => {
    const editor = new WorkbenchBufferEditor("\t🙂abc\n\t🙂z\n", { selectedLine: 1, tabWidth: 4 });
    editor.handleInput("\x1b[F");
    editor.handleInput("\x1b[B");

    expect(editor.getCursor().offset).toBe("\t🙂abc\n\t🙂z".length);
  });

  it("exposes raw cursor line/column metadata and a focused inverse caret", () => {
    const editor = new WorkbenchBufferEditor("a\r\nb🙂", { selectedLine: 2 });

    expect(editor.getCursor()).toEqual({ offset: 6, line: 1, column: 3 });
    const unfocused = editor.render(8, 2).find((row) => row.hasCursor)!;
    expect(unfocused.cursorColumn).toBe(3);
    expect(unfocused.text).toContain("\u001b[7m \u001b[27m");
    expect(unfocused.text).not.toContain("\x1b_pi:c\u0007");

    editor.focused = true;
    const focused = editor.render(8, 2).find((row) => row.hasCursor)!;
    expect(focused.text).toContain("\x1b_pi:c\u0007\u001b[7m \u001b[27m");
    expect(editor.render(8)).toContain(focused.text);
  });

  it("renders validated syntax styles through wrapping and the inverse cursor", () => {
    const editor = new WorkbenchBufferEditor("const\tvalue", { selectedLine: 1, tabWidth: 4 });
    editor.focused = true;
    const highlighted = ["\u001b[1mconst\u001b[0m\t\u001b[3mvalue\u001b[0m"];

    const styled = editor.renderRows(6, 10, highlighted).map((row) => row.text).join("\n");
    expect(styled).toContain("\u001b[1m");
    expect(styled).toContain("\u001b[3m");
    expect(styled).toContain("\u001b[7m [27m");
    expect(styled).not.toContain("⇥");
    expect(editor.getText()).toBe("const\tvalue");
    expect(editor.renderRows(6, 10, highlighted).every((row) => visibleWidth(row.text) <= 6)).toBe(true);

    const mismatched = editor.renderRows(20, 2, ["\u001b[31mevil\u001b[0m"]).map((row) => row.text).join("\n");
    expect(mismatched).not.toContain("evil");
    expect(mismatched).not.toContain("\u001b[31m");
    expect(mismatched).toContain("const");
  });

  it("moves through soft-wrapped visual rows with a sticky visual column", () => {
    const editor = new WorkbenchBufferEditor("abcdefgh\nxy\n\t🙂z", { selectedLine: 1, tabWidth: 4 });
    editor.handleInput("\x1b[H");
    editor.handleInput("\x1b[C");
    editor.handleInput("\x1b[C");
    editor.render(3, 4); // establishes the last allocated source width

    editor.handleInput("\x1b[B");
    expect(editor.getCursor()).toEqual({ offset: 5, line: 0, column: 5 });
    editor.handleInput("\x1b[B");
    expect(editor.getCursor()).toEqual({ offset: 8, line: 0, column: 8 });
    editor.handleInput("\x1b[B");
    expect(editor.getCursor()).toEqual({ offset: 11, line: 1, column: 2 });
    editor.handleInput("\x1b[B");
    expect(editor.getCursor()).toEqual({ offset: 13, line: 2, column: 1 }); // tab/wide glyph chooses the nearest cell boundary
  });

  it("uses pi-tui key matching and restores the original cursor after word deletion undo", () => {
    const editor = new WorkbenchBufferEditor("alpha beta", { selectedLine: 1 });
    expect(editor.handleInput("\x1bOA")).toMatchObject({ handled: true }); // SS3 legacy up
    expect(editor.handleInput("\x1b\x7f")).toMatchObject({ handled: true, textChanged: true }); // legacy Alt+Backspace
    expect(editor.getText()).toBe("alpha ");
    editor.handleInput("\x1a"); // legacy Ctrl+Z
    expect(editor.getText()).toBe("alpha beta");
    expect(editor.getCursor()).toEqual({ offset: 10, line: 0, column: 10 });

    const variants = new WorkbenchBufferEditor("ab", { selectedLine: 1 });
    variants.handleInput("\x1b[7~"); // rxvt Home
    expect(variants.getCursor().column).toBe(0);
    variants.handleInput("\x1bOF"); // SS3 End
    expect(variants.getCursor().column).toBe(2);
    variants.handleInput("\x1b[H");
    expect(variants.handleInput("\x1b[3~")).toMatchObject({ handled: true, textChanged: true });
    expect(variants.getText()).toBe("b");
  });

  it("moves across code-word boundaries and extends or collapses a selection", () => {
    const editor = new WorkbenchBufferEditor("alpha.beta gamma", { selectedLine: 1 });

    editor.handleInput("\x1b[1;3D"); // Option+Left
    expect(editor.getCursor().offset).toBe(11);
    expect(editor.getSelection()).toBeNull();

    editor.handleInput("\x1b[1;4D"); // Option+Shift+Left
    expect(editor.getSelection()).toEqual({ start: 6, end: 11, text: "beta " });
    editor.handleInput("\x1b[1;4D");
    expect(editor.getSelection()).toEqual({ start: 5, end: 11, text: ".beta " });
    editor.handleInput("\x1b[1;2D"); // Shift+Left
    expect(editor.getSelection()).toEqual({ start: 4, end: 11, text: "a.beta " });

    editor.handleInput("\x1b[C"); // unmodified Right collapses to the selection end
    expect(editor.getCursor().offset).toBe(11);
    expect(editor.getSelection()).toBeNull();
    editor.handleInput("\x1b[1;2C"); // Shift+Right selects one grapheme
    expect(editor.getSelection()).toEqual({ start: 11, end: 12, text: "g" });
  });

  it("treats tmux CSI-u Option+B/F identities as word arrows", () => {
    const editor = new WorkbenchBufferEditor("alpha beta", { selectedLine: 1 });

    editor.handleInput("\x1b[98;3u"); // Option+Left arrives through tmux as Alt+B
    expect(editor.getCursor().offset).toBe(6);
    editor.handleInput("\x1b[98;4u"); // Option+Shift+Left arrives as Shift+Alt+B
    expect(editor.getSelection()).toEqual({ start: 0, end: 6, text: "alpha " });
    editor.handleInput("\x1b[102;3u");
    expect(editor.getSelection()).toBeNull();
    expect(editor.getCursor().offset).toBe(6);
    editor.handleInput("\x1b[102;3u");
    expect(editor.getCursor().offset).toBe(10);
  });

  it("extends vertical selections across exact EOLs and never splits a grapheme", () => {
    const lines = new WorkbenchBufferEditor("one\r\ntwo\r\nthree", { selectedLine: 2 });
    lines.handleInput("\x1b[1;2A");
    expect(lines.getSelection()).toEqual({ start: 3, end: 8, text: "\r\ntwo" });
    lines.handleInput("\x1b[1;2B");
    expect(lines.getSelection()).toBeNull();
    lines.handleInput("\x1b[1;2B");
    expect(lines.getSelection()).toEqual({ start: 8, end: 13, text: "\r\nthr" });

    const grapheme = new WorkbenchBufferEditor("a👩‍💻", { selectedLine: 1 });
    grapheme.handleInput("\x1b[1;2D");
    expect(grapheme.getSelection()).toEqual({ start: 1, end: 6, text: "👩‍💻" });
  });

  it("replaces selections atomically and restores the selected range on undo", () => {
    const editor = new WorkbenchBufferEditor("one\r\nsecond\r\nthree", { selectedLine: 2 });

    editor.handleInput("\x1b[1;2H"); // Shift+Home
    expect(editor.getSelection()).toEqual({ start: 5, end: 11, text: "second" });
    expect(changed(editor, "2")).toMatchObject({ startOffset: 5, deletedText: "second", insertedText: "2" });
    expect(editor.getText()).toBe("one\r\n2\r\nthree");
    expect(editor.getSelection()).toBeNull();

    changed(editor, "\x1a");
    expect(editor.getText()).toBe("one\r\nsecond\r\nthree");
    expect(editor.getSelection()).toEqual({ start: 5, end: 11, text: "second" });
    expect(changed(editor, "\x1b[200~two\nlines\x1b[201~")).toMatchObject({
      startOffset: 5, deletedText: "second", insertedText: "two\nlines",
    });
    expect(editor.getText()).toBe("one\r\ntwo\nlines\r\nthree");
  });

  it("supports select-all plus exact public cut and paste operations", () => {
    const editor = new WorkbenchBufferEditor("alpha\r\nbeta", { selectedLine: 2 });

    editor.handleInput("\x1b[97;9u"); // Command+A via Kitty
    expect(editor.getSelection()).toEqual({ start: 0, end: 11, text: "alpha\r\nbeta" });
    expect(editor.deleteSelection()).toMatchObject({
      handled: true, textChanged: true,
      deltas: [{ startOffset: 0, deletedText: "alpha\r\nbeta", insertedText: "" }],
    });
    expect(editor.getText()).toBe("");

    editor.handleInput("\x1a");
    expect(editor.getSelection()?.text).toBe("alpha\r\nbeta");
    expect(editor.insertText("replacement")).toMatchObject({
      handled: true, textChanged: true,
      deltas: [{ startOffset: 0, deletedText: "alpha\r\nbeta", insertedText: "replacement" }],
    });
    expect(editor.getText()).toBe("replacement");
  });

  it("renders every selected grapheme without dropping validated syntax styles", () => {
    const editor = new WorkbenchBufferEditor("value", { selectedLine: 1 });
    editor.focused = true;
    editor.handleInput("\x1b[1;2D");
    editor.handleInput("\x1b[1;2D");
    editor.handleInput("\x1b[1;2D");

    const row = editor.renderRows(12, 1, ["\u001b[1mvalue\u001b[0m"])[0]!.text;
    expect(row.match(/\u001b\[7m/g)).toHaveLength(3);
    expect(row).toContain("\u001b[1m");
    expect(visibleWidth(row)).toBe(12);
  });

  it("renders bounded rows and metadata without mutating a large buffer", () => {
    const text = `\t🙂alpha\r\nbeta\r${"long ".repeat(50)}\n${"x\n".repeat(500)}`;
    const editor = new WorkbenchBufferEditor(text, { selectedLine: 3 });
    const before = { text: editor.getText(), cursor: editor.getCursor().offset };

    for (const rows of [0, 1, 3]) {
      for (const width of [0, 1, 2, 8]) {
        const rendered = editor.render(width, rows);
        expect(rendered.length).toBeLessThanOrEqual(rows);
        expect(rendered.every((row) => visibleWidth(row.text) <= width)).toBe(true);
        expect(rendered.every((row) => Number.isInteger(row.logicalLine) && typeof row.continuation === "boolean" && typeof row.hasCursor === "boolean")).toBe(true);
      }
    }
    expect(editor.render(10, 3).some((row) => row.hasCursor)).toBe(true);
    expect(editor.getText()).toBe(before.text);
    expect(editor.getCursor().offset).toBe(before.cursor);
  });

  it("constructs only a bounded visual-row neighborhood for a large file", () => {
    const editor = new WorkbenchBufferEditor(`${"x\n".repeat(25_000)}${"abcdefgh ".repeat(2_000)}`, { selectedLine: 25_001 });
    const rows = editor.renderRows(4, 5);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(editor.getLastRenderStats().constructedRows).toBeLessThanOrEqual(10);
  });

  it("enforces the max byte limit atomically for multibyte typing and paste", () => {
    const exact = new WorkbenchBufferEditor("", { maxBytes: 4096 });
    const exactPaste = `\x1b[200~${"🙂".repeat(1024)}\x1b[201~`;

    expect(exact.handleInput(exactPaste)).toMatchObject({ handled: true, textChanged: true, cursorChanged: true });
    expect(Buffer.byteLength(exact.getText(), "utf8")).toBe(4096);
    expect(exact.handleInput("x")).toEqual({ handled: true, textChanged: false, cursorChanged: false });
    expect(Buffer.byteLength(exact.getText(), "utf8")).toBe(4096);

    const oversized = new WorkbenchBufferEditor("", { maxBytes: 4096 });
    expect(oversized.handleInput(`\x1b[200~${"🙂".repeat(1024)}x\x1b[201~`)).toEqual({ handled: true, textChanged: false, cursorChanged: false });
    expect(oversized.getText()).toBe("");
  });
});
