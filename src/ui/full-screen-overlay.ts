export const fullScreenOverlayOptions = {
  overlay: true,
  overlayOptions: {
    anchor: "center" as const,
    width: "100%" as const,
    maxHeight: "100%" as const,
    minWidth: 40,
    margin: { top: 1, right: 0, bottom: 1, left: 0 },
  },
};

interface HerdrCommandResult {
  code: number;
  stdout: string;
  stderr?: string;
}

interface HerdrPaneZoomOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  run: (args: string[]) => Promise<HerdrCommandResult>;
  warn?: (message: string) => void;
}

function parseHerdrZoomState(stdout: string): boolean | null {
  try {
    const response = JSON.parse(stdout) as { result?: { layout?: { zoomed?: unknown } } };
    return typeof response.result?.layout?.zoomed === "boolean" ? response.result.layout.zoomed : null;
  } catch {
    return null;
  }
}

export async function withHerdrPaneZoom<T>(
  action: () => Promise<T>,
  options: HerdrPaneZoomOptions,
): Promise<T> {
  if ((options.environment ?? process.env).HERDR_ENV !== "1") return action();

  let layout: HerdrCommandResult;
  try {
    layout = await options.run(["pane", "layout", "--current"]);
  } catch {
    options.warn?.("Could not enable Herdr full-screen mode; opening /diff in the current pane.");
    return action();
  }

  const alreadyZoomed = layout.code === 0 ? parseHerdrZoomState(layout.stdout) : null;
  if (alreadyZoomed == null) {
    options.warn?.("Could not enable Herdr full-screen mode; opening /diff in the current pane.");
    return action();
  }
  if (alreadyZoomed) return action();

  let zoomed = false;
  try {
    zoomed = (await options.run(["pane", "zoom", "--current", "--on"])).code === 0;
  } catch {
    // Fall through to the normal in-pane review.
  }
  if (!zoomed) {
    options.warn?.("Could not enable Herdr full-screen mode; opening /diff in the current pane.");
    return action();
  }

  try {
    return await action();
  } finally {
    try {
      const restored = await options.run(["pane", "zoom", "--current", "--off"]);
      if (restored.code !== 0) options.warn?.("Could not restore the Herdr pane layout after /diff closed.");
    } catch {
      options.warn?.("Could not restore the Herdr pane layout after /diff closed.");
    }
  }
}
