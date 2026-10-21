import { describe, expect, it } from "vitest";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../sanitize.js";
import {
  MultiClickCounter,
  characterCodeRange,
  characterScreenRange,
  clampToRect,
  describeCopiedText,
  extendCodeRange,
  extendScreenRange,
  extractCodeText,
  extractScreenText,
  granularityForClicks,
  highlightColumns,
  hitCodeLine,
  layoutCodeLines,
  parseSgrMouseInput,
  rectContains,
  screenRowColumns,
  screenWordRange,
  selectedColumns,
  stripTerminalSequences,
  wordRangeAt,
} from "../ui/mouse-selection.js";

const GUTTER = "  12 +   ";

function layout(source: string, width: number, wrap = true) {
  const display = sanitizeTerminalText(source);
  const content = `${GUTTER}${display}`;
  const visual = (wrap ? wrapTextWithAnsi(content, width) : [truncateToWidth(content, width, "…", false)]).map(stripTerminalSequences);
  return { visual, lines: layoutCodeLines(visual, content, display, source) };
}

describe("parseSgrMouseInput", () => {
  it("returns zero-based press, drag, release, and wheel reports", () => {
    expect(parseSgrMouseInput("\x1b[<0;10;5M")).toEqual({ button: 0, col: 9, row: 4, release: false });
    expect(parseSgrMouseInput("\x1b[<32;11;5M")).toEqual({ button: 32, col: 10, row: 4, release: false });
    expect(parseSgrMouseInput("\x1b[<0;12;6m")).toEqual({ button: 0, col: 11, row: 5, release: true });
    expect(parseSgrMouseInput("\x1b[<65;1;1M")).toEqual({ button: 65, col: 0, row: 0, release: false });
    expect(parseSgrMouseInput("x")).toBeNull();
    expect(parseSgrMouseInput("\x1b[A")).toBeNull();
  });
});

describe("stripTerminalSequences", () => {
  it("removes styling, hyperlinks, and cursor markers but keeps text", () => {
    expect(stripTerminalSequences("\x1b[31mred\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x07\x1b_pi:c\x07!")).toBe("red link!");
  });
});

describe("layoutCodeLines", () => {
  it("maps gutter, code, and trailing columns of one visual line", () => {
    const { lines } = layout("call(value)", 80);
    expect(lines).toHaveLength(1);
    const [line] = lines!;
    expect(line!.cells[0]).toEqual({ col: GUTTER.length, width: 1, start: 0, end: 1 });
    expect(hitCodeLine(line!, 2)).toEqual({ start: 0, end: 0 });
    expect(hitCodeLine(line!, GUTTER.length + 4)).toEqual({ start: 4, end: 5 });
    expect(hitCodeLine(line!, 70)).toEqual({ start: 11, end: 11 });
  });

  it("follows wrapped lines across whitespace the wrapper dropped", () => {
    const source = "alpha beta gamma delta";
    const { visual, lines } = layout(source, 16);
    expect(visual.length).toBeGreaterThan(1);
    expect(lines).toHaveLength(visual.length);
    const second = lines![1]!;
    const firstCell = second.cells[0]!;
    expect(source.slice(firstCell.start, firstCell.end)).toBe(visual[1]!.trimStart()[0]);
    expect(source.slice(second.start, second.end)).toBe(visual[1]);
    expect(lines![lines!.length - 1]!.end).toBe(source.length);
    for (let index = 1; index < lines!.length; index += 1) expect(lines![index]!.start).toBeGreaterThanOrEqual(lines![index - 1]!.end);
  });

  it("maps tabs and escaped control characters back to one source character each", () => {
    const source = "\tx\u0001y";
    const { lines } = layout(source, 80);
    const cells = lines![0]!.cells;
    expect(cells.map((cell) => [cell.width, cell.start, cell.end])).toEqual([
      [3, 0, 1],
      [1, 1, 2],
      [1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3],
      [1, 3, 4],
    ]);
  });

  it("maps the ellipsis of a truncated line to the end of the source", () => {
    const source = "const value = computeSomethingLong(argument);";
    const { visual, lines } = layout(source, 24, false);
    expect(visual[0]!.endsWith("…")).toBe(true);
    const line = lines![0]!;
    expect(line.end).toBe(source.length);
    expect(hitCodeLine(line, line.endCol)).toEqual({ start: source.length, end: source.length });
  });

  it("rejects rendered lines that do not belong to the content", () => {
    expect(layoutCodeLines(["unrelated"], `${GUTTER}code`, "code", "code")).toBeNull();
    expect(layoutCodeLines([`${GUTTER}code`], `${GUTTER}code`, "other", "code")).toBeNull();
  });

  it("returns the columns covering a source range", () => {
    const { lines } = layout("one two", 80);
    expect(selectedColumns(lines![0]!, 4, 7)).toEqual({ start: GUTTER.length + 4, end: GUTTER.length + 7 });
    expect(selectedColumns(lines![0]!, 7, 9)).toBeNull();
  });
});

