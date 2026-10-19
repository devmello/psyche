import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditLog,
  type Clock,
  type ConnectorCredentialStore,
  type ConnectorTokenInput,
  type CredentialBinding,
  type CredentialBroker,
  type CredentialExecutor,
  type CredentialField,
  type CredentialKind,
  type CredentialMeta,
  type CredentialRevokedEvent,
  type CredentialSecretInput,
  type CredentialUse,
  type EventPayload,
  fillElementAccepts,
  type JsonObject,
  type OAuthTokenSet,
  type PermissionBroker,
  PLACEHOLDER_PATTERN,
  PsycheError,
  ResolvedSecret,
  type ResolveOptions,
  type Target,
  type Unsubscribe,
  type VaultKeySlot,
  type VaultStatus,
} from "@psyche/protocol";
import { credentialFillApproval, fillBindingInput } from "./approvals.ts";
import {
  bindingMatches,
  bindingProblem,
  canonicalOrigin,
  credentialFillBindingHash,
  normalizeBinding,
} from "./binding.ts";
import {
  type Argon2Params,
  DEFAULT_ARGON2,
  deriveArgon2id,
  formatRecoveryKey,
  open,
  parseRecoveryKey,
  randomKey,
  type SealedBox,
  seal,
  zeroize,
} from "./crypto.ts";
import { fail } from "./errors.ts";
import { type ImportFormat, importRows } from "./import.ts";
import type { MetaMirror } from "./meta.ts";
import { SecretRedactor } from "./redact.ts";
import { findRefusal, REFUSAL_EXPLANATION } from "./refusals.ts";
import type { KeyWrapper, WrappedKey } from "./slots/KeyWrapper.ts";
import { type ItemRow, type ItemSecret, VaultStore } from "./store.ts";
import { parseTotpSeed, totpCode } from "./totp.ts";

/** Default idle lock (security §4.3, `vault.autoLockMinutes`). */
export const DEFAULT_AUTO_LOCK_MINUTES = 480;

/** Kinds `vault.add` accepts. `payment_link` comes only from Stripe Link pairing (G12, M3). */
const ADDABLE_KINDS: readonly CredentialKind[] = [
  "login",
  "api_key",
  "oauth_token",
  "ssh_key",
  "note",
];

/** Item-id grammar of security §4.5. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type VaultEventName = "vault.locked" | "vault.unlocked" | "credential.updated";
export type VaultEvents = { [E in VaultEventName]: EventPayload<E> };
type Listener<E extends VaultEventName> = (payload: VaultEvents[E]) => void;

export interface VaultOptions {
  /** `$PSYCHE_HOME`; files go to `<home>/vault/`. */
  home: string;
  /** The primary key slot (keychain on macOS, safeStorage or key file elsewhere). */
  wrapper: KeyWrapper;
  meta: MetaMirror;
  permissions: PermissionBroker;
  audit?: AuditLog;
  clock?: Clock;
  newId?: () => string;
  autoLockMinutes?: number;
  /** Prompt the key slot (Touch ID) on the first fill while locked. Default true. */
  unlockOnFill?: boolean;
  /** Recovery-slot KDF parameters (tests lower them). */
  argon2?: Argon2Params;
  redactor?: SecretRedactor;
}

/** Item as added through `vault.add` / import. */
export interface AddItemInput {
  kind: CredentialKind;
  name: string;
  slug?: string;
  bindings: CredentialBinding[];
  secret: CredentialSecretInput;
  requireAuthEachUse?: boolean;
}

export interface UpdateItemInput {
  name?: string;
  bindings?: CredentialBinding[];
  secret?: CredentialSecretInput;
  requireAuthEachUse?: boolean;
}

export interface ImportResult {
  format: ImportFormat;
  imported: CredentialMeta[];
  skipped: { row: number; reason: string }[];
}

interface SlotsFile {
  version: 1;
  vaultId: string;
  recoveryConfirmed: boolean;
  /** Last group of the recovery key, sealed under the DEK, for `confirmRecovery`. */
  recoveryCheck?: SealedBox;
  slots: Partial<Record<Exclude<VaultKeySlot, "recovery">, WrappedKey>>;
}

interface RecoverySlotFile {
  version: 1;
  kdf: "argon2id";
  params: Argon2Params;
  salt: string;
  box: SealedBox;
}

interface Unlocked {
  store: VaultStore;
  dek: Buffer;
}

const toIso = (ms: number) => new Date(ms).toISOString();

function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return base.length > 0 ? base : "item";
}

