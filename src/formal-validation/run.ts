import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiffStoryGenerate } from "../diff-story/generate.js";
import { captureChange, type FormalValidationSource } from "./capture.js";
import { buildGuide, type FormalValidationGuide } from "./guide.js";
import { refineGuide } from "./refine.js";
import { renderGuide } from "./render.js";

export interface FormalValidationRun {
  source: FormalValidationSource;
  /** Added to the PR description; the only description for a local change. */
  description?: string;
  generate?: DiffStoryGenerate;
  model?: string;
  /** Why the guideline model did not run, shown beside the host-only guide. */
  skipReason?: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
  directory?: string;
}

export interface FormalValidationOutcome {
  guide: FormalValidationGuide;
  text: string;
  path?: string;
}

/** `kept` means a model-written guide for the same bytes was already saved and this one was not written over it. */
export type GuideSave = { status: "saved" | "kept"; path: string };

export interface GuideStore {
  load(snapshot: string): Promise<FormalValidationGuide | undefined>;
  save(guide: FormalValidationGuide): Promise<GuideSave>;
}

export function formalValidationDirectory(): string {
  return process.env.PI_CODE_DIFF_FORMAL_VALIDATION_DIR ?? join(getAgentDir(), "cache", "pi-code-diff", "formal-validation");
}

function isSavedGuide(value: unknown, snapshot: string): value is FormalValidationGuide {
  if (typeof value !== "object" || value == null) return false;
  const guide = value as Partial<FormalValidationGuide>;
  return guide.version === 1 && guide.snapshot === snapshot && Array.isArray(guide.steps) && Array.isArray(guide.minimized)
    && Array.isArray(guide.claims) && typeof guide.units === "object" && guide.units != null
    && typeof guide.tests === "object" && guide.tests != null && typeof guide.refinement?.status === "string";
}

/** Reads the guide saved for these exact bytes; a missing, unreadable or foreign file reads as no guide. */
export async function loadFormalValidationGuide(snapshot: string, directory = formalValidationDirectory()): Promise<FormalValidationGuide | undefined> {
  if (!/^[0-9a-f]{64}$/.test(snapshot)) return undefined;
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, `${snapshot}.json`), "utf8"));
    return isSavedGuide(value, snapshot) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the guide under its snapshot fingerprint, so a later /diff-story of the same bytes can reuse it. */
export async function saveFormalValidationGuide(guide: FormalValidationGuide, directory = formalValidationDirectory()): Promise<GuideSave> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${guide.snapshot}.json`);
  if (guide.refinement.status !== "applied" && (await loadFormalValidationGuide(guide.snapshot, directory))?.refinement.status === "applied") {
    return { status: "kept", path };
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(guide, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { status: "saved", path };
}

export function formalGuideStore(directory?: string): GuideStore {
  return {
    load: (snapshot) => loadFormalValidationGuide(snapshot, directory),
    save: (guide) => saveFormalValidationGuide(guide, directory),
  };
}

function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export async function runFormalValidation(pi: ExtensionAPI, run: FormalValidationRun): Promise<FormalValidationOutcome> {
  const progress = run.onProgress ?? (() => {});
  const captured = await captureChange(pi, run.source, progress);
  run.signal.throwIfAborted();
  const description = [captured.description, run.description]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n\n");
  progress(`Ranking ${captured.snapshot.files.length} files and profiling changed tests…`);
  const prepared = buildGuide({
    snapshot: captured.snapshot,
    target: captured.target,
    description,
    hiddenLocales: captured.hiddenLocales,
    skipped: captured.skipped,
  });
  let guide = prepared.guide;
  if (run.generate != null) {
    progress(`Writing the guideline with ${run.model ?? "the guideline model"}…`);
    guide = await refineGuide(prepared, description, run.generate, run.signal, run.model);
  } else if (run.skipReason != null) {
    guide = { ...guide, refinement: { status: "skipped", message: run.skipReason } };
  }
  let path: string | undefined;
  let saveError: string | undefined;
  try {
    const save = await saveFormalValidationGuide(guide, run.directory);
    if (save.status === "saved") path = save.path;
    else saveError = `a model-written guide for these exact bytes is already saved at ${tildePath(save.path)}, so this one was not written over it`;
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
  }
  return { guide, text: renderGuide(guide, { ...(path == null ? {} : { path }), ...(saveError == null ? {} : { saveError }) }), ...(path == null ? {} : { path }) };
}
