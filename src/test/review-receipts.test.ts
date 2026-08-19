import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildReviewReceipt,
  getReviewReceiptPath,
  listReviewReceipts,
  loadReviewReceipt,
  saveReviewReceipt,
} from "../review-receipts.js";

const receiptsDir = join(tmpdir(), `pi-code-diff-receipts-${process.pid}`);
const settingsPath = join(tmpdir(), `pi-code-diff-receipt-settings-${process.pid}.json`);
const originalReceiptsDir = process.env.PI_CODE_DIFF_RECEIPTS_DIR;
const originalSettingsPath = process.env.PI_CODE_DIFF_SETTINGS_PATH;
process.env.PI_CODE_DIFF_RECEIPTS_DIR = receiptsDir;
process.env.PI_CODE_DIFF_SETTINGS_PATH = settingsPath;

function provider(id: string) {
  return {
    label: `${id} code host`,
    executable: `cli-${id}`,
    urls: {
      patterns: [{ host: `${id}.code.example`, path: "/{repo}/change/{number}" }],
      canonical: `https://${id}.code.example/{repo}/change/{number}`,
    },
    operations: { identity: { args: ["identity"] } },
    refs: {},
    fields: {},
    capabilities: {},
  };
}

afterAll(() => {
  if (originalReceiptsDir == null) delete process.env.PI_CODE_DIFF_RECEIPTS_DIR;
  else process.env.PI_CODE_DIFF_RECEIPTS_DIR = originalReceiptsDir;
  if (originalSettingsPath == null) delete process.env.PI_CODE_DIFF_SETTINGS_PATH;
  else process.env.PI_CODE_DIFF_SETTINGS_PATH = originalSettingsPath;
  rmSync(receiptsDir, { recursive: true, force: true });
  rmSync(settingsPath, { force: true });
});

beforeEach(() => {
  rmSync(receiptsDir, { recursive: true, force: true });
  writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    providers: { primary: provider("primary"), secondary: provider("secondary") },
    repositories: {},
  }), "utf8");
});

describe("review receipts", () => {
  it("persists a bounded local receipt without storing complete review bodies", () => {
    const body = `Review summary ${"x".repeat(400)} private-tail`;
    const commentBody = `Inline note ${"y".repeat(400)} private-comment-tail`;

    const saved = saveReviewReceipt({
      provider: "secondary",
      repo: "example/widgets",
      number: "42",
      url: "https://secondary.code.example/example/widgets/change/42",
      verdict: "comment",
      headSha: "head-sha",
      body,
      comments: [{ path: "src/app.ts", line: 12, side: "RIGHT", body: commentBody }],
      submittedAt: "2026-06-25T12:00:00.000Z",
    });

    expect(saved).not.toBeNull();
    expect(saved?.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved?.comments[0]?.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved?.bodyLength).toBe(body.length);
    expect(saved?.comments[0]?.bodyLength).toBe(commentBody.length);
    expect(saved?.bodySnippet?.length).toBeLessThanOrEqual(240);
    expect(saved?.comments[0]?.snippet.length).toBeLessThanOrEqual(240);

    const path = getReviewReceiptPath("secondary", "example/widgets", "42");
    expect(basename(path)).toBe("secondary__example-widgets__42.json");
    const raw = readFileSync(path, "utf8");
    if (process.platform !== "win32") {
      expect(statSync(receiptsDir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(raw).not.toContain(body);
    expect(raw).not.toContain(commentBody);
    expect(raw).not.toContain("private-tail");
    expect(raw).not.toContain("private-comment-tail");
    expect(loadReviewReceipt("secondary", "example/widgets", "42")).toEqual(saved);
    expect(listReviewReceipts()).toEqual([saved]);
  });

  it("normalizes hashes and ignores malformed receipt files", () => {
    const left = buildReviewReceipt({
      provider: "primary",
      repo: "example/widgets",
      number: "12",
      url: "https://primary.code.example/example/widgets/change/12",
      verdict: "approve",
      body: "Looks good\r\n",
      submittedAt: "2026-06-25T12:00:00.000Z",
    });
    const right = buildReviewReceipt({
      provider: "primary",
      repo: "example/widgets",
      number: "12",
      url: "https://primary.code.example/example/widgets/change/12",
      verdict: "approve",
      body: "  Looks good\n",
      submittedAt: "2026-06-25T12:00:00.000Z",
    });
    expect(left.bodyHash).toBe(right.bodyHash);

    saveReviewReceipt({
      provider: "primary",
      repo: "example/widgets",
      number: "12",
      url: "https://primary.code.example/example/widgets/change/12",
      verdict: "approve",
    });
    writeFileSync(join(receiptsDir, "corrupt.json"), "not-json", "utf8");

    expect(listReviewReceipts()).toHaveLength(1);
  });
});
