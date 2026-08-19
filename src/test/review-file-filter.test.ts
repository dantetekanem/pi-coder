import { describe, expect, it } from "vitest";
import { isReviewableFilePath } from "../git.js";

describe("isReviewableFilePath", () => {
  it("excludes generated text files by default", () => {
    expect(isReviewableFilePath("app/models/shop.rbi")).toBe(false);
    expect(isReviewableFilePath("app/models/user.rbi")).toBe(false);
    expect(isReviewableFilePath("sig/components/orders.rbi")).toBe(false);
    expect(isReviewableFilePath("dist/app.min.js")).toBe(false);
    expect(isReviewableFilePath("dist/app.js.map")).toBe(false);
  });

  it("includes generated text files when requested", () => {
    const policy = { includeGenerated: true };

    expect(isReviewableFilePath("app/models/shop.rbi", policy)).toBe(true);
    expect(isReviewableFilePath("dist/app.min.js", policy)).toBe(true);
    expect(isReviewableFilePath("dist/app.js.map", policy)).toBe(true);
    expect(isReviewableFilePath("assets/logo.png", policy)).toBe(false);
  });

  it("keeps related source files reviewable", () => {
    expect(isReviewableFilePath("app/models/shop.rb")).toBe(true);
    expect(isReviewableFilePath("src/app.ts")).toBe(true);
  });
});
