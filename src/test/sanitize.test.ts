import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "../sanitize.js";

describe("sanitizeTerminalText", () => {
  it("visibly escapes terminal control characters while preserving tabs", () => {
    expect(sanitizeTerminalText("safe\x1b]52;c;secret\x07\ttext\r\n")).toBe("safe\\x1b]52;c;secret\\x07\ttext\\x0d\\x0a");
  });
});
