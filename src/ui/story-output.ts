import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { StoryAgentActivity } from "../diff-story/activity.js";
import { sanitizeTerminalMultilineText } from "../sanitize.js";

const OPACITY = [0.2, 0.4, 0.6, 0.8, 1];
type OutputTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "getFgAnsi" | "getBgAnsi">>;

interface ActivityEntry {
  key: string;
  text: string;
}

function publicText(text: string): string {
  return sanitizeTerminalMultilineText(text).replace(/\t/g, "    ");
}

function fade(theme: OutputTheme, text: string, opacity: number): string {
  const foreground = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(theme.getFgAnsi?.("dim") ?? "");
  const background = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(theme.getBgAnsi?.("toolPendingBg") ?? "");
  if (foreground == null || background == null) {
    const gray = theme.fg("dim", text);
    return opacity < 1 ? `\x1b[2m${gray}\x1b[22m` : gray;
  }
  const rgb = [1, 2, 3].map((channel) => Math.round(
    Number(background[channel]) + (Number(foreground[channel]) - Number(background[channel])) * opacity,
  ));
  return `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
}

/** A disposable viewport over public story preparation output. */
export class StoryOutputCarousel {
  private entries: ActivityEntry[] = [];
  private displayed: ActivityEntry[] = [];
  private nextEntryId = 0;
  paused = false;

  get hasActivity(): boolean {
    return this.displayed.length > 0;
  }

  addActivity(activity: StoryAgentActivity): void {
    const entry = this.entryFor(activity);
    this.entries = this.entries.filter((candidate) => candidate.key !== entry.key);
    this.entries.push(entry);
    this.refresh();
  }

  togglePaused(): void {
    this.paused = !this.paused;
    this.refresh();
  }

  clear(): void {
    this.entries = [];
    this.displayed = [];
    this.nextEntryId = 0;
  }

  private entryFor(activity: StoryAgentActivity): ActivityEntry {
    switch (activity.kind) {
      case "text":
        return { key: `text:${activity.id}`, text: publicText(activity.text) };
      case "status":
        return { key: `status:${this.nextEntryId++}`, text: publicText(activity.text) };
      case "error":
        return { key: `error:${this.nextEntryId++}`, text: `Error · ${publicText(activity.text)}` };
    }
  }

  private refresh(): void {
    if (!this.paused) this.displayed = this.entries;
  }

  render(width: number, theme: OutputTheme): string[] {
    const blockWidth = Math.max(1, Math.min(120, width - 8));
    const left = Math.max(0, Math.floor((width - blockWidth) / 2));
    let visibleLines: string[] = [];
    for (let entry = this.displayed.length - 1; entry >= 0 && visibleLines.length < OPACITY.length; entry -= 1) {
      const lines = this.displayed[entry]!.text.split("\n");
      for (let line = lines.length - 1; line >= 0 && visibleLines.length < OPACITY.length; line -= 1) {
        const wrapped = wrapTextWithAnsi(lines[line]!, blockWidth);
        visibleLines = [...wrapped.slice(-(OPACITY.length - visibleLines.length)), ...visibleLines];
      }
    }
    const rows = [...Array<string>(OPACITY.length - visibleLines.length).fill(""), ...visibleLines];
    return rows.map((line, index) => {
      const colored = fade(theme, line, OPACITY[index]!);
      return " ".repeat(left) + colored + " ".repeat(Math.max(0, width - left - visibleWidth(line)));
    });
  }
}
