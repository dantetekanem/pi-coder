export const FILTER_CONFIG_ARGS = ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"] as const;

const FILTER_CONFIG_KEY = /^filter\.([A-Za-z0-9][A-Za-z0-9._-]*)\.(clean|smudge|process|required)$/;

export type FilterConfigPrefixParseResult =
  | { kind: "success"; prefixes: string[] }
  | { kind: "failure"; reason: "malformed" | "unsafe" };

/** Parses complete NUL-delimited filter config keys into stable, safe driver prefixes. */
export function parseFilterConfigPrefixes(output: string): FilterConfigPrefixParseResult {
  if (output === "" || !output.endsWith("\0")) return { kind: "failure", reason: "malformed" };

  const prefixes = new Set<string>();
  for (const key of output.slice(0, -1).split("\0")) {
    if (key.length === 0) return { kind: "failure", reason: "malformed" };
    const match = FILTER_CONFIG_KEY.exec(key);
    if (match?.[1] == null) return { kind: "failure", reason: "unsafe" };
    prefixes.add(`filter.${match[1]}`);
  }
  return { kind: "success", prefixes: [...prefixes].sort() };
}

/** Per-command overrides that prevent configured worktree filters from executing. */
export function filterOverrideArgs(prefix: string): string[] {
  return [
    "-c", `${prefix}.clean=`,
    "-c", `${prefix}.smudge=`,
    "-c", `${prefix}.process=`,
    "-c", `${prefix}.required=false`,
  ];
}
