#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
}))[0];
const packed = new Set(result.files.map((file) => file.path));
const required = [
  "src/index.ts",
  "docs/access.md",
  "docs/remote-providers.md",
  "docs/workbench.md",
  "LICENSE",
  "README.md",
];
const forbidden = [...packed].filter((file) => /(?:\.test\.ts|\.(?:gif|png))$/.test(file));
const missing = required.filter((file) => !packed.has(file));
const unresolved = [];

for (const file of packed) {
  if (!file.startsWith("src/") || !file.endsWith(".ts")) continue;
  const source = readFileSync(path.join(root, file), "utf8");
  const imports = ts.preProcessFile(source, true, true).importedFiles;

  for (const imported of imports) {
    if (!imported.fileName.startsWith(".")) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), imported.fileName));
    const candidates = target.endsWith(".js")
      ? [`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}/index.ts`]
      : target.endsWith(".ts")
        ? [target]
        : [`${target}.ts`, `${target}/index.ts`];
    const existing = candidates.find((candidate) => existsSync(path.join(root, candidate)));
    if (!existing || !packed.has(existing)) unresolved.push(`${file} -> ${imported.fileName}`);
  }
}

if (missing.length || forbidden.length || unresolved.length) {
  if (missing.length) console.error(`Missing required package files:\n${missing.join("\n")}`);
  if (forbidden.length) console.error(`Forbidden package files:\n${forbidden.join("\n")}`);
  if (unresolved.length) console.error(`Unresolved packed runtime imports:\n${unresolved.join("\n")}`);
  process.exit(1);
}

console.log(`Package check passed: ${result.entryCount} files, ${result.size} bytes.`);
