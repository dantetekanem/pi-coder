import { describe, expect, it } from "vitest";
import { shortenNavigatorPath } from "../ui/review-app.js";

describe("navigator path shortening", () => {
  it("keeps short paths intact", () => {
    expect(shortenNavigatorPath("src/index.ts", 20)).toBe("src/index.ts");
  });

  it("preserves the basename when truncating", () => {
    expect(shortenNavigatorPath("src/ui/components/review-app.ts", 18)).toBe("…/review-app.ts");
  });

  it("keeps as much trailing path context as fits", () => {
    expect(shortenNavigatorPath("src/ui/components/review-app.ts", 28)).toBe("…/components/review-app.ts");
  });
});
