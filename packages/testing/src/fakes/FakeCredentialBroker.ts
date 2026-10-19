import {
  type Clock,
  type CredentialBinding,
  type CredentialBroker,
  type CredentialField,
  type CredentialKind,
  type CredentialMeta,
  PLACEHOLDER_PATTERN,
  ResolvedSecret,
  type ResolveOptions,
  type Target,
} from "@psyche/protocol";
import { FakeClock, toIso } from "../clock.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { registerSecret } from "../secrets.ts";
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
  /** Decides whether `approvalId` authorizes this fill. Default: any approval id passed to `approve()`. */
  verifyApproval?: ApprovalVerifier;
}

interface Item {
  meta: CredentialMeta;
  values: Partial<Record<CredentialField | "secret", string>>;
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

/** True when `target` matches one of the item's bindings exactly (security §4.5). */
export function bindingMatches(bindings: CredentialBinding[], target: Target): boolean {
  return bindings.some((b) => {
    if ("origin" in b) return canonicalOrigin(target.value) === canonicalOrigin(b.origin);
    if ("host" in b) return canonicalHost(target.value) === b.host;
    return target.kind === "account" && target.value === b.connector;
  });
}

/**
 * In-memory vault. Every secret added is registered with the secret-leak checker, so
 * `assertNoSecrets` catches it anywhere in model-visible output. `resolve` requires a matching
 * binding and an approved `approvalId`, and returns a one-shot `ResolvedSecret` handle.
 */
export class FakeCredentialBroker implements CredentialBroker {
  readonly clock: Clock;
  #ids: IdGenerator;
  #items = new Map<string, Item>();
  #approved = new Set<string>();
  #verify: ApprovalVerifier;
  /** Every successful resolve (no values), like `credential_uses`. */
  readonly uses: { credentialId: string; target: string; approvalId: string; executor?: string }[] =
    [];

  constructor(options: FakeCredentialBrokerOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.#ids = options.ids ?? createIdGenerator();
    this.#verify = options.verifyApproval ?? ((id) => this.#approved.has(id));
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

  /** Mark an approval id as an approved `credential_fill` (default verifier). */
  approve(approvalId: string): this {
    this.#approved.add(approvalId);
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

  redact(text: string): string {
    let out = text;
    for (const item of this.#items.values()) {
      for (const [field, value] of Object.entries(item.values)) {
        if (value === undefined || value.length === 0 || field === "username") continue;
        const forms = [
          value,
          encodeURIComponent(value),
          Buffer.from(value).toString("base64").replace(/=+$/, ""),
          Buffer.from(value).toString("base64url"),
        ];
        for (const form of forms) out = out.split(form).join("•••");
      }
    }
    return out;
  }
}
