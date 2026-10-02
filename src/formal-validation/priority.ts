import { identifierWords } from "./source.js";

export type ValidationPriority = "critical" | "needed" | "minor";

export type RiskCategory =
  | "migration"
  | "security"
  | "escaping"
  | "money"
  | "destructive"
  | "ordering"
  | "contract"
  | "flag"
  | "dependency"
  | "instructions"
  | "documentation"
  | "lockfile"
  | "snapshot"
  | "copy"
  | "formatting"
  | "comments"
  | "imports";

export interface UnitRisk {
  priority: ValidationPriority;
  categories: RiskCategory[];
  reasons: string[];
  /** Correctness may depend on the order of steps: retries, locks, jobs, status changes, phased migrations. */
  ordering: boolean;
}

const RANK: Record<ValidationPriority, number> = { minor: 0, needed: 1, critical: 2 };

export function higherPriority(a: ValidationPriority, b: ValidationPriority): ValidationPriority {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Sorts critical before needed before minor. */
export function comparePriority(a: ValidationPriority, b: ValidationPriority): number {
  return RANK[b] - RANK[a];
}

interface PathRule {
  category: RiskCategory;
  label: string;
  path: RegExp;
}

interface SignalRule {
  category: RiskCategory;
  label: string;
  priority: Exclude<ValidationPriority, "minor">;
  ordering?: boolean;
  path?: RegExp;
  pattern?: RegExp;
  words?: readonly string[];
  phrases?: readonly string[];
}

const INSTRUCTION_PATH = /(?:^|\/)(?:prompts?|skills?|agents?)\/(?:[^/]+\/)*[^/]+\.md$|(?:^|\/)(?:SKILL|AGENTS|CLAUDE)\.md$/i;

const MINOR_PATHS: readonly PathRule[] = [
  { category: "lockfile", label: "dependency lockfile", path: /(?:^|\/)(?:Gemfile\.lock|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock|Podfile\.lock|mix\.lock)$/ },
  { category: "snapshot", label: "generated snapshot", path: /(?:^|\/)__snapshots__\/|\.snap$/ },
  { category: "copy", label: "translation copy", path: /(?:^|\/)(?:locales?|i18n|translations?)\// },
  { category: "documentation", label: "documentation", path: /\.(?:md|mdx|markdown|txt|rst|adoc)$|(?:^|\/)(?:docs?|documentation)\/|(?:^|\/)(?:CHANGELOG|README|LICENSE|NOTICE|CONTRIBUTING|CODEOWNERS)(?:\.[^/]*)?$/i },
];

const SIGNALS: readonly SignalRule[] = [
  {
    category: "migration",
    label: "schema or data migration",
    priority: "critical",
    ordering: true,
    path: /(?:^|\/)db\/(?:migrate|post_migrate|data_migrate|data_migrations)\/|(?:^|\/)migrations?\/|(?:^|\/)db\/(?:schema\.rb|structure\.sql)$|\.sql$/,
    pattern: /\bActiveRecord::Migration\b|\b(?:create_table|drop_table|add_column|remove_column|change_column(?:_null|_default)?|rename_column|add_index|remove_index|add_reference|add_foreign_key)\b/,
  },
  {
    category: "security",
    label: "access or secrets",
    priority: "critical",
    path: /(?:^|\/)(?:auth|authn|authz|authentication|authorization|security|permissions?|polic(?:y|ies)|sessions?|crypto)(?:\/|_|-|\.)/i,
    words: [
      "authorize", "authorized", "authorizes", "authorization", "authorizer", "unauthorized", "authenticate", "authenticated",
      "authentication", "authenticator", "unauthenticated", "permission", "permissions", "permitted", "privilege", "privileges",
      "policy", "policies", "acl", "csrf", "xsrf", "cors", "csp", "credential", "credentials", "password", "passwords",
      "passphrase", "secret", "secrets", "jwt", "oauth", "saml", "hmac", "signature", "encrypt", "encrypted", "encryption",
      "decrypt", "decrypted", "decryption", "cipher", "impersonate", "impersonation", "forbidden", "otp", "mfa", "totp",
      "nonce", "bcrypt",
    ],
    phrases: [
      "access token", "refresh token", "auth token", "api key", "api token", "csrf token", "session token", "signup token",
      "reset token", "bearer token", "access control", "html safe", "inner html",
    ],
  },
  {
    category: "security",
    label: "injection sink or subprocess",
    priority: "critical",
    pattern: /dangerouslySetInnerHTML|\.html_safe\b|\braw\(|\b(?:instance|class|module)_eval\b|\beval\s*\(|\bconstantize\b|\bOpen3\.|\bsystem\s*\(|\bexec(?:File)?(?:Sync)?\s*\(|\bspawn(?:Sync)?\s*\(|child_process|`[^`\n]*#\{/,
  },
  {
    category: "escaping",
    label: "sanitizing or escaping",
    priority: "needed",
    words: ["sanitize", "sanitized", "sanitizer", "sanitization", "escape", "escaped", "unescape", "scrub", "redact", "redacted"],
  },
  {
    category: "money",
    label: "money or billing",
    priority: "critical",
    words: [
      "price", "prices", "pricing", "priced", "amount", "amounts", "charge", "charges", "charged", "chargeback", "refund",
      "refunds", "refunded", "refundable", "payment", "payments", "paid", "payout", "payouts", "invoice", "invoices", "invoiced",
      "billing", "billable", "billed", "bill", "bills", "currency", "currencies", "money", "balance", "balances", "discount",
      "discounts", "discounted", "tax", "taxes", "taxable", "fee", "fees", "cents", "subtotal", "credit", "credits", "debit",
      "debits", "subscription", "subscriptions", "proration", "prorate", "prorated", "revenue", "wallet", "ledger", "payable",
      "receivable", "purchase", "purchases", "purchased", "entitlement", "entitlements",
    ],
  },
  {
    category: "destructive",
    label: "deletes or bulk-writes data",
    priority: "critical",
    pattern: /\b(?:destroy_all|delete_all|update_all|update_columns?|insert_all!?|upsert_all|truncate|really_destroy!?|purge(?:_later)?)\b|\bDELETE\s+FROM\b|\bUPDATE\s+[`"\w.]+\s+SET\b|\bDROP\s+(?:TABLE|COLUMN|INDEX)\b|\b(?:rm|rmdir|unlink)(?:Sync)?\s*\(|\brm_rf\b|\.destroy!?(?:\b|\()/i,
  },
  {
    category: "ordering",
    label: "order of steps",
    priority: "needed",
    ordering: true,
    path: /(?:^|\/)(?:jobs?|workers?|consumers?|subscribers?)\/|_(?:job|worker)\.rb$|Job\.[cm]?[jt]sx?$/,
    pattern: /\bwith_lock\b|\block!|\bperform_(?:later|async)\b|\bFOR\s+UPDATE\b|\bSET\s+NX\b|\bexpectedGeneration\b/,
    words: [
      "lock", "locks", "locked", "locking", "unlock", "mutex", "semaphore", "transaction", "transactions", "retry", "retries",
      "retried", "retrying", "idempotent", "idempotency", "idempotence", "concurrent", "concurrency", "concurrently", "race",
      "atomic", "atomically", "enqueue", "enqueued", "dequeue", "webhook", "webhooks", "lease", "leases", "quota", "quotas",
      "inventory", "increment", "decrement", "optimistic", "debounce", "throttle", "cron",
    ],
    phrases: ["state machine", "compare and", "perform later"],
  },
  {
    category: "contract",
    label: "public interface",
    priority: "needed",
    path: /(?:^|\/)(?:app\/graphql|graphql|api|apis|routes|controllers?|webhooks?)\/|\.graphql$|\.proto$|openapi|swagger|config\/routes\.rb$|\.d\.ts$/,
    pattern: /\bregister(?:Tool|Command|Shortcut)\(|^\s*(?:field|argument)\s+:\w+/m,
  },
  {
    category: "flag",
    label: "feature flag or rollout",
    priority: "needed",
    pattern: /\b(?:Flipper|Verdict|feature_enabled\?|beta_flag|flag_enabled\??|enabled_for\??)\b/,
    words: ["experiment", "experiments", "rollout", "rollouts", "beta"],
    phrases: ["feature flag", "beta flag", "kill switch", "enable flag", "disable flag", "flag enabled", "flag disabled"],
  },
  {
    category: "dependency",
    label: "dependency manifest",
    priority: "needed",
    path: /(?:^|\/)(?:package\.json|Gemfile|[^/]+\.gemspec|requirements(?:-\w+)?\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Podfile)$/,
  },
];

// Model methods often write through self, so a bare `update!(...)` counts as much as `record.update!(...)`.
const RUBY_STATE_WRITE = /(?:^|[\s.(])(?:save|create|update|update_attribute|update_columns?|insert|upsert|increment|decrement|destroy|toggle)!?(?=[\s(]|$)/m;
const STATE_WRITE = /\b(?:writeFile|rename|appendFile|unlink)(?:Sync)?\s*\(|\.(?:save|insert|upsert|persist|commit)\s*\(|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bsetItem\(/i;

function writesState(path: string, text: string): boolean {
  return (path.endsWith(".rb") && RUBY_STATE_WRITE.test(text)) || STATE_WRITE.test(text);
}
const COMMENT_LINE = /^\s*(?:#(?!\{)|\/\/|\/\*|\*|<!--|-->|--\s|;;)/;
const IMPORT_LINE = /^\s*(?:import[\s({]|export\s+(?:\*|\{[^}]*\})\s+from\s|(?:const|let|var)\s+[\w${},\s]+=\s*require\(|require(?:_relative)?[\s(]|from\s+[\w.]+\s+import\s|using\s+[\w.]+;\s*$|@import\s)/;

export function isImportLine(line: string): boolean {
  return IMPORT_LINE.test(line);
}

export function isCommentLine(line: string): boolean {
  return COMMENT_LINE.test(line);
}

const MECHANICAL_LABELS = {
  whitespace: "whitespace or line breaks only",
  blank: "blank lines only",
  comments: "comments only",
  imports: "imports only",
} as const;

/** Reasons that only minimize a unit; they read as noise beside a reason to verify it. */
export const MINOR_REASONS: ReadonlySet<string> = new Set([...MINOR_PATHS.map((rule) => rule.label), ...Object.values(MECHANICAL_LABELS)]);

function mechanicalChange(added: readonly string[], deleted: readonly string[]): { category: RiskCategory; label: string } | undefined {
  const all = [...added, ...deleted];
  if (all.length === 0) return undefined;
  const squash = (lines: readonly string[]) => lines.join("").replace(/\s+/g, "");
  if (added.length > 0 && deleted.length > 0 && squash(added) === squash(deleted)) {
    return { category: "formatting", label: MECHANICAL_LABELS.whitespace };
  }
  const meaningful = all.filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return { category: "formatting", label: MECHANICAL_LABELS.blank };
  if (meaningful.every((line) => COMMENT_LINE.test(line))) return { category: "comments", label: MECHANICAL_LABELS.comments };
  if (meaningful.every((line) => COMMENT_LINE.test(line) || IMPORT_LINE.test(line))) return { category: "imports", label: MECHANICAL_LABELS.imports };
  return undefined;
}

function matchedTerms(rule: SignalRule, path: string, text: string, words: ReadonlySet<string>, phrases: ReadonlySet<string>): string[] {
  const terms: string[] = [];
  const pathMatch = rule.path?.exec(path);
  if (pathMatch != null) terms.push(pathMatch[0].replace(/^\/|[/_.-]$/g, ""));
  const patternMatch = rule.pattern?.exec(text);
  if (patternMatch != null) terms.push(patternMatch[0].trim().slice(0, 40));
  for (const phrase of rule.phrases ?? []) if (phrases.has(phrase)) terms.push(phrase);
  for (const word of rule.words ?? []) if (words.has(word)) terms.push(word);
  return [...new Set(terms)];
}

/**
 * Ranks one changed unit for verification from its path, symbol and changed lines. Path and
 * mechanical rules minimize docs, lockfiles and comment/import/whitespace edits; signal rules
 * raise money, access, data, migration and order-of-steps changes. Reasons name the matched terms.
 */
export function classifyUnitRisk(unit: { path: string; symbol: string }, added: readonly string[], deleted: readonly string[]): UnitRisk {
  const instructions = INSTRUCTION_PATH.test(unit.path);
  if (!instructions) {
    const minorPath = MINOR_PATHS.find((rule) => rule.path.test(unit.path));
    if (minorPath != null) return { priority: "minor", categories: [minorPath.category], reasons: [minorPath.label], ordering: false };
    const mechanical = mechanicalChange(added, deleted);
    if (mechanical != null) return { priority: "minor", categories: [mechanical.category], reasons: [mechanical.label], ordering: false };
  }
  const text = [...added, ...deleted].join("\n");
  const vocabulary = identifierWords(`${unit.symbol.startsWith("lines ") ? "" : unit.symbol}\n${text}`);
  const words = new Set(vocabulary);
  const phrases = new Set(vocabulary.slice(1).map((word, index) => `${vocabulary[index]} ${word}`));
  let priority: ValidationPriority = "needed";
  const categories = new Set<RiskCategory>();
  const reasons: string[] = [];
  let ordering = false;
  if (instructions) {
    categories.add("instructions");
    reasons.push("model instructions");
  }
  for (const rule of SIGNALS) {
    const terms = matchedTerms(rule, unit.path, text, words, phrases);
    if (terms.length === 0) continue;
    const escalated = rule.category === "ordering" && writesState(unit.path, text);
    priority = higherPriority(priority, escalated ? "critical" : rule.priority);
    categories.add(rule.category);
    ordering ||= rule.ordering === true;
    reasons.push(`${rule.label}${escalated ? " with state writes" : ""} (${terms.slice(0, 3).join(", ")})`);
  }
  return { priority, categories: [...categories], reasons, ordering };
}
