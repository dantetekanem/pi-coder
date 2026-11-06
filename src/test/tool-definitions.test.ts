import { describe, expect, it } from "vitest";
import { PI_CODER_TOOLS } from "../tool-definitions.js";

function schemaOf(name: string) {
  return JSON.parse(JSON.stringify(PI_CODER_TOOLS.find((tool) => tool.name === name)!.parameters)) as {
    type: string;
    required?: string[];
    properties: Record<string, { type?: string; description?: string }>;
  };
}

describe("PI_CODER_TOOLS", () => {
  it("lists the four agent tools in their Pi registration order", () => {
    expect(PI_CODER_TOOLS.map((tool) => [tool.name, tool.label])).toEqual([
      ["open_code", "open-code"],
      ["open_code_diff", "open-code-diff"],
      ["open_code_diff_story", "open-code-diff-story"],
      ["submit_pr_review", "submit-pr-review"],
    ]);
  });

  it("needs a terminal only for the tools that open an interface", () => {
    expect(Object.fromEntries(PI_CODER_TOOLS.map((tool) => [tool.name, tool.needsTerminal]))).toEqual({
      open_code: true,
      open_code_diff: true,
      open_code_diff_story: true,
      submit_pr_review: false,
    });
  });

  it("serializes every parameter schema as a JSON Schema object", () => {
    for (const tool of PI_CODER_TOOLS) {
      const schema = schemaOf(tool.name);
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
    }
    expect(schemaOf("open_code_diff").required).toBeUndefined();
    expect(schemaOf("submit_pr_review").required).toEqual(["provider", "repo", "prNumber", "commitId", "verdict"]);
    expect(Object.keys(schemaOf("open_code_diff").properties)).toEqual(["args", "cwd", "continuation", "comments", "pullRequest"]);
  });

  it("describes the default directory without naming Pi", () => {
    expect(schemaOf("open_code").properties.cwd!.description).toBe("Repository directory. Defaults to the current working directory.");
    expect(schemaOf("open_code_diff").properties.cwd!.description).toBe("Directory to run the review from. Defaults to the current working directory.");
    expect(schemaOf("open_code_diff_story").properties.cwd!.description).toBe("Directory to run the story from. Defaults to the current working directory.");
    expect(PI_CODER_TOOLS.find((tool) => tool.name === "open_code_diff")!.promptGuidelines).toContain(
      "Pass cwd when you know the checkout/repository directory. Otherwise the current working directory is used.",
    );
    expect(JSON.stringify(PI_CODER_TOOLS)).not.toMatch(/Pi's current cwd|current Pi cwd/);
  });

  it("gives every tool a description, snippet, and guidelines", () => {
    for (const tool of PI_CODER_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.promptSnippet.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines.length).toBeGreaterThan(0);
    }
  });
});
