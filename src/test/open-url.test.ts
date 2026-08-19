import { describe, expect, it, vi } from "vitest";
import { getUrlOpenCommand, normalizeExternalUrl, openExternalUrl } from "../ui/open-url.js";

describe("normalizeExternalUrl", () => {
  it("accepts canonical http and https URLs", () => {
    expect(normalizeExternalUrl("https://github.com/example/widgets/pull/12")).toBe("https://github.com/example/widgets/pull/12");
    expect(normalizeExternalUrl("  https://secondary.code.example/example/widgets/change/9  ")).toBe("https://secondary.code.example/example/widgets/change/9");
    expect(normalizeExternalUrl("http://localhost:3000/pulls/1")).toBe("http://localhost:3000/pulls/1");
  });

  it("rejects non-http schemes, credentials, and shell metacharacters", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      "github.com/example/widgets/pull/12",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "https://user:secret@github.com/example/widgets/pull/12",
      "https://github.com/example/widgets/pull/12; rm -rf /",
      "https://github.com/example/widgets/pull/12 && curl evil.sh",
      "https://github.com/example/widgets/pull/12`whoami`",
      "https://github.com/example/widgets/pull/12$(id)",
      "https://github.com/example/widgets/pull/12'\"",
      "https://github.com/example/widgets/pull/12\nopen -a Calculator",
    ]) {
      expect(normalizeExternalUrl(value)).toBeNull();
    }
  });

  it("rejects URLs longer than the allowed maximum", () => {
    expect(normalizeExternalUrl(`https://github.com/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("getUrlOpenCommand", () => {
  it("builds an argv-only command per platform", () => {
    const url = "https://github.com/example/widgets/pull/12";

    expect(getUrlOpenCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(getUrlOpenCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    expect(getUrlOpenCommand(url, "freebsd")).toEqual({ command: "xdg-open", args: [url] });
    expect(getUrlOpenCommand(url, "win32")).toEqual({ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] });
  });

  it("returns null for an unsafe URL on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      expect(getUrlOpenCommand("javascript:alert(1)", platform)).toBeNull();
    }
  });
});

describe("openExternalUrl", () => {
  it("launches the platform command without a shell", async () => {
    const launch = vi.fn(async () => {});

    const result = await openExternalUrl("https://github.com/example/widgets/pull/12", { platform: "darwin", launch });

    expect(result).toEqual({ status: "opened", url: "https://github.com/example/widgets/pull/12" });
    expect(launch).toHaveBeenCalledWith({ command: "open", args: ["https://github.com/example/widgets/pull/12"] });
  });

  it("reports invalid URLs without launching anything", async () => {
    const launch = vi.fn(async () => {});

    expect(await openExternalUrl("javascript:alert(1)", { platform: "linux", launch })).toEqual({ status: "invalid" });
    expect(await openExternalUrl(undefined, { platform: "linux", launch })).toEqual({ status: "invalid" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("reports a failed launch instead of throwing", async () => {
    const launch = vi.fn(async () => {
      throw new Error("spawn xdg-open ENOENT");
    });

    const result = await openExternalUrl("https://github.com/example/widgets/pull/12", { platform: "linux", launch });

    expect(result).toEqual({
      status: "failed",
      url: "https://github.com/example/widgets/pull/12",
      error: "spawn xdg-open ENOENT",
    });
  });

  it("does not suspend the caller when the real launcher cannot find the opener", async () => {
    const result = await openExternalUrl("https://github.com/example/widgets/pull/12", {
      platform: "linux",
      launch: () => Promise.reject(new Error("spawn xdg-open ENOENT")),
    });

    expect(result.status).toBe("failed");
  });
});
