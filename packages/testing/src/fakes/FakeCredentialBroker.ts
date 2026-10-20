import { createHash, sign as edSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  type BotAuthKey,
  type Clock,
  type ConnectorCredentialStore,
  type ConnectorTokenInput,
  type CredentialBinding,
  type CredentialBroker,
  type CredentialField,
  type CredentialKind,
  type CredentialMeta,
  type CredentialRevokedEvent,
  fillElementAccepts,
  type OAuthTokenSet,
  PLACEHOLDER_PATTERN,
  ResolvedSecret,
  type ResolveOptions,
  type Target,
  type Unsubscribe,
} from "@psyche/protocol";
import { FakeClock, toIso } from "../clock.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { base64Fragments, registerSecret } from "../secrets.ts";
import { fail } from "./errors.ts";

export interface FakeCredentialInput {
  slug: string;
  name?: string;
  kind?: CredentialKind;
  bindings: CredentialBinding[];
  /** Primary secret (password / token). */
  secret: string;
  username?: string;
  totp?: string;
  header?: string;
}

export type ApprovalVerifier = (
  approvalId: string,
  meta: CredentialMeta,
  target: Target,
) => boolean | Promise<boolean>;

export interface FakeCredentialBrokerOptions {
  clock?: Clock;
  ids?: IdGenerator;
  /**
   * Decides whether `approvalId` authorizes this fill. Default: an approval registered with
   * `approve(id, {slug, origin, scope})` for exactly this item and origin; `once` approvals are
   * consumed by the first successful resolve.
   */
  verifyApproval?: ApprovalVerifier;
}

/** What a `credential_fill` approval is bound to (security §3.5: item id + origin). */
export interface FakeFillApproval {
  slug: string;
  origin: string;
  /** `once` (default) is consumed on use; `site` is a standing grant for that origin. */
  scope?: "once" | "site";
}

interface Item {
  meta: CredentialMeta;
  values: Partial<Record<CredentialField | "secret" | "refresh", string>>;
}

/** Origin of a URL-ish target value, or the value itself. */
function canonicalOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function canonicalHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

/**
 * True when `target` matches one of the item's bindings exactly (security §4.5). Opaque origins
 * (`"null"`: `android://…`, `data:`, any non-special scheme) never match (S23 design-13).
 */
export function bindingMatches(bindings: CredentialBinding[], target: Target): boolean {
  return bindings.some((b) => {
    if ("origin" in b) {
      const origin = canonicalOrigin(target.value);
      return origin !== "null" && origin === canonicalOrigin(b.origin);
    }
    if ("host" in b) return canonicalHost(target.value) === b.host;
    return target.kind === "account" && target.value === b.connector;
  });
}

/**
 * In-memory vault. Every secret added is registered with the secret-leak checker, so
 * `assertNoSecrets` catches it anywhere in model-visible output. `resolve` requires a matching
 * binding and an approved `approvalId`, and returns a one-shot `ResolvedSecret` handle.
 */
export class FakeCredentialBroker implements CredentialBroker, ConnectorCredentialStore {
  readonly clock: Clock;
  #ids: IdGenerator;
  #items = new Map<string, Item>();
  #approved = new Map<string, FakeFillApproval & { used: boolean }>();
  #verify: ApprovalVerifier;
  #revokedListeners = new Set<(event: CredentialRevokedEvent) => void>();
  #botAuth: { key: BotAuthKey; privateKey: KeyObject } | undefined;
  /** Every Web Bot Auth signature made (counts only), for tests. */
  botAuthSignatures = 0;
  /** Every successful resolve (no values), like `credential_uses`. */
  readonly uses: { credentialId: string; target: string; approvalId: string; executor?: string }[] =
    [];

  constructor(options: FakeCredentialBrokerOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.#ids = options.ids ?? createIdGenerator();
    this.#verify =
      options.verifyApproval ??
      ((id, meta, target) => {
        const a = this.#approved.get(id);
        if (a === undefined || a.used) return false;
        if (a.slug !== meta.slug || canonicalOrigin(a.origin) !== canonicalOrigin(target.value)) {
          return false;
        }
        if ((a.scope ?? "once") === "once") a.used = true;
        return true;
      });
  }