/** Map the protocol's secret input to the stored secret JSON for one kind. */
function secretFor(kind: CredentialKind, s: CredentialSecretInput): ItemSecret {
  const out: ItemSecret = {};
  const keep = (k: keyof CredentialSecretInput & keyof ItemSecret) => {
    const v = s[k];
    if (v !== undefined && v.length > 0) out[k] = v;
  };
  switch (kind) {
    case "login":
      keep("username");
      keep("password");
      keep("totpSecret");
      keep("text");
      if (out.password === undefined && out.totpSecret === undefined) {
        return fail("invalid_params", "a login needs a password or a TOTP seed");
      }
      if (out.totpSecret !== undefined) parseTotpSeed(out.totpSecret);
      break;
    case "api_key":
    case "oauth_token":
    case "payment_link":
      keep("token");
      keep("username");
      if (out.token === undefined) return fail("invalid_params", `${kind} needs a token`);
      break;
    case "ssh_key":
      keep("privateKey");
      keep("username");
      if (out.privateKey === undefined)
        return fail("invalid_params", "ssh_key needs a private key");
      break;
    case "note":
      keep("text");
      break;
    default:
      return fail("invalid_params", `unsupported kind ${kind}`);
  }
  return out;
}

/** Values the redactor tracks for an item (usernames are identifiers, not secrets). */
function secretValues(s: ItemSecret): string[] {
  return [s.password, s.token, s.refreshToken, s.privateKey, s.totpSecret, s.text].filter(
    (v): v is string => v !== undefined && v.length > 0,
  );
}

/**
 * The Psyche vault (architecture §4.7, security §4): SQLCipher store, key slots, items,
 * placeholder resolution for executors, the use log and the metadata mirror. Implements the
 * `CredentialBroker` contract and the connector-owned token store.
 */
export class Vault implements CredentialBroker, ConnectorCredentialStore {
  readonly clock: Clock;
  readonly #o: Required<Pick<VaultOptions, "autoLockMinutes" | "unlockOnFill" | "argon2">> &
    VaultOptions;
  readonly #dir: string;
  readonly #redactor: SecretRedactor;
  readonly #newId: () => string;
  #unlocked: Unlocked | undefined;
  #lockAt: number | null = null;
  #cancelTimer: (() => void) | undefined;
  #unlocking: Promise<void> | undefined;
  readonly #listeners = new Map<VaultEventName, Set<(p: unknown) => void>>();
  readonly #revoked = new Set<(e: CredentialRevokedEvent) => void>();

