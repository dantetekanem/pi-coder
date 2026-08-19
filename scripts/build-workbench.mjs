#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultSourceRoot = resolve(scriptRoot, "..");

function launcherSource(entry) {
  return `#!/usr/bin/env node\nconst { standaloneMain } = await import(${JSON.stringify(pathToFileURL(entry).href)});\nprocess.exitCode = await standaloneMain(process.argv.slice(2));\n`;
}

async function pathKind(path) {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? "symlink" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function defaultCompile(outputRoot, sourceRoot) {
  const tsc = resolve(sourceRoot, "node_modules/typescript/bin/tsc");
  await execFileAsync(process.execPath, [tsc, "-p", resolve(sourceRoot, "tsconfig.workbench.json"), "--noEmit", "false", "--outDir", outputRoot], { cwd: sourceRoot });
}

async function defaultValidate(runtimeRoot) {
  const entry = resolve(runtimeRoot, "workbench/standalone.js");
  await readFile(entry);
  const packageJson = JSON.parse(await readFile(resolve(runtimeRoot, "package.json"), "utf8"));
  if (packageJson.type !== "module") throw new Error("Standalone runtime package must be ESM.");
  if (await pathKind(resolve(runtimeRoot, "node_modules")) !== "symlink") throw new Error("Standalone runtime dependency link is missing.");
  const { stdout } = await execFileAsync(process.execPath, [entry, "--help"], { cwd: runtimeRoot });
  if (!stdout.startsWith("Usage: pi-code-workbench ")) throw new Error("Standalone runtime help validation failed.");
}

async function defaultInstallLauncher(launcher, entry) {
  const temporary = `${launcher}.next-${randomUUID()}`;
  try {
    await writeFile(temporary, launcherSource(entry), { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, launcher);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Builds and promotes a complete runtime without writing any artifact in sourceRoot or cwd. */
export async function buildWorkbench(options = {}) {
  const globalRoot = resolve(options.globalRoot ?? resolve(homedir(), ".pi"));
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot);
  const cacheRoot = resolve(globalRoot, "agent/cache/pi-code-diff/workbench");
  const binRoot = resolve(globalRoot, "agent/bin");
  const launcher = resolve(binRoot, "pi-code-workbench");
  const id = randomUUID();
  const staging = resolve(cacheRoot, `staging-${id}`);
  const release = resolve(cacheRoot, `release-${id}`);
  const current = resolve(cacheRoot, "current");
  const compile = options.compile ?? defaultCompile;
  const validate = options.validate ?? defaultValidate;
  const installLauncher = options.installLauncher ?? defaultInstallLauncher;
  let promoted = false;
  let oldTarget;
  let oldDirectoryBackup;

  await mkdir(cacheRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await mkdir(staging);
  try {
    await compile(staging, sourceRoot);
    await writeFile(resolve(staging, "package.json"), '{"type":"module"}\n');
    await symlink(resolve(sourceRoot, "node_modules"), resolve(staging, "node_modules"), "dir");
    await validate(staging);
    await rename(staging, release);

    const currentKind = await pathKind(current);
    if (currentKind === "symlink") oldTarget = await readlink(current);
    else if (currentKind === "other") {
      oldDirectoryBackup = resolve(cacheRoot, `rollback-${id}`);
      await rename(current, oldDirectoryBackup);
    }
    const nextCurrent = resolve(cacheRoot, `current-next-${id}`);
    await symlink(dirname(release) === cacheRoot ? release.slice(cacheRoot.length + 1) : release, nextCurrent, "dir");
    await rename(nextCurrent, current);
    promoted = true;

    await installLauncher(launcher, resolve(current, "workbench/standalone.js"));
    if (oldDirectoryBackup != null) await rm(oldDirectoryBackup, { recursive: true, force: true });
    return { globalRoot, cacheRoot, current, launcher };
  } catch (error) {
    if (promoted) {
      if (oldTarget != null) {
        const rollbackLink = resolve(cacheRoot, `current-rollback-${id}`);
        await symlink(oldTarget, rollbackLink, "dir");
        await rename(rollbackLink, current);
      } else if (oldDirectoryBackup != null) {
        await rm(current, { force: true });
        await rename(oldDirectoryBackup, current);
      } else {
        await rm(current, { force: true });
      }
    } else if (oldDirectoryBackup != null && await pathKind(oldDirectoryBackup) !== "missing") {
      await rename(oldDirectoryBackup, current);
    }
    await rm(release, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(resolve(cacheRoot, `current-next-${id}`), { force: true });
    await rm(resolve(cacheRoot, `current-rollback-${id}`), { force: true });
  }
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildWorkbench().catch((error) => {
    process.stderr.write(`Could not build standalone workbench: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
