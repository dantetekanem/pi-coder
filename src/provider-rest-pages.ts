import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfiguredField, renderProviderOperation, type ProviderSettings } from "./provider-settings.js";

export interface ProviderRestPage {
  rows: unknown[];
  nextPage?: number;
  coverage: "complete" | "partial";
}

/** Callers admit each projected page before the next configured command is issued. */
export async function fetchProviderRestPages(
  pi: ExtensionAPI, provider: ProviderSettings, operation: string,
  request: { repo: string; number: string; cwd: string }, previous?: ProviderRestPage, onPage?: (page: ProviderRestPage) => void,
): Promise<ProviderRestPage> {
  let accepted = previous;
  if (accepted != null && accepted.nextPage == null) return accepted;
  try {
    for (;;) {
      const page = accepted?.nextPage ?? 1;
      const rendered = renderProviderOperation(provider, `${operation}Page`, { repo: request.repo, number: request.number, page });
      const result = await pi.exec(provider.executable, rendered.args, { cwd: request.cwd, timeout: 45000 });
      if (result.code !== 0 || result.killed) throw new Error(result.stderr || "REST page unavailable.");
      const separator = result.stdout.match(/\r?\n\r?\n/);
      const headers = result.stdout.slice(0, separator?.index ?? 0);
      const status = Number(headers.match(/^HTTP\/\S+[ \t]+(\d{3})(?:[ \t\r\n]|$)/)?.[1]);
      if (separator?.index == null || !Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`REST page HTTP ${status || "status unavailable"}.`);
      const payload: unknown = JSON.parse(result.stdout.slice(separator.index + separator[0].length));
      const rows = readConfiguredField(provider, operation === "reviewComments" ? "pullRequestReviewComments" : operation, payload) ?? payload;
      if (!Array.isArray(rows)) throw new Error("REST page rows unavailable.");
      const merged = new Map<string | symbol, unknown>();
      for (const row of [...(accepted?.rows ?? []), ...rows]) {
        const id = readConfiguredField(provider, "commentId", row);
        const key = (typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isFinite(id)) ? String(id) : Symbol();
        merged.set(key, row);
      }
      const links = headers.split(/\r?\n/).filter((line) => /^link:/i.test(line)).flatMap((line) => line.slice(5).split(","))
        .map((entry) => entry.match(/^\s*<([^>]+)>\s*;\s*rel=(?:"([^"]+)"|([^;\s]+))(?:\s*;.*)?\s*$/i));
      const next = links.filter((link) => (link?.[2] ?? link?.[3] ?? "").toLowerCase().split(/\s+/).includes("next"));
      let incomplete = links.some((link) => link == null) || next.length > 1;
      let nextPage: number | undefined;
      if (!incomplete && next.length === 1) {
        try {
          const values = new URL(next[0]![1]!, "https://pagination.invalid").searchParams.getAll("page");
          const value = values[0] ?? "";
          if (values.length === 1 && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > page) nextPage = Number(value);
          else incomplete = true;
        } catch { incomplete = true; }
      }
      const candidate: ProviderRestPage = { rows: [...merged.values()], nextPage, coverage: incomplete || nextPage != null ? "partial" : "complete" };
      onPage?.(candidate);
      accepted = candidate;
      if (onPage == null || nextPage == null) return candidate;
    }
  } catch (error) {
    if (accepted == null) throw error;
    return accepted;
  }
}
