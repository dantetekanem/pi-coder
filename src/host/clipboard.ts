import { spawn } from "node:child_process";

const MAX_OSC52_ENCODED_LENGTH = 100_000;
const TOOL_TIMEOUT_MS = 5_000;

export interface ClipboardTool {
  command: string;
  args: string[];
}

export interface ClipboardEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isTerminal: boolean;
  runTool(tool: ClipboardTool, text: string): Promise<boolean>;
  writeTerminal(sequence: string): void;
}

export function clipboardTools(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardTool[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip", args: [] }];
  return [
    ...(env.TERMUX_VERSION ? [{ command: "termux-clipboard-set", args: [] }] : []),
    ...(env.WAYLAND_DISPLAY ? [{ command: "wl-copy", args: [] }] : []),
    ...(env.DISPLAY
      ? [
          { command: "xclip", args: ["-selection", "clipboard"] },
          { command: "xsel", args: ["--clipboard", "--input"] },
        ]
      : []),
  ];
}

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string, host: ClipboardEnvironment): boolean {
  if (!host.isTerminal) return false;
  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false;
  host.writeTerminal(`\x1b]52;c;${encoded}\x07`);
  return true;
}

export async function copyWithEnvironment(text: string, host: ClipboardEnvironment): Promise<void> {
  const remote = isRemoteSession(host.env);
  if (remote && emitOsc52(text, host)) return;
  for (const tool of clipboardTools(host.platform, host.env)) {
    if (await host.runTool(tool, text)) return;
  }
  if (!remote && emitOsc52(text, host)) return;
  throw new Error("Failed to copy to clipboard");
}

function runClipboardTool(tool: ClipboardTool, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (copied: boolean) => {
      clearTimeout(timer);
      resolve(copied);
    };
    const child = spawn(tool.command, tool.args, { stdio: ["pipe", "ignore", "ignore"] });
    timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, TOOL_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.stdin.on("error", () => undefined);
    child.stdin.end(text);
  });
}

export function copyToClipboard(text: string): Promise<void> {
  return copyWithEnvironment(text, {
    platform: process.platform,
    env: process.env,
    isTerminal: process.stdout.isTTY === true,
    runTool: runClipboardTool,
    writeTerminal: (sequence) => void process.stdout.write(sequence),
  });
}
