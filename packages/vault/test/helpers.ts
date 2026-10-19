import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import type { CredentialExecutor, CredentialField, FillElement, GrantScope } from "@psyche/protocol";
import {
  FakeAuditLog,
  FakeClock,
  FakeNodeClient,
  FakePermissionBroker,
  createIdGenerator,
} from "@psyche/testing";
import {
  credentialFillApproval,
  KEYCHAIN_CAPABILITIES,
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

/**
 * Fake mac helper: `keychain.set` / `vault.unlock` / `keychain.delete` over an in-memory
 * keychain. `touchId` decides each prompt; every prompt reason is recorded.
 */
export function fakeHelper() {
  const items = new Map<string, string>();
  const prompts: string[] = [];
  const sets: unknown[] = [];
  const state = { touchId: "approve" as "approve" | "cancel" | "fail" };
  const node = new FakeNodeClient({ nodeId: "node_helper" });
  node.handle({
    capability: { name: KEYCHAIN_CAPABILITIES.set, description: "store", sideEffect: "write" },
    handle: (p) => {
      const params = p as { service: string; account: string; value: string };
      sets.push(p);
      items.set(`${params.service}|${params.account}`, params.value);
      return { stored: true };
    },
  });
  node.handle({
    capability: { name: KEYCHAIN_CAPABILITIES.unlock, description: "read", sideEffect: "read" },
    handle: (p) => {
      const params = p as { service: string; account: string; reason: string };
      prompts.push(params.reason);
      if (state.touchId === "cancel") throw new Error("user cancelled");
      const value = items.get(`${params.service}|${params.account}`);
      if (value === undefined) throw new Error("errSecItemNotFound");
      return { value };
    },
  });
  node.handle({
    capability: { name: KEYCHAIN_CAPABILITIES.delete, description: "delete", sideEffect: "write" },
    handle: (p) => {
      const params = p as { service: string; account: string };
      items.delete(`${params.service}|${params.account}`);
      return {};
    },
  });
  return { node, items, prompts, sets, state };
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
  options: { wrapper?: KeyWrapper; overrides?: Partial<VaultOptions>; home?: string } = {},
): Harness {
  const tmp = options.home === undefined ? tmpHome() : { home: options.home, cleanup: () => {} };
  const clock = new FakeClock();
  const helper = fakeHelper();
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
