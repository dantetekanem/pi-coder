import { bench, describe } from "vitest";
import { buildStructuredDiff } from "../diff.js";

const sparseOriginal = Array.from({ length: 20_000 }, (_, index) => `const value${index} = ${index};`).join("\n");
const sparseModified = sparseOriginal.replace(/const value(\d+) = (\d+);/g, (line, indexText) => {
  const index = Number(indexText);
  return index % 200 === 0 ? `${line} changed` : line;
});
const longOriginal = Array.from({ length: 1_000 }, (_, index) => `${String(index).padStart(4, "0")}${"a".repeat(395)}`).join("\n");
const longModified = Array.from({ length: 1_000 }, (_, index) => `${String(index).padStart(4, "0")}${"b".repeat(395)}`).join("\n");

describe("structured diff performance", () => {
  bench("20k sparse replacements", () => {
    buildStructuredDiff(sparseOriginal, sparseModified, 3);
  });

  bench("1k long replacement lines", () => {
    buildStructuredDiff(longOriginal, longModified, 3);
  });
});
