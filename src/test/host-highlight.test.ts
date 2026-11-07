import { describe, expect, it } from "vitest";
import { createHighlighter, languageForPath } from "../host/highlight.js";
import type { HostTheme } from "../host/types.js";

const theme: HostTheme = {
  fg: (color, text) => `<${color}>${text}</>`,
  bg: (_color, text) => text,
  bold: (text) => `*${text}*`,
  italic: (text) => `/${text}/`,
  underline: (text) => `_${text}_`,
  inverse: (text) => text,
  strikethrough: (text) => text,
};
const highlighter = createHighlighter(theme);

describe("languageForPath", () => {
  it.each([
    ["src/app.ts", "typescript"],
    ["App.TSX", "typescript"],
    ["lib/tasks/deploy.rb", "ruby"],
    ["script.sh", "bash"],
    ["README.md", "markdown"],
    ["Dockerfile", "dockerfile"],
    ["config/app.yml", "yaml"],
  ])("maps %s to %s", (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each(["notes.unknown", "LICENSE", "", "src/", "constructor", "__proto__"])("returns nothing for %j", (path) => {
    expect(languageForPath(path)).toBeUndefined();
  });

  it("is exposed on the highlighter", () => {
    expect(highlighter.languageForPath("a.py")).toBe("python");
  });
});

describe("createHighlighter", () => {
  it("colors tokens with the host theme's syntax colors", () => {
    expect(highlighter.highlightLine('const answer = "x"; // note', "typescript")).toBe(
      '<syntaxKeyword>const</> answer = <syntaxString>"x"</>; <syntaxComment>// note</>',
    );
    expect(highlighter.highlightLine("  def load_user(id): return nil", "python")).toBe(
      "  <syntaxKeyword>def</> <syntaxFunction>load_user</>(<syntaxType>id</>): <syntaxKeyword>return</> nil",
    );
  });

  it("decodes HTML entities back to the source text", () => {
    const line = highlighter.highlightLine('if (a < b && c > d) return "<tag>" + 42;', "typescript");
    expect(line).toBe(
      '<syntaxKeyword>if</> (a < b && c > d) <syntaxKeyword>return</> <syntaxString>"<tag>"</> + <syntaxNumber>42</>;',
    );
    expect(line).not.toMatch(/&(?:lt|gt|amp|quot|#x27);/);
  });

  it("falls back to the nearest enclosing scope and leaves unmapped scopes plain", () => {
    expect(highlighter.highlightLine('puts "hello #{name}"', "ruby")).toBe(
      'puts <syntaxString>"hello </><syntaxString>#{name}</><syntaxString>"</>',
    );
  });

  it("styles markup scopes with theme emphasis helpers", () => {
    expect(highlighter.highlightLine("# Title **bold** `code` [link](http://x)", "markdown")).toContain("***bold***");
  });

  it.each([undefined, "klingon"])("colors lines of an unknown language %j as plain code", (language) => {
    expect(highlighter.highlightLine("plain text", language)).toBe("<mdCodeBlock>plain text</>");
  });

  it("returns only the first line", () => {
    expect(highlighter.highlightLine("first\nsecond", "typescript")).toBe("first");
    expect(highlighter.highlightLine("first\nsecond", undefined)).toBe("<mdCodeBlock>first</>");
  });

  it("leaves text unstyled when the theme cannot color it", () => {
    const plain = createHighlighter({ ...theme, fg: (_color, text) => text });
    expect(plain.highlightLine('const x = "y";', "typescript")).toBe('const x = "y";');
  });
});
