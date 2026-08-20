import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { BundledShikiThemeChoice } from "../workbench/node/shiki.js";

type SyntaxThemeUI = Pick<ExtensionContext["ui"], "custom">;

export async function pickSyntaxTheme(
  ui: SyntaxThemeUI,
  themes: readonly BundledShikiThemeChoice[],
  currentTheme: string,
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
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Select /code syntax theme")), 1, 0));
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

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
