import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ReviewTextSet {
  body?: string;
  comments: string[];
}

export type GrammarChangeKey = "body" | `comment:${number}`;

export interface GrammarTextChange {
  key: GrammarChangeKey;
  original: string;
  corrected: string;
  grammarOnly: boolean;
  reason: string;
}

export type GrammarReviewResult = {
  status: "safe";
  corrected: ReviewTextSet;
  changes: GrammarTextChange[];
} | {
  status: "review";
  corrected: ReviewTextSet;
  changes: GrammarTextChange[];
} | {
  status: "error";
  corrected: ReviewTextSet;
  changes: [];
  error: string;
};

const CORRECTION_SYSTEM_PROMPT = `You are a grammar editor for code review text. Correct only grammar, spelling, capitalization, punctuation, and awkward syntax required for clear grammatical English.

Preserve meaning, intent, tone, technical claims, identifiers, code, URLs, Markdown, numeric values, and requested scope. Word-order repairs, equivalent digit-to-word number style, and small clarity rewrites are allowed only when they express the same request. Do not add advice, strengthen or weaken claims, or change technical substance.

Return only JSON with this exact shape:
{"body":string|null,"comments":string[]}

Keep the comments array in the same order and with the same length. Use null when the input body is absent.`;

const VALIDATION_SYSTEM_PROMPT = `You are a strict semantic safety checker for corrected code review text. Compare every original and corrected item.

Set grammarOnly to true when the correction changes only grammar, spelling, capitalization, punctuation, number style, or word order and awkward syntax while preserving the same meaning, intent, tone, technical claims, and requested scope. For example, changing "can we have these 2 components in variables and isolated" to "Can we isolate these two components in variables" is grammarOnly because it repairs syntax without changing the request.

Set grammarOnly to false for changed requirements, modality, negation, technical identifiers, values, scope, tone, or advice. When uncertain, use false.

Return only JSON with this exact shape:
{"items":[{"key":"body|comment:N","grammarOnly":boolean,"reason":string}]}

Return exactly one item for every supplied change key.`;

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const parsed = JSON.parse(fenced?.[1] ?? trimmed) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
  return parsed as Record<string, unknown>;
}

function parseCorrectionResponse(original: ReviewTextSet, text: string): ReviewTextSet {
  const parsed = parseJsonObject(text);
  if (!Array.isArray(parsed.comments) || parsed.comments.length !== original.comments.length || parsed.comments.some((comment) => typeof comment !== "string")) {
    throw new Error("comments must be a same-length string array");
  }
  if (original.body == null) {
    if (parsed.body !== null) throw new Error("body must remain null when absent");
    return { comments: parsed.comments as string[] };
  }
  if (typeof parsed.body !== "string") throw new Error("body must be a string");
  return { body: parsed.body, comments: parsed.comments as string[] };
}

function getTextChanges(original: ReviewTextSet, corrected: ReviewTextSet): Array<Omit<GrammarTextChange, "grammarOnly" | "reason">> {
  const changes: Array<Omit<GrammarTextChange, "grammarOnly" | "reason">> = [];
  if (original.body != null && corrected.body != null && original.body !== corrected.body) {
    changes.push({ key: "body", original: original.body, corrected: corrected.body });
  }
  original.comments.forEach((comment, index) => {
    const correctedComment = corrected.comments[index]!;
    if (comment !== correctedComment) changes.push({ key: `comment:${index}`, original: comment, corrected: correctedComment });
  });
  return changes;
}

function parseValidationResponse(
  text: string,
  changes: Array<Omit<GrammarTextChange, "grammarOnly" | "reason">>,
): GrammarTextChange[] {
  const parsed = parseJsonObject(text);
  if (!Array.isArray(parsed.items)) throw new Error("items must be an array");
  const items = parsed.items.map((item) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) throw new Error("each validation item must be an object");
    const record = item as Record<string, unknown>;
    if (typeof record.key !== "string" || typeof record.grammarOnly !== "boolean" || typeof record.reason !== "string") {
      throw new Error("validation items need key, grammarOnly, and reason");
    }
    return { key: record.key, grammarOnly: record.grammarOnly, reason: record.reason };
  });
  return changes.map((change) => {
    const matches = items.filter((item) => item.key === change.key);
    if (matches.length !== 1) throw new Error(`expected one validation item for ${change.key}`);
    return { ...change, grammarOnly: matches[0]!.grammarOnly, reason: matches[0]!.reason };
  });
}

export function classifyGrammarReview(original: ReviewTextSet, correctionText: string, validationText: string): GrammarReviewResult {
  let corrected: ReviewTextSet;
  try {
    corrected = parseCorrectionResponse(original, correctionText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", corrected: original, changes: [], error: `Invalid grammar correction response: ${message}` };
  }

  const pendingChanges = getTextChanges(original, corrected);
  if (pendingChanges.length === 0) return { status: "safe", corrected, changes: [] };

  try {
    const changes = parseValidationResponse(validationText, pendingChanges);
    return {
      status: changes.every((change) => change.grammarOnly) ? "safe" : "review",
      corrected,
      changes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", corrected: original, changes: [], error: `Invalid grammar validation response: ${message}` };
  }
}

function responseText(response: Awaited<ReturnType<typeof complete>>): string {
  if (response.stopReason === "aborted") throw new Error("Grammar review was cancelled.");
  const text = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (text.length === 0) throw new Error("Grammar model returned no text.");
  return text;
}

async function modelText(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  systemPrompt: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  if (ctx.model == null) throw new Error("No Pi model is selected for grammar review.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error);
  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: JSON.stringify(input) }],
    timestamp: Date.now(),
  };
  const response = await complete(
    ctx.model,
    { systemPrompt, messages: [message] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );
  return responseText(response);
}

export async function reviewGrammar(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  original: ReviewTextSet,
  signal?: AbortSignal,
): Promise<GrammarReviewResult> {
  try {
    const correctionText = await modelText(ctx, CORRECTION_SYSTEM_PROMPT, original, signal);
    const corrected = parseCorrectionResponse(original, correctionText);
    const changes = getTextChanges(original, corrected);
    if (changes.length === 0) return { status: "safe", corrected, changes: [] };
    const validationText = await modelText(ctx, VALIDATION_SYSTEM_PROMPT, {
      changes: changes.map(({ key, original: originalText, corrected: correctedText }) => ({ key, original: originalText, corrected: correctedText })),
    }, signal);
    return classifyGrammarReview(original, correctionText, validationText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", corrected: original, changes: [], error: message };
  }
}
