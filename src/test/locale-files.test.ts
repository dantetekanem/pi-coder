import { describe, expect, it } from "vitest";
import { filterReviewFilesByLocale, getReviewLocale } from "../locale-files.js";
import type { ReviewFile } from "../types.js";

function file(path: string): ReviewFile {
  return {
    id: path,
    path,
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
  };
}

describe("locale file visibility", () => {
  it("recognizes locale files without treating similarly named source files as translations", () => {
    expect(getReviewLocale("config/locales/en.yml")).toEqual({ isLocaleFile: true, locale: "en" });
    expect(getReviewLocale("locales/pt-BR.default.json")).toEqual({ isLocaleFile: true, locale: "pt-br" });
    expect(getReviewLocale("translations/fr/checkout.json")).toEqual({ isLocaleFile: true, locale: "fr" });
    expect(getReviewLocale("src/locales.ts")).toEqual({ isLocaleFile: false, locale: null });
  });

  it("keeps English and Brazilian Portuguese while hiding other locales by default", () => {
    const files = [
      file("src/app.ts"),
      file("config/locales/en.yml"),
      file("config/locales/en-GB/checkout.yml"),
      file("config/locales/pt-BR.yml"),
      file("config/locales/pt_br/checkout.yml"),
      file("config/locales/pt-PT.yml"),
      file("config/locales/fr.yml"),
      file("translations/de/messages.json"),
      file("config/locales/shared.yml"),
    ];

    expect(filterReviewFilesByLocale(files, false).map((candidate) => candidate.path)).toEqual([
      "src/app.ts",
      "config/locales/en.yml",
      "config/locales/en-GB/checkout.yml",
      "config/locales/pt-BR.yml",
      "config/locales/pt_br/checkout.yml",
    ]);
    expect(filterReviewFilesByLocale(files, true)).toEqual(files);
  });
});
