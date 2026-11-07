import { describe, expect, it } from "vitest";
import { getFooterShortcutsText, getReviewAction, getReviewHelpSections, getStoryHelpSections, isShortcutsKey, matchesReviewAction } from "../ui/actions.js";

describe("review action registry", () => {
  it("derives help content from registered actions", () => {
    const help = getReviewHelpSections();

    expect(help.find((section) => section.title === "Core")?.lines).toContain("1/2/3/4/5 toggle Navigator/Diff/Comments/PR context/Replies");
    expect(help.find((section) => section.title === "Navigation")?.lines).toContain("T tree/flat files");
    expect(help.find((section) => section.title === "Navigation")?.lines).toContain("L show/hide other locales");
    expect(help.find((section) => section.title === "Diff actions")?.lines).toContain("k/K expand 10 lines above");
    expect(help.find((section) => section.title === "Diff actions")?.lines).toContain("j/J expand 10 lines below");
    expect(help.find((section) => section.title === "Comments")?.lines).toContain("d/r delete selected comment");
    expect(help.find((section) => section.title === "Comments")?.lines).toContain("A active-file/all-comments view");
    expect(help.find((section) => section.title === "Core")?.lines).toContain("/ search focused pane • n/N next/prev search");
    expect(help.find((section) => section.title === "Core")?.lines).toContain("s submit");
    expect(help.find((section) => section.title === "Core")?.lines).toContain("Ctrl+? / ? / Ctrl+/ toggle this shortcuts list");
    expect(help.find((section) => section.title === "Navigation")?.lines).toContain("gg/G • Home/End top/bottom");
    expect(help.find((section) => section.title === "Diff actions")?.lines).toContain("Option+↑↓/PgUp/PgDn/Home/End reach unchanged lines; add Shift to select a range");
  });

  it("derives the one-line footer from the footer shortcuts", () => {
    expect(getFooterShortcutsText()).toBe("Shortcuts: c (Comment) - d (Discuss with Agent) - Ctrl+? (All Shortcuts)");
    expect(getFooterShortcutsText("story")).toBe("Shortcuts: c (Comment) - d (Discuss with Agent) - Ctrl+? (All Shortcuts) - i (Info)");
  });

  it("lists the story keys in their own sections", () => {
    const story = getStoryHelpSections();
    const lines = (title: string) => story.find((section) => section.title === title)!.lines;

    expect(story.map((section) => section.title)).toEqual(["Story", "Panes", "Move", "Other pane", "Comments"]);
    expect(lines("Story")).toContain("Shift+←/→ previous/next step");
    expect(lines("Story")).toContain("i story info: steps, files, totals");
    expect(lines("Panes")).toContain("←/→ tests/code pane");
    expect(lines("Other pane")).toContain("Option+↑↓ scroll the other pane one row; focus stays");
    expect(lines("Other pane")).toContain("Option+PgUp/PgDn scroll the other pane one page");
    expect(lines("Other pane")).toContain("Option+Shift+↑↓ • Option+Home/End other pane top/bottom");
    expect(lines("Move")).toContain("Home/End • gg/G first/last line");
  });

  it.each([
    ["?", "the plain alias"],
    ["\x1b[47;5u", "Ctrl+/ in the Kitty protocol"],
    ["\x1b[47;6u", "Ctrl+Shift+/ in the Kitty protocol"],
    ["\x1b[47:63;6u", "Ctrl+Shift+/ with the shifted codepoint"],
    ["\x1b[63;5u", "Ctrl+? by codepoint"],
    ["\x1b[63;6u", "Ctrl+Shift+? by codepoint"],
    ["\x1b[27;5;63~", "Ctrl+? from modifyOtherKeys"],
    ["\x1b[27;6;63~", "Ctrl+Shift+? from modifyOtherKeys"],
    ["\x1b[27;5;47~", "Ctrl+/ from modifyOtherKeys"],
    ["\x1b[27;6;47~", "Ctrl+Shift+/ from modifyOtherKeys"],
    ["\x1f", "legacy Ctrl+/"],
  ])("opens the shortcuts list with %j (%s)", (data) => {
    expect(isShortcutsKey(data)).toBe(true);
  });

  it.each([
    ["\x7f", "Backspace and legacy Ctrl+?"],
    ["\x08", "Ctrl+H"],
    ["\x1b[127;5u", "Ctrl+Backspace"],
    ["\x1b[8;5u", "Ctrl+H in the Kitty protocol"],
    ["\x1b[27;5;127~", "Ctrl+Backspace from modifyOtherKeys"],
    ["/", "search"],
    ["\x1b/", "Alt+/"],
    ["\x1b[47;7u", "Ctrl+Alt+/"],
    ["h", "a letter"],
  ])("leaves %j to its own binding (%s)", (data) => {
    expect(isShortcutsKey(data)).toBe(false);
  });

  it("names the host's code command in the open-in-code help line", () => {
    const diffActions = (codeCommand?: string) => getReviewHelpSections(codeCommand).find((section) => section.title === "Diff actions")!.lines;

    expect(diffActions()).toContain("o open current line in /code");
    expect(diffActions("pi-coder code")).toContain("o open current line in pi-coder code");
  });

  it("matches dispatch inputs from the same action definitions", () => {
    expect(matchesReviewAction("expandAbove", "k")).toBe(true);
    expect(matchesReviewAction("expandAbove", "K")).toBe(true);
    expect(matchesReviewAction("expandBelow", "j")).toBe(true);
    expect(matchesReviewAction("expandBelow", "J")).toBe(true);
    expect(matchesReviewAction("tree", "T")).toBe(true);
    expect(matchesReviewAction("locales", "L")).toBe(true);
    expect(matchesReviewAction("globalComments", "A")).toBe(true);
    expect(matchesReviewAction("commentDelete", "d")).toBe(true);
    expect(matchesReviewAction("commentDelete", "r")).toBe(true);
    expect(matchesReviewAction("copy", "P")).toBe(true);
    expect(matchesReviewAction("copy", "p")).toBe(false);
    expect(getReviewAction("contextNavigation")).toMatchObject({ keys: "C", label: "include context in Up/Down" });
  });
});
