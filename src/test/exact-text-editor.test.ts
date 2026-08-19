import { describe, expect, it } from "vitest";
import { ExactTextEditor } from "../ui/exact-text-editor.js";

describe("ExactTextEditor", () => {
  it("preserves initial tabs, line endings, and outer whitespace", () => {
    const editor = new ExactTextEditor();
    const source = "\tfirst\r\n  second  \r\n";

    editor.setText(source, true);

    expect(editor.getText()).toBe(source);
    expect(editor.isSelectionArmed()).toBe(true);
  });

  it("replaces the armed initial selection on the first typed input", () => {
    const editor = new ExactTextEditor();
    editor.setText("  old()\n", true);

    editor.handleInput("n");
    editor.handleInput("ew()\n");

    expect(editor.getText()).toBe("new()\n");
    expect(editor.isSelectionArmed()).toBe(false);
  });

  it("replaces the armed selection with an exact bracketed paste", () => {
    const editor = new ExactTextEditor();
    editor.setText("old", true);

    editor.handleInput("\u001b[200~\tnew\r\n  child  \u001b[201~");

    expect(editor.getText()).toBe("\tnew\r\n  child  ");
  });

  it("keeps the original text when navigation disarms the selection", () => {
    const editor = new ExactTextEditor();
    editor.setText("value", true);

    editor.handleInput("\u001b[C");
    editor.handleInput("!");

    expect(editor.getText()).toBe("value!");
  });

  it("allows an armed selection to be deleted", () => {
    const editor = new ExactTextEditor();
    editor.setText("remove me", true);

    editor.handleInput("\u007f");

    expect(editor.getText()).toBe("");
  });
});