describe("code ranges", () => {
  it("includes the press and pointer cells in either drag direction", () => {
    expect(characterCodeRange(2, { start: 3, end: 4 }, 4, { start: 1, end: 2 })).toEqual({ start: { row: 2, offset: 3 }, end: { row: 4, offset: 2 } });
    expect(characterCodeRange(4, { start: 3, end: 4 }, 2, { start: 1, end: 2 })).toEqual({ start: { row: 2, offset: 1 }, end: { row: 4, offset: 4 } });
    expect(characterCodeRange(2, { start: 5, end: 6 }, 2, { start: 2, end: 3 })).toEqual({ start: { row: 2, offset: 2 }, end: { row: 2, offset: 6 } });
    expect(characterCodeRange(2, { start: 3, end: 4 }, 2, { start: 3, end: 4 })).toBeNull();
    expect(characterCodeRange(2, { start: 9, end: 9 }, 3, { start: 0, end: 1 })).toEqual({ start: { row: 2, offset: 9 }, end: { row: 3, offset: 1 } });
  });

  it("extends word and line selections without shrinking the first range", () => {
    const initial = { start: { row: 3, offset: 4 }, end: { row: 3, offset: 9 } };
    expect(extendCodeRange(initial, { start: { row: 1, offset: 0 }, end: { row: 1, offset: 2 } })).toEqual({ start: { row: 1, offset: 0 }, end: { row: 3, offset: 9 } });
    expect(extendCodeRange(initial, { start: { row: 5, offset: 1 }, end: { row: 5, offset: 6 } })).toEqual({ start: { row: 3, offset: 4 }, end: { row: 5, offset: 6 } });
    expect(extendCodeRange(initial, { start: { row: 3, offset: 4 }, end: { row: 3, offset: 9 } })).toEqual(initial);
  });

  it("selects identifiers and keeps paths and kebab-case together", () => {
    const text = "return load_user(src/app-file.ts).name;";
    expect(wordRangeAt(text, text.indexOf("load_user") + 2)).toEqual({ start: 7, end: 16 });
    const path = text.indexOf("src/app-file.ts");
    expect(wordRangeAt(text, path + 5)).toEqual({ start: path, end: path + "src/app-file.ts".length });
    expect(wordRangeAt(text, text.indexOf("("))).toEqual({ start: 16, end: 17 });
    expect(wordRangeAt(text, text.length)).toBeNull();
    expect(wordRangeAt("", 0)).toBeNull();
  });

  it("copies file text with tabs and without CRs, and skips rows without code on the selected side", () => {
    const rows: Array<{ text: string; source?: string } | null> = [
      { text: "    first line", source: "\tfirst line" },
      null,
      { text: "second\r", source: "second" },
      { text: "" },
      { text: "third line" },
    ];
    const at = (row: number) => rows[row] ?? null;
    expect(extractCodeText({ start: { row: 0, offset: 2 }, end: { row: 4, offset: 5 } }, at)).toBe("\tfirst line\nsecond\n\nthird");
    expect(extractCodeText({ start: { row: 0, offset: 4 }, end: { row: 0, offset: 9 } }, at)).toBe("first");
    expect(extractCodeText({ start: { row: 2, offset: 7 }, end: { row: 4, offset: 0 } }, at)).toBe("\n\n");
    expect(extractCodeText({ start: { row: 0, offset: 0 }, end: { row: 0, offset: 5 } }, () => ({ text: "mismatch", source: "other" }))).toBe("misma");
  });
});

