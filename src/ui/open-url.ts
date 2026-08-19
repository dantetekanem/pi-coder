import { spawn } from "node:child_process";

const MAX_URL_LENGTH = 2048;
const SAFE_URL_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@%+=,]+$/;

export interface UrlOpenCommand {
  command: string;
  args: string[];
}

export type UrlOpenResult =
  | { status: "opened"; url: string }
  | { status: "invalid" }
  | { status: "failed"; url: string; error: string };

export type UrlLauncher = (command: UrlOpenCommand) => Promise<void>;

/**
 * Accepts only a canonical http(s) URL with no credentials and no character that a
 * shell or `cmd.exe` could reinterpret, so the opener never needs quoting or a shell.
 */
export function normalizeExternalUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return null;
  if (!SAFE_URL_CHARACTERS.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.hostname.length === 0) return null;
  if (!SAFE_URL_CHARACTERS.test(parsed.href)) return null;
  return parsed.href;
}

export function getUrlOpenCommand(url: string, platform: NodeJS.Platform = process.platform): UrlOpenCommand | null {
  const safeUrl = normalizeExternalUrl(url);
  if (safeUrl == null) return null;
  if (platform === "darwin") return { command: "open", args: [safeUrl] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", safeUrl] };
  return { command: "xdg-open", args: [safeUrl] };
}

function launchDetached({ command, args }: UrlOpenCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function openExternalUrl(
  url: string | null | undefined,
  options: { platform?: NodeJS.Platform; launch?: UrlLauncher } = {},
): Promise<UrlOpenResult> {
  const safeUrl = normalizeExternalUrl(url);
  if (safeUrl == null) return { status: "invalid" };

  const command = getUrlOpenCommand(safeUrl, options.platform ?? process.platform);
  if (command == null) return { status: "invalid" };

  try {
    await (options.launch ?? launchDetached)(command);
    return { status: "opened", url: safeUrl };
  } catch (error) {
    return { status: "failed", url: safeUrl, error: error instanceof Error ? error.message : String(error) };
  }
}