  constructor(options: VaultOptions) {
    this.#o = {
      autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
      unlockOnFill: true,
      argon2: DEFAULT_ARGON2,
      ...options,
    };
    this.clock = options.clock ?? { now: () => Date.now() };
    this.#dir = join(options.home, "vault");
    this.#redactor = options.redactor ?? new SecretRedactor();
    this.#newId = options.newId ?? (() => randomUUID().replace(/-/g, ""));
  }

  // Paths --------------------------------------------------------------------------------------

  get #dbPath() {
    return join(this.#dir, "vault.db");
  }
  get #slotsPath() {
    return join(this.#dir, "slots.json");
  }
  get #recoveryPath() {
    return join(this.#dir, "recovery.slot");
  }

  #readSlots(): SlotsFile | undefined {
    if (!existsSync(this.#slotsPath)) return undefined;
    return JSON.parse(readFileSync(this.#slotsPath, "utf8")) as SlotsFile;
  }

  #writeJson(path: string, value: unknown): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  // Events -------------------------------------------------------------------------------------

  on<E extends VaultEventName>(event: E, listener: Listener<E>): Unsubscribe {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener as (p: unknown) => void);
    this.#listeners.set(event, set);
    return () => set.delete(listener as (p: unknown) => void);
  }

  #emit<E extends VaultEventName>(event: E, payload: VaultEvents[E]): void {
    for (const l of this.#listeners.get(event) ?? []) {
      try {
        l(payload);
      } catch {
        // A listener's failure never changes the vault's state.
      }
    }
  }

  async #audit(kind: string, data: JsonObject, subject?: JsonObject): Promise<void> {
    if (this.#o.audit === undefined) return;
    await this.#o.audit.append({
      kind,
      actor: { type: "system" },
      data,
      ...(subject === undefined ? {} : { subject }),
    });
  }

  // Lifecycle ----------------------------------------------------------------------------------

  status(): VaultStatus {
    this.#checkIdle();
    const slots = this.#readSlots();
    const present: VaultKeySlot[] = [];
    if (slots !== undefined) {
      for (const k of Object.keys(slots.slots) as Exclude<VaultKeySlot, "recovery">[])
        present.push(k);
      if (existsSync(this.#recoveryPath)) present.push("recovery");
    }
    return {
      state:
        slots === undefined
          ? "uninitialized"
          : this.#unlocked === undefined
            ? "locked"
            : "unlocked",
      slots: present,
      recoveryConfirmed: slots?.recoveryConfirmed ?? false,
      autoLockMinutes: this.#o.autoLockMinutes,
      lockAt: this.#lockAt === null ? null : toIso(this.#lockAt),
      itemCount: this.#o.meta.list().length,
    };
  }

  /** The slot `setup` and `unlock` use. */
  get primarySlot(): KeyWrapper["slot"] {
    return this.#o.wrapper.slot;
  }

  get locked(): boolean {
    this.#checkIdle();
    return this.#unlocked === undefined;
  }

  /**
   * Create the vault: random DEK, wrapped by the primary slot and by a recovery key. Returns the
   * recovery key, which is shown once and never stored in plaintext (security §4.2).
   */
  async setup(): Promise<{ recoveryKey: string; status: VaultStatus }> {
    if (this.#readSlots() !== undefined || existsSync(this.#dbPath)) {
      return fail("conflict", "a vault already exists here");
    }
    const unavailable = await this.#o.wrapper.unavailableReason();
    if (unavailable !== null) return fail("unavailable", unavailable);
    const dek = randomKey();
    const recovery = randomKey();
    try {
      const wrapped = await this.#o.wrapper.wrap(dek);
      const recoveryKey = formatRecoveryKey(recovery);
      const salt = randomKey(16);
      const kek = deriveArgon2id(recovery, salt, this.#o.argon2);
      const recoveryFile: RecoverySlotFile = {
        version: 1,
        kdf: "argon2id",
        params: this.#o.argon2,
        salt: salt.toString("base64"),
        box: seal(kek, dek, "psyche.vault.slot.v1|recovery"),
      };
      zeroize(kek);
      const lastGroup = recoveryKey.split("-").at(-1) ?? "";
      const slots: SlotsFile = {
        version: 1,
        vaultId: this.#newId(),
        recoveryConfirmed: false,
        recoveryCheck: seal(dek, Buffer.from(lastGroup), "psyche.vault.recovery-check"),
        slots: { [this.#o.wrapper.slot]: wrapped },
      };
      this.#writeJson(this.#recoveryPath, recoveryFile);
      const store = VaultStore.open(this.#dbPath, dek);
      store.setHeader("vaultId", slots.vaultId);
      store.setHeader("slots", JSON.stringify(Object.keys(slots.slots)));
      this.#writeJson(this.#slotsPath, slots);
      this.#opened(store, dek, this.#o.wrapper.slot);
      await this.#audit("vault.created", { slot: this.#o.wrapper.slot });
      return { recoveryKey, status: this.status() };
    } catch (err) {
      zeroize(dek);
      throw err;
    } finally {
      zeroize(recovery);
    }
  }

  /** Setup completes when the owner types back the recovery key's last group. */
  async confirmRecovery(lastGroup: string): Promise<VaultStatus> {
    const slots = this.#readSlots();
    if (slots === undefined) return fail("not_found", "no vault");
    const u = this.#requireUnlocked();
    const expected =
      slots.recoveryCheck === undefined
        ? ""
        : open(u.dek, slots.recoveryCheck, "psyche.vault.recovery-check").toString();
    if (expected.length === 0 || lastGroup.trim().toUpperCase() !== expected) {
      return fail("invalid_params", "that is not the last group of the recovery key");
    }
    const { recoveryCheck: _drop, ...rest } = slots;
    this.#writeJson(this.#slotsPath, { ...rest, recoveryConfirmed: true });
    return this.status();
  }

  /** Unlock through the primary slot (Touch ID on macOS). Concurrent calls share one prompt. */
  async unlock(reason: string): Promise<VaultStatus> {
    this.#checkIdle();
    if (this.#unlocked !== undefined) {
      this.#touch();
      return this.status();
    }
    this.#unlocking ??= (async () => {
      const slots = this.#readSlots();
      if (slots === undefined) return fail("not_found", "no vault: run setup first");
      const wrapped = slots.slots[this.#o.wrapper.slot];
      if (wrapped === undefined) return fail("not_found", `no ${this.#o.wrapper.slot} slot`);
      const dek = await this.#o.wrapper.unwrap(wrapped, { reason });
      let store: VaultStore;
      try {
        store = VaultStore.open(this.#dbPath, dek);
      } catch (err) {
        zeroize(dek);
        throw err;
      }
      this.#opened(store, dek, this.#o.wrapper.slot);
      await this.#audit("vault.unlocked", { via: this.#o.wrapper.slot });
    })().finally(() => {
      this.#unlocking = undefined;
    });
    await this.#unlocking;
    return this.status();
  }

  /**
   * Unlock with the recovery key (after biometric re-enrollment, keychain loss or a restore),
   * then re-wrap the key for the current primary slot.
   */
  async unlockWithRecovery(recoveryKey: string): Promise<VaultStatus> {
    const slots = this.#readSlots();
    if (slots === undefined || !existsSync(this.#recoveryPath))
      return fail("not_found", "no vault");
    const file = JSON.parse(readFileSync(this.#recoveryPath, "utf8")) as RecoverySlotFile;
    const secret = parseRecoveryKey(recoveryKey);
    const kek = deriveArgon2id(secret, Buffer.from(file.salt, "base64"), file.params);
    zeroize(secret);
    let dek: Buffer;
    try {
      dek = open(kek, file.box, "psyche.vault.slot.v1|recovery");
    } finally {
      zeroize(kek);
    }
    if (this.#unlocked !== undefined) this.lock("manual");
    const store = VaultStore.open(this.#dbPath, dek);
    if ((await this.#o.wrapper.unavailableReason()) === null) {
      const wrapped = await this.#o.wrapper.wrap(dek);
      this.#writeJson(this.#slotsPath, {
        ...slots,
        slots: { ...slots.slots, [this.#o.wrapper.slot]: wrapped },
      });
    }
    this.#opened(store, dek, "recovery");
    await this.#audit("vault.unlocked", { via: "recovery" });
    return this.status();
  }

  #opened(store: VaultStore, dek: Buffer, via: VaultKeySlot): void {
    this.#unlocked = { store, dek };
    for (const item of store.all())
      for (const v of secretValues(item.secret)) this.#redactor.add(v);
    this.#touch();
    this.#emit("vault.unlocked", { via, status: this.status() });
  }

  /** Close the store, zeroize the key, forget values that never left the vault. */
  lock(reason: EventPayload<"vault.locked">["reason"] = "manual"): VaultStatus {
    const u = this.#unlocked;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#lockAt = null;
    if (u !== undefined) {
      this.#unlocked = undefined;
      u.store.close();
      zeroize(u.dek);
      this.#redactor.dropNonSticky();
      const status = this.status();
      this.#emit("vault.locked", { reason, status });
      return status;
    }
    return this.status();
  }

  #touch(): void {
    this.#cancelTimer?.();
    const at = this.clock.now() + this.#o.autoLockMinutes * 60_000;
    this.#lockAt = at;
    const c = this.clock as Clock & { setTimer?: (at: number, fn: () => void) => () => void };
    if (typeof c.setTimer === "function") {
      this.#cancelTimer = c.setTimer.call(this.clock, at, () => this.lock("idle"));
    } else {
      const t = setTimeout(() => this.lock("idle"), Math.max(0, at - this.clock.now()));
      t.unref?.();
      this.#cancelTimer = () => clearTimeout(t);
    }
  }

  #checkIdle(): void {
    if (this.#unlocked !== undefined && this.#lockAt !== null && this.clock.now() >= this.#lockAt) {
      this.lock("idle");
    }
  }

  #requireUnlocked(): Unlocked {
    this.#checkIdle();
    const u = this.#unlocked;
    if (u === undefined) return fail("unavailable", "the vault is locked", { reason: "locked" });
    this.#touch();
    return u;
  }

  // Items --------------------------------------------------------------------------------------

  #metaOf(item: ItemRow, previous?: CredentialMeta): CredentialMeta {
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      slug: item.slug,
      bindings: item.bindings,
      ownerConnectorId: item.ownerConnectorId,
      lastUsedAt: previous?.lastUsedAt ?? null,
      useCount: previous?.useCount ?? 0,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  #checkRefusals(name: string, secret: CredentialSecretInput): void {
    const refusal = findRefusal({
      name,
      password: secret.password,
      token: secret.token,
      text: secret.text,
      username: secret.username,
      privateKey: undefined,
    });
    if (refusal !== null) {
      fail("policy_denied", REFUSAL_EXPLANATION, {
        reason: "refused_data",
        category: refusal.category,
        field: refusal.field,
      });
    }
  }

  #checkBindings(bindings: CredentialBinding[]): CredentialBinding[] {
    return bindings.map((b) => {
      const problem = bindingProblem(b);
      if (problem !== null) return fail("invalid_params", `binding: ${problem}`);
      return normalizeBinding(b);
    });
  }

  #uniqueSlug(store: VaultStore, wanted: string | undefined, name: string): string {
    if (wanted !== undefined) {
      if (!SLUG_RE.test(wanted))
        return fail("invalid_params", "slug must match [a-z0-9][a-z0-9-]{0,63}");
      if (store.bySlug(wanted) !== undefined) return fail("conflict", `slug ${wanted} is taken`);
      return wanted;
    }
    const base = slugify(name);
    for (let n = 1; n < 10_000; n += 1) {
      const slug = n === 1 ? base : `${base}-${n}`;
      if (store.bySlug(slug) === undefined) return slug;
    }
    return fail("conflict", "no free slug");
  }

  #insert(
    u: Unlocked,
    input: { kind: CredentialKind; name: string; slug?: string; bindings: CredentialBinding[] },
    secret: ItemSecret,
    attrs: ItemRow["attrs"],
    owner: string | null,
  ): CredentialMeta {
    const now = toIso(this.clock.now());
    const item: ItemRow = {
      id: this.#newId(),
      kind: input.kind,
      name: input.name.trim(),
      slug: this.#uniqueSlug(u.store, input.slug, input.name),
      secret,
      bindings: this.#checkBindings(input.bindings),
      attrs,
      ownerConnectorId: owner,
      createdAt: now,
      updatedAt: now,
    };
    u.store.insert(item);
    const meta = this.#metaOf(item);
    this.#o.meta.upsert(meta);
    for (const v of secretValues(secret)) this.#redactor.add(v);
    this.#emit("credential.updated", {
      credentialId: item.id,
      change: "created",
      credential: meta,
      ownerConnectorId: owner,
    });
    return meta;
  }

  /** Add an item (owner action). Refused data is rejected with an explanation (G2). */
  async add(input: AddItemInput): Promise<CredentialMeta> {
    if (!ADDABLE_KINDS.includes(input.kind)) {
      return fail(
        "invalid_params",
        input.kind === "payment_link"
          ? "payment items come only from pairing Stripe Link (Settings → Payments)"
          : `${input.kind} items are not supported yet`,
      );
    }
    if (input.kind === "oauth_token") {
      return fail("invalid_params", "OAuth tokens are stored by their connector");
    }
    this.#checkRefusals(input.name, input.secret);
    const u = this.#requireUnlocked();
    const secret = secretFor(input.kind, input.secret);
    const attrs: ItemRow["attrs"] = {};
    if (input.secret.headerName !== undefined) attrs.headerName = input.secret.headerName;
    if (input.secret.headerPrefix !== undefined) attrs.headerPrefix = input.secret.headerPrefix;
    const authEachUse = input.requireAuthEachUse ?? input.kind === "ssh_key";
    if (authEachUse) attrs.requireAuthEachUse = true;
    const meta = this.#insert(u, input, secret, attrs, null);
    await this.#audit("credential.created", {
      credentialId: meta.id,
      kind: meta.kind,
      slug: meta.slug,
    });
    return structuredClone(meta);
  }

  async update(credentialId: string, patch: UpdateItemInput): Promise<CredentialMeta> {
    const u = this.#requireUnlocked();
    const item = u.store.get(credentialId);
    if (item === undefined) return fail("not_found", "credential not found");
    if (item.ownerConnectorId !== null && patch.secret !== undefined) {
      return fail("forbidden", "connector-owned tokens change only through their connector");
    }
    const name = patch.name ?? item.name;
    this.#checkRefusals(name, patch.secret ?? {});
    const next: ItemRow = { ...item, name: name.trim(), updatedAt: toIso(this.clock.now()) };
    if (patch.bindings !== undefined) next.bindings = this.#checkBindings(patch.bindings);
    if (patch.secret !== undefined) {
      const merged: CredentialSecretInput = { ...item.secret };
      for (const [k, v] of Object.entries(patch.secret)) {
        if (v !== undefined) (merged as Record<string, string>)[k] = v;
      }
      next.secret = secretFor(item.kind, merged);
      next.attrs = { ...item.attrs };
      if (patch.secret.headerName !== undefined) next.attrs.headerName = patch.secret.headerName;
      if (patch.secret.headerPrefix !== undefined)
        next.attrs.headerPrefix = patch.secret.headerPrefix;
    }
    if (patch.requireAuthEachUse !== undefined) {
      next.attrs = { ...next.attrs, requireAuthEachUse: patch.requireAuthEachUse };
    }
    u.store.update(next);
    for (const v of secretValues(next.secret)) this.#redactor.add(v);
    const meta = this.#metaOf(next, this.#o.meta.get(credentialId));
    this.#o.meta.upsert(meta);
    this.#emit("credential.updated", {
      credentialId,
      change: "updated",
      credential: meta,
      ownerConnectorId: next.ownerConnectorId,
    });
    await this.#audit("credential.updated", { credentialId, fields: Object.keys(patch) });
    return structuredClone(meta);
  }

  /** Overwrite and delete (security §14). The redactor keeps values that already left the vault. */
  async delete(credentialId: string): Promise<boolean> {
    const u = this.#requireUnlocked();
    const item = u.store.get(credentialId);
    if (item === undefined) return false;
    if (item.ownerConnectorId !== null) {
      return fail("forbidden", "disconnect the connector to remove its token");
    }
    this.#remove(u, item, "deleted");
    await this.#audit("credential.deleted", { credentialId, slug: item.slug });
    return true;
  }

  #remove(u: Unlocked, item: ItemRow, change: "deleted" | "revoked"): void {
    u.store.delete(item.id);
    u.store.checkpoint();
    this.#o.meta.delete(item.id);
    this.#emit("credential.updated", {
      credentialId: item.id,
      change,
      credential: null,
      ownerConnectorId: item.ownerConnectorId,
    });
  }

  /** CSV import (1Password / Bitwarden / Chrome). Refused rows are reported by row number only. */
  async importCsv(csv: string, format: ImportFormat | "auto" = "auto"): Promise<ImportResult> {
    const u = this.#requireUnlocked();
    let parsed: ReturnType<typeof importRows>;
    try {
      parsed = importRows(csv, format);
    } catch (err) {
      return fail("invalid_params", err instanceof Error ? err.message : "unreadable CSV");
    }
    const imported: CredentialMeta[] = [];
    const skipped: ImportResult["skipped"] = [];
    for (const row of parsed.rows) {
      if (!row.ok) {
        skipped.push({ row: row.row, reason: row.reason });
        continue;
      }
      try {
        const secret = secretFor(row.kind, row.secret as CredentialSecretInput);
        imported.push(this.#insert(u, row, secret, {}, null));
      } catch (err) {
        skipped.push({
          row: row.row,
          reason: err instanceof PsycheError ? `${err.code}: ${err.message}` : "failed",
        });
      }
    }
    await this.#audit("credential.imported", {
      format: parsed.format,
      imported: imported.length,
      skipped: skipped.length,
    });
    return { format: parsed.format, imported: structuredClone(imported), skipped };
  }

  /** The last `limit` uses of an item (default 50, feature G14). Works while locked. */
  uses(credentialId: string, limit = 50): CredentialUse[] {
    return this.#o.meta.uses(credentialId, Math.min(Math.max(limit, 1), 500));
  }

  // CredentialBroker ---------------------------------------------------------------------------

  async list(): Promise<CredentialMeta[]> {
    return this.#o.meta.list();
  }

  async get(id: string): Promise<CredentialMeta | undefined> {
    return this.#o.meta.get(id);
  }

  redact(text: string): string {
    return this.#redactor.redact(text);
  }

  /** True when `text` holds a tracked value in any form (echo detection, S23 design-18). */
  containsSecret(text: string): boolean {
    return this.#redactor.contains(text);
  }

  /** Build the `credential_fill` ApprovalRequest for this fill and hand it to the broker. */
  async requestFill(
    req: Omit<Parameters<typeof credentialFillApproval>[0], "credential"> & { slug: string },
  ) {
    const credential = this.#o.meta.list().find((m) => m.slug === req.slug);
    if (credential === undefined) return fail("not_found", `credential ${req.slug} not found`);
    return this.#o.permissions.requestApproval(credentialFillApproval({ ...req, credential }));
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
    const meta = this.#o.meta.list().find((c) => c.slug === slug);
    if (meta === undefined) return fail("not_found", `credential ${slug} not found`);
    const executor: CredentialExecutor =
      options.executor ?? (options.element !== undefined ? "browser" : "connector");
    const deny = async (
      code: "policy_denied" | "approval_required",
      reason: string,
      message: string,
    ): Promise<never> => {
      this.#recordUse(
        meta.id,
        executor,
        target.value,
        approvalId,
        options.taskId,
        "denied",
        reason,
      );
      await this.#audit("credential.fill_denied", {
        itemId: meta.id,
        kind: meta.kind,
        executor,
        target: target.value,
        approvalId: approvalId || null,
        reason,
      });
      return fail(code, message, { reason });
    };
    if (typeof approvalId !== "string" || approvalId.length === 0) {
      return deny("approval_required", "missing_approval", "credential fills require an approval");
    }
    if (meta.ownerConnectorId !== null) {
      return deny(
        "policy_denied",
        "connector_owned",
        "connector tokens are read by their connector only",
      );
    }
    if (!bindingMatches(meta.bindings, target)) {
      return deny(
        "policy_denied",
        "target_mismatch",
        "target does not match the credential's bindings",
      );
    }
    if (executor === "browser") {
      const el = options.element;
      if (el === undefined)
        return deny("policy_denied", "element_required", "browser fills need the focused element");
      const origin = canonicalOrigin(target.value);
      if (origin === null || canonicalOrigin(el.frameOrigin) !== origin) {
        return deny(
          "policy_denied",
          "frame_origin_mismatch",
          "the focused element is in another frame origin",
        );
      }
      if (el.formActionOrigin !== undefined && canonicalOrigin(el.formActionOrigin) !== origin) {
        return deny("policy_denied", "form_action_mismatch", "the form posts to another origin");
      }
      const check = fillElementAccepts(field ?? "secret", el, meta.kind);
      if (!check.ok)
        return deny("policy_denied", check.reason, "the focused element cannot take this field");
    }
    const bindingInput = fillBindingInput({
      credential: meta,
      target: target.value,
      executor,
      ...(field === undefined ? {} : { field }),
      ...(options.selector === undefined ? {} : { selector: options.selector }),
      ...(options.element === undefined ? {} : { element: options.element }),
    });
    const verified = await this.#o.permissions.verifyBinding(
      approvalId,
      credentialFillBindingHash(bindingInput),
    );
    if (!verified.ok) {
      // The contract reports every approval failure as `approval_required`; the reason says which.
      const messages = {
        expired: "the approval expired",
        revoked: "the approval or its grant was revoked",
        binding_mismatch: "the approval was for a different fill",
        consumed: "the approval was already used",
        not_approved: "the approval is not approved",
        not_found: "no such approval",
      } as const;
      const code = "approval_required";
      const message = messages[verified.reason];
      return deny(code, `approval_${verified.reason}`, message);
    }
    if (verified.approval.kind !== "credential_fill") {
      return deny(
        "approval_required",
        "approval_wrong_kind",
        "the approval is not a credential_fill",
      );
    }
    if (this.locked) {
      if (!this.#o.unlockOnFill)
        return fail("unavailable", "the vault is locked", { reason: "locked" });
      await this.unlock(`Fill “${meta.name}” on ${bindingInput.target}`);
    }
    const u = this.#requireUnlocked();
    const item = u.store.get(meta.id);
    if (item === undefined) return fail("not_found", `credential ${slug} not found`);
    if (item.attrs.requireAuthEachUse === true) {
      // Per-fill presence: the slot prompts again (LAContext reuse duration 0).
      const slots = this.#readSlots();
      const wrapped = slots?.slots[this.#o.wrapper.slot];
      if (wrapped === undefined)
        return fail("unavailable", "no key slot for per-use authentication");
      zeroize(await this.#o.wrapper.unwrap(wrapped, { reason: `Use “${meta.name}”` }));
    }
    const value = this.#valueOf(item, field);
    if (value === undefined) {
      this.#recordUse(
        meta.id,
        executor,
        target.value,
        approvalId,
        options.taskId,
        "failed",
        "no_such_field",
      );
      return fail("not_found", `credential ${slug} has no ${field ?? "secret"}`);
    }
    this.#redactor.markSticky(value);
    this.#recordUse(meta.id, executor, target.value, approvalId, options.taskId, "filled", null);
    await this.#audit("credential.filled", {
      itemId: meta.id,
      kind: meta.kind,
      executor,
      target: target.value,
      approvalId,
      field: field ?? "secret",
      outcome: "filled",
    });
    return new ResolvedSecret(value, {
      credentialId: meta.id,
      target,
      ...(field === undefined ? {} : { field }),
    });
  }

  #valueOf(item: ItemRow, field: CredentialField | undefined): string | undefined {
    const s = item.secret;
    switch (field) {
      case "username":
        return s.username;
      case "password":
        return item.kind === "login" ? s.password : undefined;
      case "totp":
        return s.totpSecret === undefined
          ? undefined
          : totpCode(parseTotpSeed(s.totpSecret), this.clock.now());
      case "token":
        return s.token;
      case "header":
        return s.token === undefined ? undefined : `${item.attrs.headerPrefix ?? ""}${s.token}`;
      default:
        switch (item.kind) {
          case "login":
            return s.password;
          case "ssh_key":
            return s.privateKey;
          case "note":
            return s.text;
          default:
            return s.token;
        }
    }
  }

  /** Header name for `.header` fills (not secret). */
  async headerName(slug: string): Promise<string | undefined> {
    const u = this.#requireUnlocked();
    return u.store.bySlug(slug)?.attrs.headerName;
  }

  #recordUse(
    credentialId: string,
    executor: CredentialExecutor,
    target: string,
    approvalId: string,
    taskId: string | undefined,
    outcome: CredentialUse["outcome"],
    reason: string | null,
  ): void {
    const use: CredentialUse = {
      id: this.#newId(),
      credentialId,
      taskId: taskId ?? null,
      approvalId: approvalId.length > 0 ? approvalId : null,
      executor,
      target,
      outcome,
      reason,
      createdAt: toIso(this.clock.now()),
    };
    this.#o.meta.recordUse(use);
    if (outcome === "filled") {
      const meta = this.#o.meta.get(credentialId);
      this.#emit("credential.updated", {
        credentialId,
        change: "used",
        credential: meta ?? null,
        ownerConnectorId: meta?.ownerConnectorId ?? null,
      });
    }
  }

  // ConnectorCredentialStore -------------------------------------------------------------------

  async store(input: ConnectorTokenInput): Promise<CredentialMeta> {
    const u = this.#requireUnlocked();
    const secret: ItemSecret = { token: input.tokens.accessToken };
    if (input.tokens.refreshToken !== undefined) secret.refreshToken = input.tokens.refreshToken;
    if (input.tokens.expiresAt !== undefined) secret.expiresAt = input.tokens.expiresAt;
    if (input.tokens.scopes !== undefined) secret.scopes = input.tokens.scopes;
    const meta = this.#insert(
      u,
      { kind: "oauth_token", name: input.name, slug: input.slug, bindings: input.bindings },
      secret,
      { headerName: "Authorization", headerPrefix: "Bearer " },
      input.connectorId,
    );
    await this.#audit("credential.created", {
      credentialId: meta.id,
      kind: "oauth_token",
      connectorId: input.connectorId,
    });
    return structuredClone(meta);
  }

  #owned(credentialId: string, connectorId: string): { u: Unlocked; item: ItemRow } {
    const u = this.#requireUnlocked();
    const item = u.store.get(credentialId);
    if (item === undefined) return fail("not_found", "credential not found");
    if (item.ownerConnectorId !== connectorId) {
      return fail("forbidden", "credential is not owned by this connector");
    }
    return { u, item };
  }

  async accessToken(credentialId: string, connectorId: string): Promise<ResolvedSecret> {
    const { item } = this.#owned(credentialId, connectorId);
    const token = item.secret.token ?? "";
    this.#redactor.markSticky(token);
    this.#recordUse(item.id, "connector", connectorId, "", undefined, "filled", null);
    return new ResolvedSecret(token, {
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
    const { item } = this.#owned(credentialId, connectorId);
    if (item.secret.refreshToken === undefined) {
      return fail("invalid_params", "this token has no refresh token");
    }
    this.#redactor.markSticky(item.secret.refreshToken);
    const handle = new ResolvedSecret(item.secret.refreshToken, {
      credentialId,
      target: { kind: "account", value: connectorId },
    });
    let next: OAuthTokenSet;
    try {
      next = await refresher(handle);
    } finally {
      handle.dispose();
    }
    // Re-read after the await: the item may have been revoked meanwhile.
    const { u, item: current } = this.#owned(credentialId, connectorId);
    const secret: ItemSecret = {
      ...current.secret,
      token: next.accessToken,
      refreshToken: next.refreshToken ?? current.secret.refreshToken,
    };
    if (next.expiresAt !== undefined) secret.expiresAt = next.expiresAt;
    if (next.scopes !== undefined) secret.scopes = next.scopes;
    const updated: ItemRow = { ...current, secret, updatedAt: toIso(this.clock.now()) };
    u.store.transaction(() => u.store.update(updated));
    for (const v of secretValues(secret)) this.#redactor.add(v, { sticky: true });
    const meta = this.#metaOf(updated, this.#o.meta.get(credentialId));
    this.#o.meta.upsert(meta);
    this.#emit("credential.updated", {
      credentialId,
      change: "rotated",
      credential: meta,
      ownerConnectorId: connectorId,
    });
    await this.#audit("credential.rotated", { credentialId, connectorId });
    return structuredClone(meta);
  }

  async revoke(
    credentialId: string,
    connectorId: string,
    reason: CredentialRevokedEvent["reason"] = "disconnect",
  ): Promise<void> {
    const { u, item } = this.#owned(credentialId, connectorId);
    this.#remove(u, item, "revoked");
    const event: CredentialRevokedEvent = {
      credentialId,
      slug: item.slug,
      connectorId,
      reason,
      at: this.clock.now(),
    };
    for (const l of this.#revoked) {
      try {
        l(event);
      } catch {
        // Listener failures do not undo the revocation.
      }
    }
    await this.#audit("credential.revoked", { credentialId, connectorId, reason });
  }

  onRevoked(listener: (event: CredentialRevokedEvent) => void): Unsubscribe {
    this.#revoked.add(listener);
    return () => this.#revoked.delete(listener);
  }
}
