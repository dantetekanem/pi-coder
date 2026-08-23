import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPiCodeDiffSettingsPath,
  getProviderCapability,
  loadPiCodeDiffSettings,
  parsePiCodeDiffSettings,
  readConfiguredField,
  renderProviderOperation,
  renderProviderTemplate,
  requireProviderSettings,
} from "../provider-settings.js";

const originalSettingsPath = process.env.PI_CODE_DIFF_SETTINGS_PATH;
let directory: string;
let settingsPath: string;

function neutralSettings() {
  return {
    version: 1,
    providers: {
      primary: {
        label: "Primary code host",
        executable: "cli-one",
        urls: {
          patterns: [
            { host: "code.example", path: "/{repo}/change/{number}" },
            { host: "stack.example", path: "/review/{repo}/{number}" },
          ],
          canonical: "https://code.example/{repo}/change/{number}",
          clone: "https://code.example/{repo}.git",
        },
        operations: {
          identity: { args: ["api", "identity", "--field", "{identityField}"] },
          comments: { args: ["api", "projects/{repo}/changes/{number}/comments"], method: "get" },
        },
        refs: { head: "refs/changes/{number}/head" },
        fields: {
          login: ["actor.login", "actor.name"],
          resolved: "metadata.resolved",
        },
        capabilities: { threadedReplies: true, fileComments: false },
      },
    },
    repositories: {
      "example/widgets": {
        cwd: "/work/widgets",
        subdir: "packages/app",
        pathspecs: ["packages/app", "shared/ui"],
        importAliases: { "@shared": "shared/ui" },
      },
      "example/simple": "/work/simple",
    },
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-code-diff-settings-"));
  settingsPath = join(directory, "settings.json");
  process.env.PI_CODE_DIFF_SETTINGS_PATH = settingsPath;
});

afterEach(() => {
  if (originalSettingsPath == null) delete process.env.PI_CODE_DIFF_SETTINGS_PATH;
  else process.env.PI_CODE_DIFF_SETTINGS_PATH = originalSettingsPath;
  rmSync(directory, { recursive: true, force: true });
});

