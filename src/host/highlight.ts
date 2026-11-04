import hljs from "highlight.js";
import type { HostTheme } from "./types.js";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  lua: "lua",
  perl: "perl",
  r: "r",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  vim: "vim",
  graphql: "graphql",
  proto: "protobuf",
  tf: "hcl",
  hcl: "hcl",
};

type Format = (text: string) => string;

export function languageForPath(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  if (!extension || !Object.hasOwn(LANGUAGE_BY_EXTENSION, extension)) return undefined;
  return LANGUAGE_BY_EXTENSION[extension];
}

function scopeFormats(theme: HostTheme): ReadonlyMap<string, Format> {
  return new Map<string, Format>([
    ["keyword", (text) => theme.fg("syntaxKeyword", text)],
    ["built_in", (text) => theme.fg("syntaxType", text)],
    ["literal", (text) => theme.fg("syntaxNumber", text)],
    ["number", (text) => theme.fg("syntaxNumber", text)],
    ["regexp", (text) => theme.fg("syntaxString", text)],
    ["string", (text) => theme.fg("syntaxString", text)],
    ["comment", (text) => theme.fg("syntaxComment", text)],
    ["doctag", (text) => theme.fg("syntaxComment", text)],
    ["meta", (text) => theme.fg("muted", text)],
    ["function", (text) => theme.fg("syntaxFunction", text)],
    ["title", (text) => theme.fg("syntaxFunction", text)],
    ["class", (text) => theme.fg("syntaxType", text)],
    ["type", (text) => theme.fg("syntaxType", text)],
    ["tag", (text) => theme.fg("syntaxPunctuation", text)],
    ["name", (text) => theme.fg("syntaxKeyword", text)],
    ["attr", (text) => theme.fg("syntaxVariable", text)],
    ["variable", (text) => theme.fg("syntaxVariable", text)],
    ["params", (text) => theme.fg("syntaxVariable", text)],
    ["operator", (text) => theme.fg("syntaxOperator", text)],
    ["punctuation", (text) => theme.fg("syntaxPunctuation", text)],
    ["emphasis", (text) => theme.italic(text)],
    ["strong", (text) => theme.bold(text)],
    ["link", (text) => theme.underline(text)],
    ["addition", (text) => theme.fg("toolDiffAdded", text)],
    ["deletion", (text) => theme.fg("toolDiffRemoved", text)],
  ]);
}

function scopeFormat(scope: string, formats: ReadonlyMap<string, Format>): Format | undefined {
  const exact = formats.get(scope);
  if (exact != null) return exact;
  const dot = scope.indexOf(".");
  const byDot = dot === -1 ? undefined : formats.get(scope.slice(0, dot));
  if (byDot != null) return byDot;
  const dash = scope.indexOf("-");
  return dash === -1 ? undefined : formats.get(scope.slice(0, dash));
}

function scopeOfSpan(tag: string): string | undefined {
  const classes = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const className = (classes?.[1] ?? classes?.[2] ?? "").split(/\s+/).find((name) => name.startsWith("hljs-"));
  return className?.slice("hljs-".length);
}

function isSpanOpen(html: string, index: number): boolean {
  return html.startsWith("<span", index) && /[>\s]/.test(html[index + "<span".length] ?? "");
}

function decodeEntity(entity: string): string | undefined {
  switch (entity) {
    case "amp": return "&";
    case "lt": return "<";
    case "gt": return ">";
    case "quot": return '"';
    case "apos": return "'";
  }
  const numeric = /^#[xX]/.test(entity) ? Number.parseInt(entity.slice(2), 16) : entity.startsWith("#") ? Number.parseInt(entity.slice(1), 10) : Number.NaN;
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : undefined;
}

function renderSpans(html: string, formats: ReadonlyMap<string, Format>): string {
  let output = "";
  let text = "";
  const scopes: Array<string | undefined> = [];

  const activeFormat = (): Format | undefined => {
    for (let depth = scopes.length - 1; depth >= 0; depth -= 1) {
      const scope = scopes[depth];
      const format = scope == null ? undefined : scopeFormat(scope, formats);
      if (format != null) return format;
    }
    return undefined;
  };

  const flush = () => {
    if (text.length === 0) return;
    output += activeFormat()?.(text) ?? text;
    text = "";
  };

  let index = 0;
  while (index < html.length) {
    if (isSpanOpen(html, index)) {
      const end = html.indexOf(">", index + "<span".length);
      if (end !== -1) {
        flush();
        scopes.push(scopeOfSpan(html.slice(index, end + 1)));
        index = end + 1;
        continue;
      }
    }
    if (html.startsWith("</span>", index)) {
      flush();
      scopes.pop();
      index += "</span>".length;
      continue;
    }
    if (html[index] === "&") {
      const semicolon = html.indexOf(";", index + 1);
      const decoded = semicolon === -1 || semicolon - index > 16 ? undefined : decodeEntity(html.slice(index + 1, semicolon));
      if (decoded != null) {
        text += decoded;
        index = semicolon + 1;
        continue;
      }
    }
    text += html[index];
    index += 1;
  }
  flush();
  return output;
}

export function createHighlighter(theme: HostTheme): {
  highlightLine(text: string, language: string | undefined): string;
  languageForPath(path: string): string | undefined;
} {
  const formats = scopeFormats(theme);
  return {
    highlightLine(text, language) {
      const [line = ""] = text.split("\n");
      if (language == null || hljs.getLanguage(language) == null) return theme.fg("mdCodeBlock", line);
      try {
        const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        return renderSpans(html, formats).split("\n")[0] ?? line;
      } catch {
        return line;
      }
    },
    languageForPath,
  };
}
