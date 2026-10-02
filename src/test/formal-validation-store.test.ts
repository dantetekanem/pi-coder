import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorySnapshot } from "../diff-story/plan.js";
import * as capture from "../formal-validation/capture.js";
import { buildGuide, type FormalValidationGuide, type GuideTarget } from "../formal-validation/guide.js";
import { formalGuideStore, loadFormalValidationGuide, runFormalValidation, saveFormalValidationGuide } from "../formal-validation/run.js";

const target: GuideTarget = { kind: "range", label: "base..head", repoRoot: "/repo", scope: "all-files" };
const snapshot = createStorySnapshot([{
  fileId: "src/total.ts",
  path: "src/total.ts",
  scope: "all-files",
  contents: { originalContent: "export function total() {\n  return 1;\n}\n", modifiedContent: "export function total() {\n  return 2;\n}\n" },
}]);

function guide(status: FormalValidationGuide["refinement"]["status"], summary?: string): FormalValidationGuide {
  const host = buildGuide({ snapshot, target }).guide;
  return { ...host, ...(summary == null ? {} : { summary }), refinement: { status, ...(status === "applied" ? { model: "model/test" } : {}) } };
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-formal-store-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("formal validation guide store", () => {
  it("saves privately, reads the guide back and leaves no temporary files", async () => {
    const store = formalGuideStore(directory);
    const save = await store.save(guide("applied", "First."));

    expect(save).toEqual({ status: "saved", path: join(directory, `${snapshot.fingerprint}.json`) });
    expect((await stat(save.path)).mode & 0o777).toBe(0o600);
    await expect(store.load(snapshot.fingerprint)).resolves.toMatchObject({ summary: "First.", refinement: { status: "applied" } });
    expect(await readdir(directory)).toEqual([`${snapshot.fingerprint}.json`]);
  });

  it("keeps a model-written guide when a host-only or failed guide for the same bytes comes later", async () => {
    await saveFormalValidationGuide(guide("applied", "Model."), directory);

    await expect(saveFormalValidationGuide(guide("skipped"), directory)).resolves.toMatchObject({ status: "kept" });
    await expect(saveFormalValidationGuide(guide("failed"), directory)).resolves.toMatchObject({ status: "kept" });
    expect((await loadFormalValidationGuide(snapshot.fingerprint, directory))?.summary).toBe("Model.");

    await expect(saveFormalValidationGuide(guide("applied", "Newer model."), directory)).resolves.toMatchObject({ status: "saved" });
    expect((await loadFormalValidationGuide(snapshot.fingerprint, directory))?.summary).toBe("Newer model.");
  });

  it("lets a model-written guide replace a host-only one", async () => {
    await saveFormalValidationGuide(guide("skipped"), directory);
    await expect(saveFormalValidationGuide(guide("applied", "Model."), directory)).resolves.toMatchObject({ status: "saved" });
    expect((await loadFormalValidationGuide(snapshot.fingerprint, directory))?.refinement.status).toBe("applied");
  });

  it("reads missing, malformed, foreign and badly named files as no guide", async () => {
    const path = join(directory, `${snapshot.fingerprint}.json`);
    await expect(loadFormalValidationGuide(snapshot.fingerprint, directory)).resolves.toBeUndefined();
    await writeFile(path, "{ not json");
    await expect(loadFormalValidationGuide(snapshot.fingerprint, directory)).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify({ ...guide("applied"), snapshot: "f".repeat(64) }));
    await expect(loadFormalValidationGuide(snapshot.fingerprint, directory)).resolves.toBeUndefined();
    await expect(loadFormalValidationGuide("../escape", directory)).resolves.toBeUndefined();
  });

  it("removes its temporary file when the final rename fails", async () => {
    await mkdir(join(directory, `${snapshot.fingerprint}.json`));
    await mkdir(join(directory, `${snapshot.fingerprint}.json`, "occupied"));

    await expect(saveFormalValidationGuide(guide("applied"), directory)).rejects.toThrow();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("tells the tool caller when an earlier model-written guide was kept", async () => {
    await saveFormalValidationGuide(guide("applied", "Model."), directory);
    vi.spyOn(capture, "captureChange").mockResolvedValue({ snapshot, target, hiddenLocales: 0, skipped: [] });

    const outcome = await runFormalValidation({} as never, {
      source: { kind: "range", cwd: "/repo", base: "base", head: "head" },
      skipReason: "refine=false",
      signal: new AbortController().signal,
      directory,
    });

    expect(outcome.path).toBeUndefined();
    expect(outcome.text).toContain("Not saved: a model-written guide for these exact bytes is already saved at");
    expect(JSON.parse(await readFile(join(directory, `${snapshot.fingerprint}.json`), "utf8")).summary).toBe("Model.");
  });
});
