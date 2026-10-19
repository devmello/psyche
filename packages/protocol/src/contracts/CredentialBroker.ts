import type { Target } from "../common.ts";
import type { CredentialMeta } from "../schemas/integrations.ts";
import type { CallOptions } from "./Clock.ts";

/**
 * Credential Broker contract (architecture §4.7; data model §6; security §4.5; owner S06).
 *
 * The model only ever sees placeholders such as `{{cred:github-login}}`. Only executors
 * (browser fill, connector HTTP client, sandbox env injector) call `resolve`, and only after
 * the Permission Broker approved a `credential_fill`. The secret never returns to the agent
 * loop: `resolve` hands back a `ResolvedSecret`, whose string, JSON and inspect forms are all
 * `[redacted]`; the value is reachable only inside `use(fn)`.
 */

export const CREDENTIAL_FIELDS = ["username", "password", "totp", "token", "header"] as const;
export type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

/** `{{cred:<slug>[.field]}}` (security §4.5). Not global: use `parsePlaceholders` to find all. */
export const PLACEHOLDER_PATTERN =
  /\{\{cred:([a-z0-9][a-z0-9-]{0,63})(?:\.(username|password|totp|token|header))?\}\}/;

export interface PlaceholderRef {
  /** The full placeholder text, e.g. `{{cred:github-login.username}}`. */
  raw: string;
  slug: string;
  /** Absent means the item's primary secret. */
  field?: CredentialField;
  index: number;
}

export type ParsePlaceholders = (text: string) => PlaceholderRef[];

/** Every placeholder in `text`, in order. */
export const parsePlaceholders: ParsePlaceholders = (text) => {
  const re = new RegExp(PLACEHOLDER_PATTERN.source, "g");
  const out: PlaceholderRef[] = [];
  for (const m of text.matchAll(re)) {
    const ref: PlaceholderRef = { raw: m[0], slug: m[1] ?? "", index: m.index };
    if (m[2] !== undefined) ref.field = m[2] as CredentialField;
    out.push(ref);
  }
  return out;
};

const REDACTED = "[redacted]";

/**
 * One-shot handle around a secret value. Accidental logging prints `[redacted]`
 * (`String()`, template literals, `JSON.stringify`, `util.inspect`); the value lives in an
 * ES private field and is reachable only through `use`. After `maxUses` calls (default 1) or
 * `dispose()` the handle is spent and `use` throws.
 */
export class ResolvedSecret {
  readonly credentialId: string;
  readonly field: CredentialField | "secret";
  readonly target: Target;
  #value: string | undefined;
  #usesLeft: number;

  constructor(
    value: string,
    meta: { credentialId: string; field?: CredentialField; target: Target; maxUses?: number },
  ) {
    this.#value = value;
    this.#usesLeft = meta.maxUses ?? 1;
    this.credentialId = meta.credentialId;
    this.field = meta.field ?? "secret";
    this.target = meta.target;
  }

  /** Run `fn` with the secret. Do not let the value escape `fn`. */
  use<T>(fn: (value: string) => T): T {
    if (this.#value === undefined || this.#usesLeft <= 0) {
      throw new Error("ResolvedSecret is spent");
    }
    this.#usesLeft -= 1;
    const value = this.#value;
    if (this.#usesLeft <= 0) this.#value = undefined;
    return fn(value);
  }

  get spent(): boolean {
    return this.#value === undefined || this.#usesLeft <= 0;
  }

  dispose(): void {
    this.#value = undefined;
    this.#usesLeft = 0;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return "ResolvedSecret";
  }
}

export type CredentialExecutor = "browser" | "connector" | "sandbox" | "ssh";

export interface ResolveOptions extends CallOptions {
  executor?: CredentialExecutor;
  taskId?: string;
}

export interface CredentialBroker {
  /**
   * Resolve a placeholder for one executor call. Rejects (PsycheError) when the placeholder is
   * malformed (`invalid_params`), the item is unknown (`not_found`), `approvalId` is missing or
   * not an approved `credential_fill` (`approval_required`), or `target` matches none of the
   * item's bindings (`policy_denied`).
   */
  resolve(
    placeholder: string,
    target: Target,
    approvalId: string,
    options?: ResolveOptions,
  ): Promise<ResolvedSecret>;
  /** Metadata only: names, kinds, slugs, bound origins. Never values. */
  list(): Promise<CredentialMeta[]>;
  get(id: string): Promise<CredentialMeta | undefined>;
  /** Replace every known secret value (and its URL / base64 encodings) with `•••`. */
  redact(text: string): string;
}
