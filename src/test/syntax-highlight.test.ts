import { describe, expect, it } from "vitest";
import { tokenizeJsonLine } from "../syntax-highlight.js";

describe("json tokenization helpers", () => {
  it("tokenizes json keys and values", () => {
    const segments = tokenizeJsonLine('{"name":"x","n":1,"ok":true,"none":null}');
    expect(segments.filter((segment) => segment.token === "attr").map((segment) => segment.text)).toEqual([
      '"name"',
      '"n"',
      '"ok"',
      '"none"',
    ]);
    expect(segments.some((segment) => segment.token === "string" && segment.text === '"x"')).toBe(true);
    expect(segments.some((segment) => segment.token === "number" && segment.text === "1")).toBe(true);
    expect(segments.some((segment) => segment.token === "literal" && segment.text === "true")).toBe(true);
    expect(segments.some((segment) => segment.token === "literal" && segment.text === "null")).toBe(true);
  });

  it("keeps json commas and colons as punctuation-like meta tokens", () => {
    const segments = tokenizeJsonLine('{"name": "x"}');
    expect(segments.some((segment) => segment.token === "meta" && segment.text === ":")).toBe(true);
    expect(segments.some((segment) => segment.token === "meta" && segment.text === "{")).toBe(true);
  });
});
