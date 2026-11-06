import { createHostTheme, DARK_THEME } from "../../cli/theme.js";

export function createDarkTestTheme() {
  return createHostTheme(DARK_THEME, "none");
}
