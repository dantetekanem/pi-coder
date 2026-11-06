import { describe, expect, it, vi } from "vitest";
import { withHerdrPaneZoom } from "../ui/full-screen-overlay.js";

function layoutResult(zoomed: boolean) {
  return {
    code: 0,
    stdout: JSON.stringify({ result: { layout: { zoomed } } }),
    stderr: "",
  };
}

describe("withHerdrPaneZoom", () => {
  it("leaves non-Herdr sessions unchanged", async () => {
    const run = vi.fn();
    const action = vi.fn(async () => "reviewed");

    await expect(withHerdrPaneZoom(action, { environment: {}, run })).resolves.toBe("reviewed");

    expect(action).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("zooms the current Herdr pane for the review and restores it afterward", async () => {
    const events: string[] = [];
    const run = vi.fn(async (args: string[]) => {
      events.push(args.join(" "));
      return args[1] === "layout" ? layoutResult(false) : { code: 0, stdout: "{}", stderr: "" };
    });

    const result = await withHerdrPaneZoom(async () => {
      events.push("review");
      return "reviewed";
    }, { environment: { HERDR_ENV: "1" }, run });

    expect(result).toBe("reviewed");
    expect(events).toEqual([
      "pane layout --current",
      "pane zoom --current --on",
      "review",
      "pane zoom --current --off",
    ]);
  });

  it("preserves an already-zoomed Herdr pane", async () => {
    const run = vi.fn(async () => layoutResult(true));
    const action = vi.fn(async () => "reviewed");

    await expect(withHerdrPaneZoom(action, { environment: { HERDR_ENV: "1" }, run })).resolves.toBe("reviewed");

    expect(run).toHaveBeenCalledExactlyOnceWith(["pane", "layout", "--current"]);
    expect(action).toHaveBeenCalledOnce();
  });

  it("restores the Herdr layout when the review fails", async () => {
    const run = vi.fn(async (args: string[]) => args[1] === "layout"
      ? layoutResult(false)
      : { code: 0, stdout: "{}", stderr: "" });

    await expect(withHerdrPaneZoom(
      async () => { throw new Error("review failed"); },
      { environment: { HERDR_ENV: "1" }, run },
    )).rejects.toThrow("review failed");

    expect(run).toHaveBeenLastCalledWith(["pane", "zoom", "--current", "--off"]);
  });

  it.each([
    [undefined, "/diff"],
    ["pi-coder diff", "pi-coder diff"],
  ])("names the review command %j in its warnings", async (command, name) => {
    const warn = vi.fn();
    const unavailable = vi.fn(async () => { throw new Error("herdr is not installed"); });
    await withHerdrPaneZoom(async () => "reviewed", { environment: { HERDR_ENV: "1" }, run: unavailable, warn, command });
    expect(warn).toHaveBeenCalledExactlyOnceWith(`Could not enable Herdr full-screen mode; opening ${name} in the current pane.`);

    warn.mockClear();
    const stuck = vi.fn(async (args: string[]) => args[1] === "layout" ? layoutResult(false) : { code: args.includes("--on") ? 0 : 1, stdout: "{}", stderr: "" });
    await withHerdrPaneZoom(async () => "reviewed", { environment: { HERDR_ENV: "1" }, run: stuck, warn, command });
    expect(warn).toHaveBeenCalledExactlyOnceWith(`Could not restore the Herdr pane layout after ${name} closed.`);
  });
});