describe("provider settings", () => {
  it("loads arbitrary providers and repository profiles from the configured local file", () => {
    writeFileSync(settingsPath, JSON.stringify(neutralSettings()), "utf8");

    const settings = loadPiCodeDiffSettings();
    const provider = requireProviderSettings("primary", settings);

    expect(getPiCodeDiffSettingsPath()).toBe(settingsPath);
    expect(provider).toMatchObject({
      id: "primary",
      label: "Primary code host",
      executable: "cli-one",
      refs: { head: "refs/changes/{number}/head" },
    });
    expect(settings.repositories["example/widgets"]).toEqual({
      cwd: "/work/widgets",
      subdir: "packages/app",
      pathspecs: ["packages/app", "shared/ui"],
      importAliases: { "@shared": "shared/ui" },
    });
    expect(settings.repositories["example/simple"]).toEqual({ cwd: "/work/simple" });
  });

  it("loads GitHub as the built-in provider when no settings file exists", () => {
    const settings = loadPiCodeDiffSettings();

    expect(settings.repositories).toEqual({});
    expect(settings.providers.github).toMatchObject({
      id: "github",
      label: "GitHub",
      executable: "gh",
      urls: {
        patterns: [{ host: "github.com", path: "/{repo}/pull/{number}" }],
        canonical: "https://github.com/{repo}/pull/{number}",
        clone: "https://github.com/{repo}.git",
      },
      capabilities: {
        baseRevisionRequired: false,
        validateTargetBeforeSubmit: true,
        graphqlReviewThreads: true,
      },
    });
    expect(renderProviderOperation(settings.providers.github!, "pullRequest", { repo: "example/widgets", number: 18 }).args)
      .toEqual(expect.arrayContaining(["pr", "view", "18", "--repo", "example/widgets", "--json"]));
  });

  it("renders configured operations without invoking a shell", () => {
    const provider = parsePiCodeDiffSettings(neutralSettings()).providers.primary!;

    expect(renderProviderTemplate(provider.urls.canonical, { repo: "example/widgets", number: 42 })).toBe(
      "https://code.example/example/widgets/change/42",
    );
    expect(renderProviderOperation(provider, "comments", { repo: "example/widgets", number: 42 })).toEqual({
      args: ["api", "projects/example/widgets/changes/42/comments"],
      method: "GET",
    });
    expect(() => renderProviderTemplate("/{missing}", {})).toThrow("Missing provider template value: missing.");
  });

  it("reads configured response fields and capabilities", () => {
    const provider = parsePiCodeDiffSettings(neutralSettings()).providers.primary!;
    const payload = { actor: { name: "reviewer" }, metadata: { resolved: false } };

    expect(readConfiguredField(provider, "login", payload)).toBe("reviewer");
    expect(readConfiguredField(provider, "resolved", payload)).toBe(false);
    expect(readConfiguredField(provider, "missing", payload)).toBeUndefined();
    expect(getProviderCapability(provider, "threadedReplies")).toBe(true);
    expect(getProviderCapability(provider, "fileComments")).toBe(false);
    expect(getProviderCapability(provider, "unknown")).toBe(false);
  });

  it("rejects unknown fields and malformed provider values", () => {
    expect(() => parsePiCodeDiffSettings({ ...neutralSettings(), extra: true })).toThrow("settings has unsupported fields: extra.");
    expect(() => parsePiCodeDiffSettings({ ...neutralSettings(), version: 2 })).toThrow("Settings version must be 1.");

    const invalid = neutralSettings();
    invalid.providers.primary.urls.patterns[0]!.host = "https://code.example";
    expect(() => parsePiCodeDiffSettings(invalid)).toThrow("providers.primary.urls.patterns[0].host is invalid.");
  });

  it("defaults absent code settings to the built-in Workbench and accepts the explicit form", () => {
    expect(parsePiCodeDiffSettings(neutralSettings()).code).toEqual({
      version: 1,
      opener: { kind: "workbench" },
    });
    expect(parsePiCodeDiffSettings({
      ...neutralSettings(),
      code: { version: 1, opener: { kind: "workbench" } },
    }).code).toEqual({
      version: 1,
      opener: { kind: "workbench" },
    });
  });

  it("defaults an external opener's omitted host and args", () => {
    const settings = parsePiCodeDiffSettings({
      ...neutralSettings(),
      code: {
        version: 1,
        opener: {
          kind: "external",
          executable: "ttt",
        },
      },
    });

    expect(settings.code).toEqual({
      version: 1,
      opener: {
        kind: "external",
        executable: "ttt",
        args: [],
        host: "auto",
      },
    });
  });

  it.each(["auto", "current-terminal", "tmux-auto", "herdr-auto"])("accepts external settings with the %s host", (host) => {
    const settings = parsePiCodeDiffSettings({
      ...neutralSettings(),
      code: {
        version: 1,
        opener: {
          kind: "external",
          executable: "ttt",
          args: ["open", "--workspace", "{cwd}"],
          targetArgs: ["--goto", "{file}:{line}:{endLine}"],
          host,
        },
      },
    });

    expect(settings.code).toEqual({
      version: 1,
      opener: {
        kind: "external",
        executable: "ttt",
        args: ["open", "--workspace", "{cwd}"],
        targetArgs: ["--goto", "{file}:{line}:{endLine}"],
        host,
      },
    });
  });

  it.each([
    ["unknown code field", { version: 1, unexpected: true }, /code has unsupported fields: unexpected/],
    ["unknown opener field", { version: 1, opener: { kind: "workbench", unexpected: true } }, /code\.opener has unsupported fields: unexpected/],
    ["unsupported code version", { version: 2, opener: { kind: "workbench" } }, /code version must be 1/i],
    ["missing external executable", { version: 1, opener: { kind: "external", args: ["open"] } }, /code\.opener\.executable/],
    ["unknown placeholder", { version: 1, opener: { kind: "external", executable: "ttt", args: ["{unknown}"] } }, /placeholder/i],
    ["target placeholder in always-rendered args", { version: 1, opener: { kind: "external", executable: "ttt", args: ["{file}"] } }, /args.*file/i],
    ["too many combined arguments", {
      version: 1,
      opener: {
        kind: "external",
        executable: "ttt",
        args: Array.from({ length: 32 }, () => "x"),
        targetArgs: Array.from({ length: 33 }, () => "x"),
      },
    }, /(?:args.*targetArgs.*64|targetArgs.*args.*64|64.*(?:args|targetArgs))/i],
    ["oversized argument", { version: 1, opener: { kind: "external", executable: "ttt", args: ["x".repeat(8_193)] } }, /args\[0\].*bytes/i],
  ])("rejects $0", (_label, code, message) => {
    expect(() => parsePiCodeDiffSettings({ ...neutralSettings(), code })).toThrow(message);
  });
});