describe("highlightColumns", () => {
  it("reverses only the selected columns and keeps syntax colors inside them", () => {
    const line = "ab\x1b[31mcd\x1b[0mef";
    const highlighted = highlightColumns(line, 1, 5);
    expect(stripTerminalSequences(highlighted)).toBe("abcdef");
    expect(highlighted).toBe("a\x1b[7mb\x1b[31m\x1b[7mcd\x1b[0m\x1b[7me\x1b[27m\x1b[31m\x1b[0mf");
    expect(highlightColumns(line, 3, 3)).toBe(line);
  });

  it("keeps the style active before the selection after it ends", () => {
    const line = "\x1b[48;2;1;2;3m  code  \x1b[49m";
    const highlighted = highlightColumns(line, 2, 6);
    expect(stripTerminalSequences(highlighted)).toBe("  code  ");
    expect(highlighted.endsWith("\x1b[27m\x1b[48;2;1;2;3m  \x1b[49m")).toBe(true);
  });
});

describe("screen selection", () => {
  const rect = { top: 2, bottom: 6, left: 4, right: 13 };

  it("clamps points and orders ranges", () => {
    expect(rectContains(rect, { row: 2, col: 4 })).toBe(true);
    expect(rectContains(rect, { row: 7, col: 4 })).toBe(false);
    expect(clampToRect(rect, { row: 0, col: 30 })).toEqual({ row: 2, col: 13 });
    expect(characterScreenRange({ row: 4, col: 8 }, { row: 3, col: 5 })).toEqual({ start: { row: 3, col: 5 }, end: { row: 4, col: 8 } });
    expect(characterScreenRange({ row: 4, col: 8 }, { row: 4, col: 8 })).toBeNull();
    const word = { start: { row: 3, col: 6 }, end: { row: 3, col: 9 } };
    expect(extendScreenRange(word, { start: { row: 5, col: 4 }, end: { row: 5, col: 7 } })).toEqual({ start: { row: 3, col: 6 }, end: { row: 5, col: 7 } });
  });

  it("selects a word inside the pane and snaps wide graphemes", () => {
    const plain = "│   review notes │";
    expect(screenWordRange(plain, rect, { row: 3, col: 6 })).toEqual({ start: { row: 3, col: 4 }, end: { row: 3, col: 9 } });
    expect(screenRowColumns({ start: { row: 3, col: 5 }, end: { row: 3, col: 5 } }, rect, 3, "│   界面 │")).toEqual({ start: 4, end: 6 });
  });

  it("copies the selected text of each row inside the pane without padding", () => {
    const frame = ["", "", "│   first row      │", "│   second row     │", "│   third          │"];
    const text = extractScreenText({ start: { row: 2, col: 4 }, end: { row: 4, col: 8 } }, rect, (row) => frame[row] ?? "");
    expect(text).toBe("first row\nsecond row\nthird");
  });
});

describe("MultiClickCounter", () => {
  it("counts quick presses on one cell up to triple clicks", () => {
    let now = 1_000;
    const counter = new MultiClickCounter(() => now);
    expect(counter.next({ row: 1, col: 1 })).toBe(1);
    now += 200;
    expect(counter.next({ row: 1, col: 1 })).toBe(2);
    now += 200;
    expect(counter.next({ row: 1, col: 1 })).toBe(3);
    now += 200;
    expect(counter.next({ row: 1, col: 1 })).toBe(1);
    now += 200;
    expect(counter.next({ row: 1, col: 2 })).toBe(1);
    now += 900;
    expect(counter.next({ row: 1, col: 2 })).toBe(1);
    counter.reset();
    expect(counter.next({ row: 1, col: 2 })).toBe(1);
    expect([1, 2, 3].map(granularityForClicks)).toEqual(["character", "word", "line"]);
  });
});

describe("describeCopiedText", () => {
  it("counts lines for multi-line text and characters otherwise", () => {
    expect(describeCopiedText("a\nb\nc")).toBe("3 lines");
    expect(describeCopiedText("x")).toBe("1 character");
    expect(describeCopiedText("émoji 😀")).toBe("7 characters");
  });
});
