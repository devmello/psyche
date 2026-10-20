import type { PsycheDb } from "@psyche/db";
import {
  type AuditLog,
  type Clock,
  type EventName,
  type EventPayload,
  type NodeCapability,
  type NodeClient,
  type NodeInfo,
  type NodeInvokeOptions,
  type NodeInvokeResult,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
import {
  type Argon2Params,
  createVaultHandlers,
  KEYCHAIN_CAPABILITIES,
  KeychainWrapper,
  KeyFileWrapper,
  type KeyWrapper,
  type SafeStorageAdapter,
  SafeStorageWrapper,
  SecretRedactor,
  SqliteMetaMirror,
  Vault,
  type VaultEventName,
} from "@psyche/vault";
import type { Call, HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import type { NodeRegistry } from "../nodes/registry.ts";

/**
 * The vault (S06 `@psyche/vault`) in the running Gateway: one `Vault` per `$PSYCHE_HOME`, its
 * `vault.*` handlers, its events as frames, and the `SecretRedactor` every masking output path
 * shares. `vault.unlock` and `keychain.*` are Gateway-internal: the vault reaches the helper
 * through `nodes.client`, never through `nodes.invoke` (which refuses those names).
 */

export interface VaultSetup {
  /** A ready key slot (tests). Overrides everything below. */
  wrapper?: KeyWrapper;
  /** Server mode: a 0600 key file (`PSYCHE_VAULT_KEY_FILE`, a Compose secret). */
  keyFile?: string;
  /** The desktop's Electron `safeStorage`, when it hosts the Gateway. */
  safeStorage?: SafeStorageAdapter;
  /** Keychain account of the key item (default `"default"`). */
  keychainAccount?: string;
  /** Recovery-slot KDF parameters (tests lower them). */
  argon2?: Argon2Params;
  autoLockMinutes?: number;
}

/** Methods whose params carry a secret or the recovery key: no param or raw message is logged. */
export const SECRET_PARAM_METHODS: ReadonlySet<string> = new Set([
  "vault.add",
  "vault.update",
  "vault.import",
  "vault.unlock",
]);

const VAULT_EVENTS: readonly VaultEventName[] = [
  "vault.locked",
  "vault.unlocked",
  "credential.updated",
];

const KEYCHAIN_NEEDS = [...Object.values(KEYCHAIN_CAPABILITIES), "keychain.status"];

/** A connected mac-helper node with the vault's keychain capabilities. */
export function isKeychainHelper(node: NodeInfo): boolean {
  if (node.kind !== "mac-helper" || node.status !== "online") return false;
  const names = new Set(node.capabilities.map((c) => c.name));
  return KEYCHAIN_NEEDS.every((n) => names.has(n));
}

/**
 * The newest connected keychain helper, resolved on every call: the helper connects after the
 * Gateway starts and may reconnect, while the vault's wrapper is fixed at boot. With no helper,
 * the wrapper reports itself unavailable and invocations fail `unavailable`.
 */
export class HelperNodeClient implements NodeClient {
  readonly #nodes: () => NodeRegistry | undefined;

  constructor(nodes: () => NodeRegistry | undefined) {
    this.#nodes = nodes;
  }

  #current(): NodeClient | undefined {
    const nodes = this.#nodes();
    if (nodes === undefined) return undefined;
    const helper = nodes
      .list()
      .filter((n) => isKeychainHelper(n) && nodes.isLive(n.id))
      .at(-1);
    return helper === undefined ? undefined : nodes.client(helper.id);
  }

  get nodeId(): string {
    return this.#current()?.nodeId ?? "";
  }

  async info(): Promise<NodeInfo> {
    const c = this.#current();
    if (c === undefined) throw new PsycheError("unavailable", "no keychain helper is connected");
    return c.info();
  }

  async capabilities(): Promise<NodeCapability[]> {
    return (await this.#current()?.capabilities()) ?? [];
  }

  async invoke(
    capability: string,
    params: unknown,
    options?: NodeInvokeOptions,
  ): Promise<NodeInvokeResult> {
    const c = this.#current();
    if (c === undefined) {
      return {
        ok: false,
        error: { code: "unavailable", message: "no keychain helper is connected" },
      };
    }
    return c.invoke(capability, params, options);
  }
}

export type VaultSlotChoice = "key_file" | "safe_storage" | "keychain" | "injected";

/**
 * Key slot per deployment: an injected wrapper; else the key file in server mode; else the
 * desktop's safeStorage; else the keychain through the Mac helper (the macOS default).
 */
export function chooseWrapper(
  setup: VaultSetup,
  helper: NodeClient,
): { wrapper: KeyWrapper; choice: VaultSlotChoice } {
  if (setup.wrapper !== undefined) return { wrapper: setup.wrapper, choice: "injected" };
  if (setup.keyFile !== undefined && setup.keyFile !== "") {
    return { wrapper: new KeyFileWrapper(setup.keyFile), choice: "key_file" };
  }
  if (setup.safeStorage !== undefined) {
    return { wrapper: new SafeStorageWrapper(setup.safeStorage), choice: "safe_storage" };
  }
  return {
    wrapper: new KeychainWrapper({ helper, account: setup.keychainAccount ?? "default" }),
    choice: "keychain",
  };
}

/** `VaultSetup` from the environment (`PSYCHE_VAULT_KEY_FILE`). */
export function vaultSetupFromEnv(env: NodeJS.ProcessEnv): VaultSetup {
  const keyFile = env.PSYCHE_VAULT_KEY_FILE;
  return keyFile === undefined || keyFile === "" ? {} : { keyFile };
}

/**
 * A logger whose string fields pass through the shared redactor, so a value the vault has
 * handed out (a filled password, a connector token, a one-time card) is masked if any caller
 * ever puts it in a log line.
 */
export function maskingLogger(log: Logger, redactor: SecretRedactor): Logger {
  return {
    log(level, msg, fields) {
      if (fields === undefined) return log.log(level, redactor.redact(msg));
      const out: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(fields)) {
        out[k] = typeof v === "string" ? redactor.redact(v) : v;
      }
      log.log(level, redactor.redact(msg), out);
    },
  };
}

/**
 * `vault.*` for the dispatcher. For methods that carry secrets, an error that is not the
 * vault's own (`PsycheError`) or is `internal` is replaced by a fixed message: the dispatcher
 * logs `internal` messages, and a raw error could quote its input.
 */
export function vaultHandlers(vault: Vault): Record<string, HandlerDef> {
  const out: Record<string, HandlerDef> = {};
  for (const [name, fn] of Object.entries(createVaultHandlers(vault))) {
    const run = fn as (params: unknown) => Promise<unknown>;
    if (!SECRET_PARAM_METHODS.has(name)) {
      out[name] = { run: (_call: Call, params: never) => run(params) };
      continue;
    }
    out[name] = {
      async run(_call: Call, params: never) {
        try {
          return await run(params);
        } catch (err) {
          if (err instanceof PsycheError && err.code !== "internal") throw err;
          throw new PsycheError("internal", `${name} failed`);
        }
      },
    };
  }
  return out;
}

export interface ComposedVault {
  readonly vault: Vault;
  readonly redactor: SecretRedactor;
  readonly slot: VaultSlotChoice;
  readonly handlers: Record<string, HandlerDef>;
  /** Called once the Gateway (and its node registry) exists. */
  attach(nodes: NodeRegistry): void;
  stop(): void;
}

export function composeVault(
  deps: {
    home: string;
    db: PsycheDb;
    permissions: PermissionBroker;
    audit: AuditLog;
    clock: Clock;
    publish<E extends EventName>(event: E, payload: EventPayload<E>): void;
    redactor?: SecretRedactor;
  },
  setup: VaultSetup = {},
): ComposedVault {
  let nodes: NodeRegistry | undefined;
  const helper = new HelperNodeClient(() => nodes);
  const { wrapper, choice } = chooseWrapper(setup, helper);
  const redactor = deps.redactor ?? new SecretRedactor();
  const vault = new Vault({
    home: deps.home,
    wrapper,
    meta: new SqliteMetaMirror(deps.db.sqlite),
    permissions: deps.permissions,
    audit: deps.audit,
    clock: deps.clock,
    redactor,
    ...(setup.argon2 === undefined ? {} : { argon2: setup.argon2 }),
    ...(setup.autoLockMinutes === undefined ? {} : { autoLockMinutes: setup.autoLockMinutes }),
  });
  const unsubscribe = VAULT_EVENTS.map((event) =>
    vault.on(event, (payload) => deps.publish(event, payload as never)),
  );
  return {
    vault,
    redactor,
    slot: choice,
    handlers: vaultHandlers(vault),
    attach(registry) {
      nodes = registry;
    },
    stop() {
      for (const u of unsubscribe) u();
      vault.lock("manual");
    },
  };
}
