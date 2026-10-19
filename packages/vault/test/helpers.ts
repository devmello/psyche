import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import type {
  CredentialExecutor,
  CredentialField,
  FillElement,
  GrantScope,
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeOptions,
  NodeInvokeResult,
} from "@psyche/protocol";
import { createIdGenerator, FakeAuditLog, FakeClock, FakePermissionBroker } from "@psyche/testing";
import {
  credentialFillApproval,
  KEYCHAIN_CAPABILITIES,
  KEYCHAIN_ITEM_CAPABILITIES,
  KEYCHAIN_NAME_RE,
  KeychainItemStore,
  KeychainWrapper,
  type KeyWrapper,
  type SafeStorageAdapter,
  SqliteMetaMirror,
  Vault,
  type VaultOptions,
} from "../src/index.ts";

/** Fast Argon2id for tests only. */
export const TEST_ARGON2 = { memory: 64, passes: 1, parallelism: 1 };

export function tmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "psyche-vault-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Thrown inside a fake capability: becomes `{code, message, details: {reason}}` like S14's CapabilityError. */
export class HelperError extends Error {
  readonly code: string;
  readonly reason: string;

  constructor(code: string, reason: string) {
    super(`${code}/${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

type Handler = (params: Record<string, unknown>) => unknown;

/** Minimal node with S14's error wire shape (FakeNodeClient flattens codes to `internal`). */
class HelperNode implements NodeClient {
  readonly nodeId = "node_helper";
  readonly invocations: { capability: string; params: unknown }[] = [];
  readonly #caps = new Map<string, { cap: NodeCapability; fn: Handler }>();

  handle(name: string, sideEffect: NodeCapability["sideEffect"], fn: Handler): void {
    this.#caps.set(name, { cap: { name, description: name, sideEffect }, fn });
  }

  async info(): Promise<NodeInfo> {
    return {
      id: this.nodeId,
      deviceId: "dev_helper",
      kind: "mac-helper",
      status: "online",
      lastHeartbeatAt: null,
      capabilities: await this.capabilities(),
    };
  }

  async capabilities(): Promise<NodeCapability[]> {
    return [...this.#caps.values()].map((c) => ({ ...c.cap }));
  }

  async invoke(
    capability: string,
    params: unknown,
    options: NodeInvokeOptions = {},
  ): Promise<NodeInvokeResult> {
    const h = this.#caps.get(capability);
    if (h === undefined)
      return {
        ok: false,
        error: { code: "not_found", message: `unknown capability ${capability}` },
      };
    // The Gateway's NodeClient contract: destructive capabilities need an approval id.
    if (h.cap.sideEffect === "destructive" && options.approvalId === undefined) {
      return {
        ok: false,
        error: { code: "approval_required", message: `${capability} needs an approval` },
      };
    }
    this.invocations.push({ capability, params: structuredClone(params) });
    try {
      return { ok: true, result: await h.fn(params as Record<string, unknown>) };
    } catch (err) {
      const e = err instanceof HelperError ? err : new HelperError("internal", "keychain_error");
      return {
        ok: false,
        error: { code: e.code as never, message: e.message, details: { reason: e.reason } },
      };
    }
  }
}

/**
 * Fake mac helper on S14's registered contract (`keychain.set`, `vault.unlock`, `keychain.delete`
 * (destructive), `keychain.status`) over an in-memory keychain. With `items: true` it also offers
 * the G9 item capabilities (`keychain.store`, `keychain.retrieve`, `keychain.delete_item`).
 * `state.touchId` decides each prompt; every prompt reason is recorded.
 */
export function fakeHelper(options: { items?: boolean } = {}) {
  const items = new Map<string, string>();
  const kcItems = new Map<string, { value: string; requireAuth: boolean }>();
  const prompts: string[] = [];
  const sets: unknown[] = [];
  const state = {
    touchId: "approve" as "approve" | "cancel" | "fail",
    dataProtection: "available",
  };
  const node = new HelperNode();
  const prompt = (reason: unknown) => {
    const text = String(reason ?? "");
    if (text.length < 1 || text.length > 120 || /[\r\n]/.test(text))
      throw new HelperError("invalid_params", "invalid_params");
    prompts.push(text);
    if (state.touchId === "cancel") throw new HelperError("cancelled", "user_cancelled");
    if (state.touchId === "fail") throw new HelperError("forbidden", "auth_failed");
  };
  node.handle(KEYCHAIN_CAPABILITIES.set, "write", (p) => {
    if (p.service !== "com.psyche.vault") throw new HelperError("invalid_params", "invalid_params");
    sets.push(p);
    items.set(`${String(p.service)}|${String(p.account)}`, String(p.value));
    return {};
  });
  node.handle(KEYCHAIN_CAPABILITIES.unlock, "read", (p) => {
    prompt(p.reason);
    const value = items.get(`${String(p.service)}|${String(p.account)}`);
    if (value === undefined) throw new HelperError("not_found", "item_not_found");
    return { value };
  });
  node.handle(KEYCHAIN_CAPABILITIES.delete, "destructive", (p) => {
    items.delete(`${String(p.service)}|${String(p.account)}`);
    return {};
  });
  node.handle(KEYCHAIN_ITEM_CAPABILITIES.status, "read", () => ({
    dataProtectionKeychain: state.dataProtection,
    probeStatus: null,
    accessGroup: "TEAMID.com.psyche.shared",
    biometry: { available: true },
  }));
  if (options.items === true) {
    const nameOk = (n: unknown) => typeof n === "string" && KEYCHAIN_NAME_RE.test(n);
    node.handle(KEYCHAIN_ITEM_CAPABILITIES.store, "write", (p) => {
      if (!nameOk(p.name)) throw new HelperError("invalid_params", "invalid_params");
      const name = String(p.name);
      if (kcItems.has(name) && p.replace !== true)
        throw new HelperError("conflict", "duplicate_item");
      kcItems.set(name, { value: String(p.value), requireAuth: p.requireAuth !== false });
      return { name, stored: true, requireAuth: p.requireAuth !== false, replaced: false };
    });
    node.handle(KEYCHAIN_ITEM_CAPABILITIES.retrieve, "read", (p) => {
      const item = kcItems.get(String(p.name));
      if (item === undefined) throw new HelperError("not_found", "item_not_found");
      if (item.requireAuth) prompt(p.reason);
      return { name: p.name, value: item.value };
    });
    node.handle(KEYCHAIN_ITEM_CAPABILITIES.deleteItem, "write", (p) => {
      if (!kcItems.delete(String(p.name))) throw new HelperError("not_found", "item_not_found");
      return { deleted: true };
    });
  }
  return { node, items, kcItems, prompts, sets, state };
}

/** Fake Electron safeStorage: AES-256-GCM under a per-adapter key; backend switchable. */
export function fakeSafeStorage(backend = "gnome_libsecret"): SafeStorageAdapter & {
  backendName: string;
} {
  const key = randomBytes(32);
  const adapter = {
    backendName: backend,
    async isEncryptionAvailable() {
      return true;
    },
    async backend() {
      return adapter.backendName;
    },
    async encrypt(plaintext: Buffer) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plaintext), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    async decrypt(data: Buffer) {
      const d = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      d.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([d.update(data.subarray(28)), d.final()]);
    },
  };
  return adapter;
}

export interface Harness {
  vault: Vault;
  clock: FakeClock;
  permissions: FakePermissionBroker;
  audit: FakeAuditLog;
  helper: ReturnType<typeof fakeHelper>;
  meta: SqliteMetaMirror;
  home: string;
  cleanup: () => void;
  /** Open a second Vault over the same files (a Gateway restart). */
  reopen(overrides?: Partial<VaultOptions>): Vault;
}

export function makeHarness(
  options: {
    wrapper?: KeyWrapper;
    overrides?: Partial<VaultOptions>;
    home?: string;
    /** G9: put new items' secrets in the (fake) system keychain. */
    keychainMode?: boolean;
  } = {},
): Harness {
  const tmp = options.home === undefined ? tmpHome() : { home: options.home, cleanup: () => {} };
  const clock = new FakeClock();
  const helper = fakeHelper({ items: options.keychainMode === true });
  const db = openDb(":memory:");
  const meta = new SqliteMetaMirror(db.sqlite);
  const permissions = new FakePermissionBroker({ clock });
  const audit = new FakeAuditLog({ clock });
  const ids = createIdGenerator({ prefix: "v" });
  const base: VaultOptions = {
    home: tmp.home,
    wrapper: options.wrapper ?? new KeychainWrapper({ helper: helper.node, account: "test" }),
    meta,
    permissions,
    audit,
    clock,
    newId: () => ids.next("id"),
    argon2: TEST_ARGON2,
    ...(options.keychainMode === true
      ? {
          itemBackend: "keychain" as const,
          keychainItems: new KeychainItemStore({ helper: helper.node }),
        }
      : {}),
    ...options.overrides,
  };
  return {
    vault: new Vault(base),
    clock,
    permissions,
    audit,
    helper,
    meta,
    home: tmp.home,
    cleanup: () => {
      db.close();
      tmp.cleanup();
    },
    reopen: (overrides = {}) => new Vault({ ...base, ...overrides }),
  };
}

export const PASSWORD_FIELD: FillElement = {
  tagName: "input",
  type: "password",
  autocomplete: "current-password",
  frameOrigin: "https://github.com",
  formActionOrigin: "https://github.com",
  formHasPassword: true,
};

/** Request a `credential_fill` through the broker and approve it from the desktop. */
export async function approveFill(
  h: Harness,
  req: {
    slug: string;
    target: string;
    executor?: CredentialExecutor;
    field?: CredentialField;
    selector?: string;
    element?: FillElement;
    scope?: GrantScope;
    taskId?: string;
  },
): Promise<string> {
  const credential = (await h.vault.list()).find((c) => c.slug === req.slug);
  if (credential === undefined) throw new Error(`no ${req.slug}`);
  const issued = await h.permissions.requestApproval(
    credentialFillApproval({
      credential,
      target: req.target,
      executor: req.executor ?? "browser",
      ...(req.field === undefined ? {} : { field: req.field }),
      ...(req.selector === undefined ? {} : { selector: req.selector }),
      ...(req.element === undefined ? {} : { element: req.element }),
      requestedBy: { runId: null, taskId: req.taskId ?? null, threadId: null, agent: "Pip" },
      taint: false,
    }),
  );
  h.clock.advance(500);
  const token = issued.answerTokens.desktop;
  if (token === undefined) throw new Error("no desktop surface");
  await h.permissions.answer({
    approvalId: issued.approval.id,
    answerToken: token,
    decision: "approve",
    scope: req.scope ?? "once",
    decidedBy: { deviceId: "dev_desktop", surface: "desktop" },
  });
  return issued.approval.id;
}
