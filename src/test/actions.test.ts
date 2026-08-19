import { describe, expect, it } from "vitest";
import { getReviewAction, getReviewFooterHint, getReviewHelpSections, matchesReviewAction } from "../ui/actions.js";

describe("review action registry", () => {
  it("derives help and footer content from registered actions", () => {
    const help = getReviewHelpSections();
    const footer = getReviewFooterHint();

    expect(help.find((section) => section.title === "Core")?.lines).toContain("Alt+1/2/3 switch review scope");
    expect(help.find((section) => section.title === "Core")?.lines).toContain("1/2/3/4/5 toggle Navigator/Diff/Comments/PR context/Replies");
    expect(help.find((section) => section.title === "Navigation")?.lines).toContain("T tree/flat files");
    expect(help.find((section) => section.title === "Navigation")?.lines).toContain("L show/hide other locales");
    expect(help.find((section) => section.title === "Diff actions")?.lines).toContain("k/K expand 10 lines above");
    expect(help.find((section) => section.title === "Diff actions")?.lines).toContain("j/J expand 10 lines below");
    expect(help.find((section) => section.title === "Comments")?.lines).toContain("d/r delete selected comment");
    expect(help.find((section) => section.title === "Comments")?.lines).toContain("A active-file/all-comments view");
    expect(footer).toContain("1/2/3/4/5 toggle Navigator/Diff/Comments/PR context/Replies");
    expect(footer).toContain("/ search focused pane");
    expect(footer).toContain("s submit");
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
