import { realpathSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { plainSourceLines, sanitizeTerminalText, type SourceHighlighter } from "../contracts.js";

type BundledLanguage = string;
interface ThemedToken {
  content: string;
  color?: string;
  fontStyle?: number;
}
interface ShikiHighlighter {
  loadLanguage(language: BundledLanguage): Promise<void>;
  codeToTokensBase(text: string, options: { lang: BundledLanguage; theme: string }): readonly (readonly ThemedToken[])[];
}
interface ShikiModule {
  createHighlighter(options: { themes: readonly string[]; langs: readonly BundledLanguage[] }): Promise<ShikiHighlighter>;
}

// Keep Shiki out of the module graph until a supported source buffer is selected.
const importModule = (specifier: string): Promise<unknown> => import(specifier);

function resolvePackage(specifier: string): string {
  if (typeof import.meta.resolve === "function") return import.meta.resolve(specifier);
  const packageJson = findPackageJSON(specifier, import.meta.url);
  if (packageJson == null) {
    const error = new Error(`Cannot find package '${specifier}'`);
    Object.assign(error, { code: "ERR_MODULE_NOT_FOUND" });
    throw error;
  }
  const packageJsonPath = realpathSync(packageJson);
  try {
    return createRequire(packageJsonPath).resolve(specifier);
  } catch (error) {
    if (specifier === "@pierre/diffs" && isPackagePathNotExportedError(error)) return packageJsonPath;
    throw error;
  }
}

function isPackagePathNotExportedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

function moduleSpecifier(pathOrUrl: string): string {
  return pathOrUrl.startsWith("file:") ? pathOrUrl : pathToFileURL(pathOrUrl).href;
}

function isModuleNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND";
}

async function loadShiki(): Promise<ShikiModule> {
  let directSpecifier: string;
  try {
    directSpecifier = resolvePackage("shiki");
  } catch (error) {
    if (!isModuleNotFoundError(error)) throw error;
    const diffsSpecifier = resolvePackage("@pierre/diffs");
    const shikiPath = createRequire(diffsSpecifier).resolve("shiki");
    return await importModule(moduleSpecifier(shikiPath)) as ShikiModule;
  }
  return await importModule(moduleSpecifier(directSpecifier)) as ShikiModule;
}

/** The single documented dark terminal palette used for all Shiki tokenization. */
const THEME = "github-dark";
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, BundledLanguage>> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  rb: "ruby", py: "python", json: "json", md: "markdown",
  html: "html", htm: "html", css: "css", scss: "scss",
  yaml: "yaml", yml: "yaml", xml: "xml", sh: "bash", bash: "bash",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", java: "java", go: "go", rs: "rust", php: "php",
  swift: "swift", kt: "kotlin", kts: "kotlin", sql: "sql", toml: "toml",
  vue: "vue", svelte: "svelte", lua: "lua", dart: "dart", scala: "scala",
};

function languageForPath(path: string): BundledLanguage | null {
  const extension = path.toLowerCase().match(/\.([^.\\/]+)$/)?.[1];
  return extension == null ? null : LANGUAGE_BY_EXTENSION[extension] ?? null;
}

function ansiColor(hex: string | undefined): string | null {
  const match = /^#([\da-f]{6})(?:[\da-f]{2})?$/i.exec(hex ?? "");
  if (match == null) return null;
  const value = match[1];
  return `38;2;${parseInt(value.slice(0, 2), 16)};${parseInt(value.slice(2, 4), 16)};${parseInt(value.slice(4, 6), 16)}`;
}

/** Converts Shiki tokens, never HTML, into conservative ANSI SGR sequences. */
export function tokensToAnsi(lines: readonly (readonly ThemedToken[])[]): readonly string[] {
  return lines.map((line) => line.map((token) => {
    const styles: string[] = [];
    if ((token.fontStyle ?? 0) & 2) styles.push("1");
    if ((token.fontStyle ?? 0) & 1) styles.push("3");
    if ((token.fontStyle ?? 0) & 4) styles.push("4");
    const color = ansiColor(token.color);
    if (color != null) styles.push(color);
    const content = sanitizeTerminalText(token.content);
    return styles.length === 0 ? content : `\u001b[${styles.join(";")}m${content}\u001b[0m`;
  }).join(""));
}

/** Node-only, lazy Shiki highlighter. Grammars and the singleton are cached, never file output. */
export function createNodeShikiHighlighter(): SourceHighlighter {
  let highlighter: Promise<ShikiHighlighter> | null = null;
  const languageLoads = new Map<BundledLanguage, Promise<void>>();

  async function getHighlighter() {
    if (highlighter == null) {
      highlighter = loadShiki().then(({ createHighlighter }) => createHighlighter({ themes: [THEME], langs: [] }));
    }
    return highlighter;
  }

  return {
    async highlight(path, text) {
      const language = languageForPath(path);
      if (language == null) return plainSourceLines(text);
      const instance = await getHighlighter();
      let load = languageLoads.get(language);
      if (load == null) {
        load = instance.loadLanguage(language);
        languageLoads.set(language, load);
      }
      await load;
      return tokensToAnsi(instance.codeToTokensBase(text, { lang: language, theme: THEME }));
    },
  };
}
