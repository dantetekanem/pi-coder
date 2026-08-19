import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkbench } from "../../scripts/build-workbench.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempRoot(name: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

async function fakeCompile(outputRoot: string, label = "new"): Promise<void> {
  const entry = resolve(outputRoot, "workbench/standalone.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, `export async function standaloneMain(argv) { if (argv[0] === "--help") process.stdout.write("${label} help\\n"); else process.stdout.write(JSON.stringify(argv) + "\\n"); return 0; }\n`);
}

async function seedCurrent(globalRoot: string): Promise<{ cacheRoot: string; launcher: string }> {
  const cacheRoot = resolve(globalRoot, "agent/cache/pi-code-diff/workbench");
  const oldRelease = resolve(cacheRoot, "release-old");
  await fakeCompile(oldRelease, "old");
  await mkdir(resolve(globalRoot, "agent/bin"), { recursive: true });
  await symlink("release-old", resolve(cacheRoot, "current"), "dir");
  const launcher = resolve(globalRoot, "agent/bin/pi-code-workbench");
  await writeFile(launcher, "old launcher\n");
  return { cacheRoot, launcher };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic global workbench build", () => {
  it("stages globally, links runtime dependencies, atomically promotes current, and installs a cwd-independent launcher", async () => {
    const globalRoot = await tempRoot("pi-workbench-global");
    const sourceRoot = await tempRoot("pi-workbench-source");
    const unrelatedCwd = await tempRoot("pi-workbench-cwd");
    await mkdir(resolve(sourceRoot, "node_modules"));

    const result = await buildWorkbench({
      globalRoot,
      sourceRoot,
      compile: (outputRoot) => fakeCompile(outputRoot),
      validate: async () => undefined,
    });

    expect(await readlink(resolve(result.cacheRoot, "current"))).toMatch(/^release-/);
    expect(await readlink(resolve(result.current, "node_modules"))).toBe(resolve(sourceRoot, "node_modules"));
    expect((await stat(result.launcher)).mode & 0o111).not.toBe(0);
    const smoke = await execFileAsync(result.launcher, ["--help"], { cwd: unrelatedCwd });
    expect(smoke.stdout).toBe("new help\n");
    const forwarded = await execFileAsync(result.launcher, ["path with spaces", "--path=-dash"], { cwd: unrelatedCwd });
    expect(forwarded.stdout).toBe('["path with spaces","--path=-dash"]\n');
    expect(await readdir(unrelatedCwd)).toEqual([]);
    expect((await readdir(result.cacheRoot)).some((entry) => entry.startsWith("staging-"))).toBe(false);
  });

  it("preserves the prior current runtime and launcher when validation fails and removes staging", async () => {
    const globalRoot = await tempRoot("pi-workbench-global");
    const sourceRoot = await tempRoot("pi-workbench-source");
    await mkdir(resolve(sourceRoot, "node_modules"));
    const { cacheRoot, launcher } = await seedCurrent(globalRoot);

    await expect(buildWorkbench({
      globalRoot,
      sourceRoot,
      compile: (outputRoot) => fakeCompile(outputRoot),
      validate: async () => { throw new Error("invalid runtime"); },
    })).rejects.toThrow("invalid runtime");

    expect(await readlink(resolve(cacheRoot, "current"))).toBe("release-old");
    expect(await readFile(launcher, "utf8")).toBe("old launcher\n");
    expect((await readdir(cacheRoot)).filter((entry) => entry.startsWith("staging-"))).toEqual([]);
  });

  it("rolls current back if atomic launcher installation fails", async () => {
    const globalRoot = await tempRoot("pi-workbench-global");
    const sourceRoot = await tempRoot("pi-workbench-source");
    await mkdir(resolve(sourceRoot, "node_modules"));
    const { cacheRoot, launcher } = await seedCurrent(globalRoot);

    await expect(buildWorkbench({
      globalRoot,
      sourceRoot,
      compile: (outputRoot) => fakeCompile(outputRoot),
      validate: async () => undefined,
      installLauncher: async () => { throw new Error("launcher denied"); },
    })).rejects.toThrow("launcher denied");

    expect(await readlink(resolve(cacheRoot, "current"))).toBe("release-old");
    expect(await readFile(launcher, "utf8")).toBe("old launcher\n");
    expect((await readdir(cacheRoot)).filter((entry) => entry.startsWith("staging-") || (entry.startsWith("release-") && entry !== "release-old"))).toEqual([]);
  });
});
