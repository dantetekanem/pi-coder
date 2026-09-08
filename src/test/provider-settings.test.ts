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

    expect(settings.code).toBeUndefined();
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
    expect(renderProviderOperation(settings.providers.github!, "pullRequestDetails", { repo: "example/widgets", number: 18 }).args)
      .toEqual(["pr", "view", "18", "--repo", "example/widgets", "--json", "url,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,comments,reviews,createdAt,updatedAt"]);
    expect(settings.providers.github!.fields).toMatchObject({
      pullRequestUrl: ["url"],
      pullRequestDraft: ["isDraft"],
      pullRequestMergeState: ["mergeStateStatus"],
      pullRequestReviewDecision: ["reviewDecision"],
      pullRequestChecks: ["statusCheckRollup"],
      pullRequestComments: ["comments"],
      pullRequestReviews: ["reviews"],
      pullRequestCreatedAt: ["createdAt"],
      pullRequestUpdatedAt: ["updatedAt"],
      commentAuthor: ["author.login", "user.login"],
      commentCreatedAt: ["createdAt", "created_at"],
      commentSubmittedAt: ["submittedAt", "submitted_at"],
      commentUrl: ["html_url", "url"],
    });
    expect(getProviderCapability(settings.providers.github!, "pullRequestChecks")).toBe(true);
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

  it("accepts one direct code command", () => {
    const code = { command: ["code-open", "--cwd", "{cwd}"], targetArgs: ["--file", "{file}"] };
    const { version: _version, ...withoutVersion } = neutralSettings();
    expect(parsePiCodeDiffSettings({ ...withoutVersion, code }).code).toEqual(code);
    expect(parsePiCodeDiffSettings({ ...withoutVersion, code: { command: ["code-open"] } }).code).toEqual({ command: ["code-open"], targetArgs: [] });
    expect(() => parsePiCodeDiffSettings({ ...neutralSettings(), code: "code-open" })).toThrow(/settings.code must be an object/i);
    expect(() => parsePiCodeDiffSettings({ ...neutralSettings(), code: { ...code, command: ["code-open", "{file}"] } })).toThrow(/command.*file/i);
  });

  it("rejects unknown fields and malformed provider values", () => {
    expect(() => parsePiCodeDiffSettings({ ...neutralSettings(), extra: true })).toThrow("settings has unsupported fields: extra.");
    expect(() => parsePiCodeDiffSettings({ ...neutralSettings(), version: 2 })).toThrow("Settings version must be 1.");
    expect(() => parsePiCodeDiffSettings({ ...neutralSettings(), version: null })).toThrow("Settings version must be 1.");

    const invalid = neutralSettings();
    invalid.providers.primary.urls.patterns[0]!.host = "https://code.example";
    expect(() => parsePiCodeDiffSettings(invalid)).toThrow("providers.primary.urls.patterns[0].host is invalid.");
  });
});
