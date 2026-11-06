import { Container, SelectList, Text, type Component, type SelectItem } from "@earendil-works/pi-tui";
import type { HostUI } from "../host/types.js";
import type { BundledShikiThemeChoice } from "../workbench/node/shiki.js";

type SyntaxThemeUI = Pick<HostUI, "custom">;

class Border implements Component {
  constructor(private readonly color: (text: string) => string) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [this.color("\u2500".repeat(Math.max(1, width)))];
  }
}

export async function pickSyntaxTheme(
  ui: SyntaxThemeUI,
  themes: readonly BundledShikiThemeChoice[],
  currentTheme: string,
  command = "/code",
): Promise<string | null> {
  const items: SelectItem[] = themes.map((theme) => ({
    value: theme.id,
    label: theme.displayName,
    description: `${theme.type} · ${theme.id}${theme.id === currentTheme ? " · current" : ""}`,
  }));

  return ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    const currentIndex = themes.findIndex((candidate) => candidate.id === currentTheme);
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);

    const container = new Container();
    container.addChild(new Border((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`Select ${command} syntax theme`)), 1, 0));
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel"), 1, 0));
    container.addChild(new Border((text: string) => theme.fg("accent", text)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
