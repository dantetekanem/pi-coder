export interface HermeticGitInvocation {
  command: "git";
  args: string[];
  options: {
    cwd: string;
    stdio: ["ignore", "pipe", "pipe"];
    env: NodeJS.ProcessEnv;
  };
}

function sameArgs(actual: readonly string[], allowed: readonly string[]): boolean {
  return actual.length === allowed.length && actual.every((argument, index) => argument === allowed[index]);
}

/** Builds one shell-free Git process after exact caller-owned vector validation. */
export function buildHermeticGitInvocation(
  cwd: string,
  args: readonly string[],
  allowedVectors: readonly (readonly string[])[],
  deniedMessage = "Git command is not allowlisted.",
): HermeticGitInvocation {
  if (!allowedVectors.some((allowed) => sameArgs(args, allowed))) throw new Error(deniedMessage);
  return {
    command: "git",
    args: ["-c", "core.fsmonitor=false", ...args],
    options: {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
    },
  };
}
