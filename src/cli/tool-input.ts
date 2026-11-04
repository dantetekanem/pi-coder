import type { TSchema } from "typebox";
import { Value } from "typebox/value";

const MAX_ERRORS = 5;

/** Pi checks tool arguments against the schema before a tool runs; the terminal and MCP entry points do the same. */
export function toolInputErrors(parameters: TSchema | undefined, input: unknown): string[] {
  if (parameters === undefined) return [];
  let errors: string[];
  try {
    errors = [...Value.Errors(parameters, input)].map((error) => `${error.instancePath || "/"} ${error.message}`);
  } catch {
    return [];
  }
  return [...new Set(errors)].slice(0, MAX_ERRORS);
}

export function formatToolInputErrors(name: string, errors: readonly string[]): string {
  return `Invalid input for ${name}: ${errors.join("; ")}.`;
}
