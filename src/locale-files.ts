import type { ReviewFile } from "./types.js";

const LOCALE_DIRECTORIES = new Set(["i18n", "locale", "locales", "translation", "translations"]);
const LOCALE_CODE_PATTERN = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

export interface ReviewLocale {
  isLocaleFile: boolean;
  locale: string | null;
}

function normalizeLocale(locale: string): string {
  return locale.replaceAll("_", "-").toLowerCase();
}

function localeFromFileName(fileName: string): string | null {
  const parts = fileName.split(".");
  if (parts.length < 2) return null;
  const candidates = [parts[0], parts[parts.length - 2]];
  const locale = candidates.find((candidate) => candidate != null && LOCALE_CODE_PATTERN.test(candidate));
  return locale == null ? null : normalizeLocale(locale);
}

export function getReviewLocale(path: string): ReviewLocale {
  const parts = path.split("/").filter(Boolean);
  const localeDirectoryIndex = parts.findIndex((part) => LOCALE_DIRECTORIES.has(part.toLowerCase()));
  if (localeDirectoryIndex < 0 || localeDirectoryIndex === parts.length - 1) {
    return { isLocaleFile: false, locale: null };
  }

  const firstNestedPart = parts[localeDirectoryIndex + 1]!;
  const locale = !firstNestedPart.includes(".") && LOCALE_CODE_PATTERN.test(firstNestedPart)
    ? normalizeLocale(firstNestedPart)
    : localeFromFileName(parts[parts.length - 1]!);
  return { isLocaleFile: true, locale };
}

export function isDefaultReviewLocale(locale: string | null): boolean {
  return locale === "en" || locale?.startsWith("en-") === true || locale === "pt-br";
}

export function filterReviewFilesByLocale(files: ReviewFile[], showAllLocales: boolean): ReviewFile[] {
  if (showAllLocales) return files;
  return files.filter((file) => {
    const reviewLocale = getReviewLocale(file.path);
    return !reviewLocale.isLocaleFile || isDefaultReviewLocale(reviewLocale.locale);
  });
}