  /** Add an item; its values are registered with the secret-leak checker. */
  add(input: FakeCredentialInput): CredentialMeta {
    const now = toIso(this.clock.now());
    const meta: CredentialMeta = {
      id: this.#ids.next("cred"),
      kind: input.kind ?? "login",
      name: input.name ?? input.slug,
      slug: input.slug,
      bindings: structuredClone(input.bindings),
      ownerConnectorId: null,
      lastUsedAt: null,
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const values: Item["values"] = { secret: input.secret };
    if (input.kind === "api_key" || input.kind === "oauth_token") values.token = input.secret;
    else values.password = input.secret;
    if (input.username !== undefined) values.username = input.username;
    if (input.totp !== undefined) values.totp = input.totp;
    if (input.header !== undefined) values.header = input.header;
    for (const [field, value] of Object.entries(values)) {
      if (value !== undefined && value.length >= 6 && field !== "username") {
        registerSecret(value, `cred:${input.slug}.${field}`);
      }
    }
    this.#items.set(meta.slug, { meta, values });
    return structuredClone(meta);
  }

  /** Record an approved `credential_fill` for one item and origin (default verifier). */
  approve(approvalId: string, binding: FakeFillApproval): this {
    this.#approved.set(approvalId, { ...binding, used: false });
    return this;
  }

  async resolve(
    placeholder: string,
    target: Target,
    approvalId: string,
    options: ResolveOptions = {},
  ): Promise<ResolvedSecret> {
    if (options.signal?.aborted === true) return fail("cancelled", "resolve aborted");
    const m = new RegExp(`^${PLACEHOLDER_PATTERN.source}$`).exec(placeholder);
    if (m === null) return fail("invalid_params", "not a credential placeholder");
    const slug = m[1] ?? "";
    const field = m[2] as CredentialField | undefined;
    const item = this.#items.get(slug);
    if (item === undefined) return fail("not_found", `credential ${slug} not found`);
    if (typeof approvalId !== "string" || approvalId.length === 0) {
      return fail("approval_required", "credential fills require an approval");
    }
    if (!bindingMatches(item.meta.bindings, target)) {
      return fail("policy_denied", "target does not match the credential's bindings", {
        reason: "target_mismatch",
      });
    }
    if (options.executor === "browser" || options.element !== undefined) {
      const el = options.element;
      if (el === undefined) {
        return fail("policy_denied", "browser fills need the focused element", {
          reason: "element_required",
        });
      }
      const origin = canonicalOrigin(target.value);
      if (canonicalOrigin(el.frameOrigin) !== origin) {
        return fail("policy_denied", "the focused element is in another frame origin", {
          reason: "frame_origin_mismatch",
        });
      }
      if (el.formActionOrigin !== undefined && canonicalOrigin(el.formActionOrigin) !== origin) {
        return fail("policy_denied", "the form posts to another origin", {
          reason: "form_action_mismatch",
        });
      }
      const check = fillElementAccepts(field ?? "secret", el, item.meta.kind);
      if (!check.ok) {
        return fail("policy_denied", "the focused element cannot take this field", {
          reason: check.reason,
        });
      }
    }
    if (!(await this.#verify(approvalId, structuredClone(item.meta), target))) {
      return fail("approval_required", "approval is not an approved credential_fill");
    }
    const value = field === undefined ? item.values.secret : item.values[field];
    if (value === undefined)
      return fail("not_found", `credential ${slug} has no ${field ?? "secret"}`);
    item.meta.useCount += 1;
    item.meta.lastUsedAt = toIso(this.clock.now());
    const use: FakeCredentialBroker["uses"][number] = {
      credentialId: item.meta.id,
      target: target.value,
      approvalId,
    };
    if (options.executor !== undefined) use.executor = options.executor;
    this.uses.push(use);
    return new ResolvedSecret(value, {
      credentialId: item.meta.id,
      target,
      ...(field === undefined ? {} : { field }),
    });
  }

  async list(): Promise<CredentialMeta[]> {
    return [...this.#items.values()].map((i) => structuredClone(i.meta));
  }

  async get(id: string): Promise<CredentialMeta | undefined> {
    for (const item of this.#items.values()) {
      if (item.meta.id === id) return structuredClone(item.meta);
    }
    return undefined;
  }

  async store(input: ConnectorTokenInput): Promise<CredentialMeta> {
    const meta = this.add({
      slug: input.slug,
      name: input.name,
      kind: "oauth_token",
      bindings: input.bindings,
      secret: input.tokens.accessToken,
    });
    const item = this.#items.get(input.slug);
    if (item === undefined) return fail("internal", "store failed");
    item.meta.ownerConnectorId = input.connectorId;
    if (input.tokens.refreshToken !== undefined) {
      item.values.refresh = input.tokens.refreshToken;
      if (input.tokens.refreshToken.length >= 6) {
        registerSecret(input.tokens.refreshToken, `cred:${input.slug}.refresh`);
      }
    }
    return structuredClone({ ...meta, ownerConnectorId: input.connectorId });
  }

  #owned(credentialId: string, connectorId: string): Item {
    for (const item of this.#items.values()) {
      if (item.meta.id !== credentialId) continue;
      if (item.meta.ownerConnectorId !== connectorId) {
        return fail("forbidden", "credential is not owned by this connector");
      }
      return item;
    }
    return fail("not_found", `credential ${credentialId} not found`);
  }

  async accessToken(credentialId: string, connectorId: string): Promise<ResolvedSecret> {
    const item = this.#owned(credentialId, connectorId);
    const value = item.values.token ?? item.values.secret ?? "";
    this.uses.push({ credentialId, target: connectorId, approvalId: "", executor: "connector" });
    return new ResolvedSecret(value, {
      credentialId,
      field: "token",
      target: { kind: "account", value: connectorId },
    });
  }

  async rotate(
    credentialId: string,
    connectorId: string,
    refresher: (refreshToken: ResolvedSecret) => Promise<OAuthTokenSet>,
  ): Promise<CredentialMeta> {
    const item = this.#owned(credentialId, connectorId);
    const handle = new ResolvedSecret(item.values.refresh ?? "", {
      credentialId,
      target: { kind: "account", value: connectorId },
    });
    const next = await refresher(handle);
    handle.dispose();
    item.values.secret = next.accessToken;
    item.values.token = next.accessToken;
    if (next.refreshToken !== undefined) item.values.refresh = next.refreshToken;
    for (const v of [next.accessToken, next.refreshToken]) {
      if (v !== undefined && v.length >= 6) registerSecret(v, `cred:${item.meta.slug}.rotated`);
    }
    item.meta.updatedAt = toIso(this.clock.now());
    return structuredClone(item.meta);
  }

  async revoke(
    credentialId: string,
    connectorId: string,
    reason: CredentialRevokedEvent["reason"] = "disconnect",
  ): Promise<void> {
    const item = this.#owned(credentialId, connectorId);
    this.#items.delete(item.meta.slug);
    const event: CredentialRevokedEvent = {
      credentialId,
      slug: item.meta.slug,
      connectorId,
      reason,
      at: this.clock.now(),
    };
    for (const listener of this.#revokedListeners) listener(event);
  }

  onRevoked(listener: (event: CredentialRevokedEvent) => void): Unsubscribe {
    this.#revokedListeners.add(listener);
    return () => this.#revokedListeners.delete(listener);
  }

  /** Web Bot Auth (I14): a real Ed25519 key, so fixture verifiers can check signatures. */
  async botAuthKey(): Promise<BotAuthKey | undefined> {
    return this.#botAuth?.key;
  }

  async rotateBotAuthKey(): Promise<BotAuthKey> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const publicJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x };
    // RFC 7638 thumbprint: SHA-256 over the required members in lexicographic order.
    const keyId = createHash("sha256")
      .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x }))
      .digest("base64url");
    const current = { privateKey } as { privateKey: KeyObject };
    const key: BotAuthKey = {
      keyId,
      publicJwk,
      createdAt: toIso(this.clock.now()),
      sign: async (data) => {
        // A rotated-away key must stop signing at once.
        if (this.#botAuth?.privateKey !== current.privateKey) {
          return fail("conflict", "this Web Bot Auth key was rotated away");
        }
        this.botAuthSignatures += 1;
        return new Uint8Array(edSign(null, data, current.privateKey));
      },
    };
    this.#botAuth = { key, privateKey };
    return key;
  }

  redact(text: string): string {
    let out = text;
    for (const item of this.#items.values()) {
      for (const [field, value] of Object.entries(item.values)) {
        if (value === undefined || value.length === 0 || field === "username") continue;
        const fragments = base64Fragments(Buffer.from(value, "utf8"));
        const forms = [
          value,
          encodeURIComponent(value),
          ...fragments,
          ...fragments.map((f) => f.replace(/\+/g, "-").replace(/\//g, "_")),
        ].sort((a, b) => b.length - a.length);
        for (const form of forms) out = out.split(form).join("•••");
      }
    }
    return out;
  }
}
