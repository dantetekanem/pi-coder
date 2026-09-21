import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { StoryOutputCarousel } from "../ui/story-output.js";

const theme = {
  fg: (_color: string, text: string) => text,
  getFgAnsi: () => "\x1b[38;2;220;200;180m",
  getBgAnsi: () => "\x1b[48;2;20;40;60m",
};
const plain = (rows: string[]) => rows.map(stripVTControlCharacters);

describe("live story output carousel", () => {
  it("shows raw public text and replaces the current text for its activity id", () => {
    const feed = new StoryOutputCarousel();
    feed.addActivity({ kind: "text", id: "final", text: "Luna: checking the changed caller" });
    expect(plain(feed.render(80, theme)).join("\n")).toContain("Luna: checking the changed caller");

    feed.addActivity({ kind: "text", id: "final", text: '{"snapshot":"public-final","summary":"A caller reuses work"}' });
    const text = plain(feed.render(80, theme)).join("\n");
    expect(text).toContain('"snapshot":"public-final"');
    expect(text).toContain("A caller reuses work");
    expect(text).not.toContain("Luna: checking the changed caller");

    feed.addActivity({ kind: "error", text: "Provider \u001b[31munavailable" });
    expect(plain(feed.render(80, theme)).join("\n")).toContain("Error · Provider \\x1b[31munavailable");
  });

  it("keeps the trailing window of growing text visible and wraps prior real lines upward", () => {
    const feed = new StoryOutputCarousel();
    feed.addActivity({ kind: "text", id: "stream", text: "initial output" });
    const accumulated = `${"earlier output ".repeat(180)}\nprior retained line\nDISTINCTIVE NEW TAIL`;
    feed.addActivity({ kind: "text", id: "stream", text: accumulated });

    const rows = plain(feed.render(100, theme));
    expect(rows.findIndex((line) => line.includes("prior retained line"))).toBe(3);
    expect(rows.findIndex((line) => line.includes("DISTINCTIVE NEW TAIL"))).toBe(4);
    expect(rows.join("\n")).not.toContain("initial output");
  });

  it("keeps current activity at the bottom and moves the preceding four real lines upward", () => {
    const feed = new StoryOutputCarousel();
    feed.addActivity({ kind: "status", text: "Reading app.ts" });
    expect(plain(feed.render(140, theme)).map((line) => line.trim())).toEqual([
      "", "", "", "", "Reading app.ts",
    ]);

    for (const text of ["Inspecting tests", "Linking assertions", "Ordering steps", "Writing the story"]) {
      feed.addActivity({ kind: "status", text });
    }
    const rows = plain(feed.render(140, theme));
    expect(rows.map((line) => line.trim())).toEqual([
      "Reading app.ts", "Inspecting tests", "Linking assertions", "Ordering steps", "Writing the story",
    ]);
    expect(rows.every((line) => line.indexOf(line.trim()) === 10)).toBe(true);
  });

  it("pauses visual updates without losing new activity, resumes, and clears retained text", () => {
    const feed = new StoryOutputCarousel();
    feed.addActivity({ kind: "text", id: "draft", text: "First" });
    feed.togglePaused();
    feed.addActivity({ kind: "text", id: "draft", text: "Second" });
    expect(plain(feed.render(80, theme)).join("\n")).toContain("First");
    feed.togglePaused();
    expect(plain(feed.render(80, theme)).join("\n")).toContain("Second");
    feed.clear();
    expect(plain(feed.render(80, theme)).every((line) => line.trim() === "")).toBe(true);
  });

  it("retains complete activity history and reflows wide public text on resize", () => {
    const feed = new StoryOutputCarousel();
    for (let index = 0; index < 60; index += 1) {
      feed.addActivity({ kind: "status", text: `Activity ${index}: ${"界é ".repeat(1000)}` });
    }
    const retained = (feed as unknown as { entries: Array<{ text: string }> }).entries;
    expect(retained).toHaveLength(60);
    expect(retained[0]?.text).toBe(`Activity 0: ${"界é ".repeat(1000)}`);
    for (const width of [40, 80, 120, 160]) {
      const rows = feed.render(width, theme);
      expect(rows).toHaveLength(5);
      expect(rows.every((line) => visibleWidth(line) === width)).toBe(true);
    }
    const text = plain(feed.render(120, theme)).join("\n");
    expect(text).toContain("界é");
    expect(retained.at(-1)?.text).toBe(`Activity 59: ${"界é ".repeat(1000)}`);
  });
});
