import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderExternalEditorCommand, resolveExternalCodeTarget } from "../code/settings.js";

const editor = {
  kind: "external" as const,
  executable: "ttt",
  args: ["open", "--workspace", "{cwd}"],
  targetArgs: ["--goto", "{file}:{line}:{endLine}"],
  host: "auto" as const,
};

const anchor = (text: string) => ({
  algorithm: "sha256" as const,
  value: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
});

let directory: string;
let outsidePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-code-external-target-"));
  outsidePath = `${directory}-outside.ts`;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(outsidePath, { force: true });
});

describe("external code editor settings", () => {
  it("renders each placeholder exactly once into individual argv entries", () => {
    const command = renderExternalEditorCommand(editor, {
      cwd: "/work/widgets",
      resolvedTarget: { file: "/work/widgets/src/widget.ts", line: 12, endLine: 18 },
    });

    expect(command).toEqual({
      executable: "ttt",
      args: ["open", "--workspace", "/work/widgets", "--goto", "/work/widgets/src/widget.ts:12:18"],
      host: "auto",
    });
  });

  it("keeps a hostile absolute filename in one argv entry without recursively expanding placeholders", () => {
    const command = renderExternalEditorCommand(editor, {
      cwd: "/work/{file}",
      resolvedTarget: {
        file: "/work/{file}/src/{cwd}-$(touch nope).ts",
        line: 1,
        endLine: 1,
      },
    });

    expect(command.args).toEqual([
      "open",
      "--workspace",
      "/work/{file}",
      "--goto",
      "/work/{file}/src/{cwd}-$(touch nope).ts:1:1",
    ]);
  });

  it("always renders args but omits targetArgs when there is no target", () => {
    expect(renderExternalEditorCommand(editor, { cwd: "/work/widgets" })).toEqual({
      executable: "ttt",
      args: ["open", "--workspace", "/work/widgets"],
      host: "auto",
    });
  });

  it("canonicalizes a contained existing target and verifies its anchor", async () => {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "widget.ts"), "one\ntwo\nthree\n", "utf8");

    await expect(resolveExternalCodeTarget({
      cwd: directory,
      target: {
        path: "src/widget.ts",
        range: { startLine: 2, endLine: 2 },
        anchor: anchor("two"),
      },
    })).resolves.toEqual({
      file: join(realpathSync(directory), "src", "widget.ts"),
      line: 2,
      endLine: 2,
    });
  });

  it.each([
    ["a missing file", "missing.ts", { startLine: 1, endLine: 1 }, undefined],
    ["an out-of-root path", "../outside.ts", { startLine: 1, endLine: 1 }, undefined],
    ["a symlink escaping cwd", "escape.ts", { startLine: 1, endLine: 1 }, undefined],
    ["an anchor mismatch", "src/widget.ts", { startLine: 2, endLine: 2 }, anchor("not two")],
  ])("rejects %s", async (_label, path, range, targetAnchor) => {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "widget.ts"), "one\ntwo\nthree\n", "utf8");
    writeFileSync(outsidePath, "outside", "utf8");
    symlinkSync(outsidePath, join(directory, "escape.ts"));

    await expect(resolveExternalCodeTarget({
      cwd: directory,
      target: {
        path,
        range,
        ...(targetAnchor == null ? {} : { anchor: targetAnchor }),
      },
    })).rejects.toThrow();
  });
});
