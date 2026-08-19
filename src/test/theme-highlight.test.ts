import { describe, expect, it } from "vitest";
import { highlightJsonLine, highlightMarkdownLine, type ThemeHighlightAdapter } from "../theme-highlight.js";

const mockTheme: ThemeHighlightAdapter = {
  fg(color, text) {
    return `<${color}>${text}</${color}>`;
  },
};

describe("theme-aware highlight helpers", () => {
  it("highlights json keys, values, and punctuation with Pi theme tokens", () => {
    const rendered = highlightJsonLine(mockTheme, '{"name": "code-diff", "ok": true, "n": 1}');

    expect(rendered).toContain('<syntaxVariable>"name"</syntaxVariable>');
    expect(rendered).toContain('<syntaxString>"code-diff"</syntaxString>');
    expect(rendered).toContain('<syntaxNumber>true</syntaxNumber>');
    expect(rendered).toContain('<syntaxNumber>1</syntaxNumber>');
    expect(rendered).toContain('<syntaxPunctuation>{</syntaxPunctuation>');
    expect(rendered).toContain('<syntaxPunctuation>:</syntaxPunctuation>');
  });

  it("highlights markdown headings and inline code", () => {
    expect(highlightMarkdownLine(mockTheme, "# Title")).toBe("<mdHeading># Title</mdHeading>");
    expect(highlightMarkdownLine(mockTheme, "Use `code` here")).toContain("<mdCode>`code`</mdCode>");
  });

  it("highlights markdown links, quotes, and bullets", () => {
    expect(highlightMarkdownLine(mockTheme, "- [docs](https://example.com)")).toBe(
      '<mdListBullet>-</mdListBullet> <mdLink>[docs]</mdLink><mdLinkUrl>(https://example.com)</mdLinkUrl>',
    );
    expect(highlightMarkdownLine(mockTheme, "> quoted")).toBe(
      '<mdQuoteBorder>> </mdQuoteBorder><mdQuote>quoted</mdQuote>',
    );
  });
});
