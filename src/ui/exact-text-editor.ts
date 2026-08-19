import { Key, matchesKey } from "@earendil-works/pi-tui";

interface EditorSnapshot {
  text: string;
  cursor: number;
  selectionArmed: boolean;
}

export interface ExactTextEditorView {
  lines: string[];
  cursorLine: number;
  cursorColumn: number;
  selectionArmed: boolean;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export class ExactTextEditor {
  private text = "";
  private cursor = 0;
  private selectionArmed = false;
  private pasteBuffer = "";
  private isInPaste = false;
  private undoStack: EditorSnapshot[] = [];

  setText(text: string, selectAll = false): void {
    this.text = text;
    this.cursor = text.length;
    this.selectionArmed = selectAll && text.length > 0;
    this.pasteBuffer = "";
    this.isInPaste = false;
    this.undoStack = [];
  }

  getText(): string {
    return this.text;
  }

  isSelectionArmed(): boolean {
    return this.selectionArmed;
  }

  getView(): ExactTextEditorView {
    const beforeCursor = this.text.slice(0, this.cursor);
    const linesBeforeCursor = beforeCursor.split("\n");
    return {
      lines: this.text.split("\n"),
      cursorLine: linesBeforeCursor.length - 1,
      cursorColumn: linesBeforeCursor.at(-1)?.length ?? 0,
      selectionArmed: this.selectionArmed,
    };
  }

  handleInput(data: string): void {
    if (this.consumeBracketedPaste(data)) return;

    if (matchesKey(data, Key.ctrl("a"))) {
      this.selectionArmed = this.text.length > 0;
      this.cursor = this.text.length;
      return;
    }
    if (matchesKey(data, Key.ctrl("z"))) {
      this.undo();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.moveHorizontally(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.moveHorizontally(1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveVertically(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveVertically(1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.disarmSelection("start");
      this.cursor = this.lineStart(this.cursor);
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.disarmSelection("end");
      this.cursor = this.lineEnd(this.cursor);
      return;
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.shift("backspace"))) {
      this.deleteBackward();
      return;
    }
    if (matchesKey(data, Key.delete)) {
      this.deleteForward();
      return;
    }
    if (data.length > 0 && !data.startsWith("\u001b") && data !== "\u0000") {
      this.insert(data);
    }
  }

  private consumeBracketedPaste(data: string): boolean {
    const startIndex = data.indexOf(PASTE_START);
    if (!this.isInPaste && startIndex < 0) return false;

    if (!this.isInPaste) {
      const prefix = data.slice(0, startIndex);
      if (prefix.length > 0) this.handleInput(prefix);
      this.isInPaste = true;
      this.pasteBuffer = data.slice(startIndex + PASTE_START.length);
    } else {
      this.pasteBuffer += data;
    }

    const endIndex = this.pasteBuffer.indexOf(PASTE_END);
    if (endIndex < 0) return true;

    const pastedText = this.pasteBuffer.slice(0, endIndex);
    const remaining = this.pasteBuffer.slice(endIndex + PASTE_END.length);
    this.pasteBuffer = "";
    this.isInPaste = false;
    this.insert(pastedText);
    if (remaining.length > 0) this.handleInput(remaining);
    return true;
  }

  private snapshot(): void {
    this.undoStack.push({ text: this.text, cursor: this.cursor, selectionArmed: this.selectionArmed });
    if (this.undoStack.length > 100) this.undoStack.shift();
  }

  private undo(): void {
    const snapshot = this.undoStack.pop();
    if (snapshot == null) return;
    this.text = snapshot.text;
    this.cursor = snapshot.cursor;
    this.selectionArmed = snapshot.selectionArmed;
  }

  private insert(value: string): void {
    this.snapshot();
    if (this.selectionArmed) {
      this.text = value;
      this.cursor = value.length;
      this.selectionArmed = false;
      return;
    }
    this.text = `${this.text.slice(0, this.cursor)}${value}${this.text.slice(this.cursor)}`;
    this.cursor += value.length;
  }

  private deleteBackward(): void {
    if (this.selectionArmed) {
      this.insert("");
      return;
    }
    if (this.cursor === 0) return;
    this.snapshot();
    this.text = `${this.text.slice(0, this.cursor - 1)}${this.text.slice(this.cursor)}`;
    this.cursor -= 1;
  }

  private deleteForward(): void {
    if (this.selectionArmed) {
      this.insert("");
      return;
    }
    if (this.cursor >= this.text.length) return;
    this.snapshot();
    this.text = `${this.text.slice(0, this.cursor)}${this.text.slice(this.cursor + 1)}`;
  }

  private disarmSelection(edge: "start" | "end"): void {
    if (!this.selectionArmed) return;
    this.cursor = edge === "start" ? 0 : this.text.length;
    this.selectionArmed = false;
  }

  private moveHorizontally(delta: number): void {
    if (this.selectionArmed) {
      this.disarmSelection(delta < 0 ? "start" : "end");
      return;
    }
    this.cursor = Math.max(0, Math.min(this.text.length, this.cursor + delta));
  }

  private moveVertically(delta: number): void {
    if (this.selectionArmed) this.disarmSelection(delta < 0 ? "start" : "end");
    const start = this.lineStart(this.cursor);
    const column = this.cursor - start;
    if (delta < 0) {
      if (start === 0) return;
      const previousEnd = start - 1;
      const previousStart = this.lineStart(previousEnd);
      this.cursor = Math.min(previousStart + column, previousEnd);
      return;
    }
    const end = this.lineEnd(this.cursor);
    if (end >= this.text.length) return;
    const nextStart = end + 1;
    this.cursor = Math.min(nextStart + column, this.lineEnd(nextStart));
  }

  private lineStart(offset: number): number {
    return this.text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  }

  private lineEnd(offset: number): number {
    const end = this.text.indexOf("\n", offset);
    return end < 0 ? this.text.length : end;
  }
}
