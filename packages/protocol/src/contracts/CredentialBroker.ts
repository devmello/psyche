import type { Target } from "../common.ts";
import type { CredentialKind, CredentialMeta } from "../schemas/integrations.ts";
import type { CallOptions, Unsubscribe } from "./Clock.ts";

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

/**
 * The element a browser fill would type into, as the executor found it focused at fill time
 * (S23 design-01). The broker checks it against the field being resolved, so a password cannot
 * be typed into a comment box on its own bound origin. Strings are lowercased by the executor.
 */
export interface FillElement {
  /** `input`, `textarea`, `select`, `div`, … */
  tagName: string;
  /** The input's `type` (`password`, `email`, `text`, …). */
  type?: string;
  /** The `autocomplete` attribute, e.g. `current-password` or `section-x username`. */
  autocomplete?: string;
  inputMode?: string;
  role?: string;
  contentEditable?: boolean;
  /** Origin of the frame that owns the element. A cross-origin frame never matches. */
  frameOrigin: string;
  /** Origin of the containing form's resolved `action`, when the element is in a form. */
  formActionOrigin?: string;
  /** The containing form also holds a password field (login forms). */
  formHasPassword?: boolean;
  maxLength?: number;
}

export type FillElementCheck = { ok: true } | { ok: false; reason: string };

const NEVER_FILLED_TYPES = new Set([
  "search",
  "url",
  "hidden",
  "file",
  "submit",
  "button",
  "checkbox",
  "radio",
  "range",
  "color",
  "date",
  "image",
  "reset",
]);

const autocompleteTokens = (el: FillElement): string[] =>
  (el.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Field-class rule shared by every `CredentialBroker` (S23 design-01): `password` (and a login's
 * primary secret) only into `type=password`;
 * `username` only into an email / text / tel field marked `username` / `email` or inside a form
 * that also holds a password; `totp` only into a `one-time-code` field or a short numeric one;
 * `token` / `header` only into `type=password`. Never `textarea`, `contenteditable`, `select`,
 * `role=textbox` on a non-input, or search / url / hidden inputs.
 */
export function fillElementAccepts(
  field: CredentialField | "secret",
  element: FillElement,
  kind: CredentialKind = "login",
): FillElementCheck {
  const tag = element.tagName.toLowerCase();
  const type = (element.type ?? "text").toLowerCase();
  if (tag !== "input") return { ok: false, reason: `not_input:${tag}` };
  if (element.contentEditable === true) return { ok: false, reason: "contenteditable" };
  if (NEVER_FILLED_TYPES.has(type)) return { ok: false, reason: `input_type:${type}` };
  const ac = autocompleteTokens(element);
  const resolved = field === "secret" ? (kind === "login" ? "password" : "token") : field;
  switch (resolved) {
    case "password":
      // Only `type=password`: a "show password" text field would put the value on screen.
      return type === "password" ? { ok: true } : { ok: false, reason: "not_password_field" };
    case "username":
      if (!["email", "text", "tel"].includes(type)) return { ok: false, reason: "not_text_field" };
      if (ac.includes("username") || ac.includes("email") || element.formHasPassword === true) {
        return { ok: true };
      }
      return { ok: false, reason: "not_username_field" };
    case "totp": {
      if (ac.includes("one-time-code")) return { ok: true };
      const numeric = element.inputMode === "numeric" || type === "number" || type === "tel";
      const max = element.maxLength ?? 0;
      if (numeric && max >= 6 && max <= 8) return { ok: true };
      return { ok: false, reason: "not_otp_field" };
    }
    default:
      return type === "password" ? { ok: true } : { ok: false, reason: "not_secret_field" };
  }
}

export interface ResolveOptions extends CallOptions {
  executor?: CredentialExecutor;
  taskId?: string;
  /**
   * Browser fills: the focused element. Brokers refuse a browser resolve without it and check
   * it with {@link fillElementAccepts} and against the target origin.
   */
  element?: FillElement;
  /** Browser fills: the approved field selector (`ref_N`), part of the binding hash. */
  selector?: string;
  /**
   * The tool call this fill runs for, when the agent loop approved it. The broker recomputes the
   * loop's binding (`toolCallBindingHash(tool, params, {kind: "credential_fill", bindingFields})`,
   * with the fill fields it derives itself) and checks it against the approval record it reads by
   * id; it never takes a hash from the caller. Without it the approval must bind the bare fill
   * fields (`credential_fill` requests built by the broker itself).
   */
  call?: { tool: string; params: unknown; toolCallId?: string };
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

/** Tokens a connector hands to the vault after an OAuth exchange or refresh. */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ISO-8601. */
  expiresAt?: string;
  scopes?: string[];
}

export interface ConnectorTokenInput {
  connectorId: string;
  slug: string;
  name: string;
  /** Usually `[{connector: connectorId}]` plus the API hosts the token is sent to. */
  bindings: CredentialMeta["bindings"];
  tokens: OAuthTokenSet;
}

/** Emitted when a connector-owned item is revoked, so connection-bound work is invalidated. */
export interface CredentialRevokedEvent {
  credentialId: string;
  slug: string;
  connectorId: string;
  reason: "disconnect" | "revoked" | "deleted";
  at: number;
}

/**
 * Connector-owned OAuth items (security §4.8, feature G13; owner S06, used by S09). Only the
 * owning connector may read, refresh or revoke them; values still travel only in
 * `ResolvedSecret` handles. Rejects with `forbidden` when `connectorId` is not the owner.
 */
export interface ConnectorCredentialStore {
  store(input: ConnectorTokenInput): Promise<CredentialMeta>;
  /** The current access token for the owner's own API call (the action itself is approved). */
  accessToken(credentialId: string, connectorId: string): Promise<ResolvedSecret>;
  /**
   * Refresh: `refresher` gets the refresh token and returns the new set, which replaces the old
   * one atomically (rotated refresh tokens included). A failing refresher leaves the item as is.
   */
  rotate(
    credentialId: string,
    connectorId: string,
    refresher: (refreshToken: ResolvedSecret) => Promise<OAuthTokenSet>,
  ): Promise<CredentialMeta>;
  /** Disconnect: delete the item (values overwritten) and emit {@link CredentialRevokedEvent}. */
  revoke(
    credentialId: string,
    connectorId: string,
    reason?: CredentialRevokedEvent["reason"],
  ): Promise<void>;
  onRevoked(listener: (event: CredentialRevokedEvent) => void): Unsubscribe;
}
