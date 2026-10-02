import { mkdir, rename, writeFile } from "node:fs/promises";
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

export function formalValidationDirectory(): string {
  return process.env.PI_CODE_DIFF_FORMAL_VALIDATION_DIR ?? join(getAgentDir(), "cache", "pi-code-diff", "formal-validation");
}

/** Saves the guide under its snapshot fingerprint, so a later /diff-story of the same bytes can find it. */
export async function saveFormalValidationGuide(guide: FormalValidationGuide, directory = formalValidationDirectory()): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${guide.snapshot}.json`);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(guide, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return path;
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
    path = await saveFormalValidationGuide(guide, run.directory);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
  }
  return { guide, text: renderGuide(guide, { ...(path == null ? {} : { path }), ...(saveError == null ? {} : { saveError }) }), ...(path == null ? {} : { path }) };
}
