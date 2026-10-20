import {
  type CatalogueEntry,
  COMING_SOON,
  type ConnectorEvent,
  type ConnectorFactory,
  ConnectorRegistry,
  type ConnectorStore,
  connectorHandlers,
  createWebFetchFactory,
  createWebSearchFactory,
  type FetchFn,
  googleFactory,
  type LibrarySink,
  REMOTE_MCP_PRESETS,
  type StoredTokens,
  type TokenVault,
  type WebFetchFactoryOptions,
  type WebSearchFactoryOptions,
} from "@psyche/connectors";
import {
  type CredentialBroker,
  type CredentialRevokedEvent,
  isMethodName,
  PsycheError,
} from "@psyche/protocol";
import { VaultTokenVault } from "@psyche/vault";
import type { Call, HandlerDef } from "../context.ts";
import { taskOrigins } from "./fetch-origins.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Connectors (INT-2; S09 `@psyche/connectors`): the `ConnectorRegistry` on the composed services.
 * Connector tools register through `services.tools`, so the loop's per-call decision context
 * (`services.calls.approvalFor`) reaches the registry's executor wrapper, which re-verifies the
 * approval binding right before dispatch and records a receipt for every write.
 */

/** How often connected connectors sync (README: "run by the Gateway every 1–5 min"). */
export const DEFAULT_SYNC_INTERVAL_MS = 3 * 60_000;

export interface ConnectorsSetup {
  /** Replaces the default factories (Google, plus web search / fetch when configured). */
  factories?: ConnectorFactory[];
  /**
   * Opens Google's consent page in the owner's browser (desktop OAuth, loopback redirect). The
   * daemon has no browser of its own: without one, connecting Google fails `unavailable`.
   */
  openBrowser?: (url: URL) => void | Promise<void>;
  /** Loopback wait for the OAuth redirect (default: the package's 5 minutes). */
  oauthTimeoutMs?: number;
  /** Web search / fetch connectors, only when the owner configured them (M8). */
  web?: { search?: WebSearchFactoryOptions; fetch?: WebFetchFactoryOptions };
  /**
   * OAuth token storage. Default: `VaultTokenVault` over the composed vault (G13): tokens are
   * connector-owned `oauth_token` items, so they survive a restart and need an unlocked vault.
   */
  tokens?: TokenVault;
  /** Every connector network call goes through this (tests inject a fake Google). */
  fetch?: FetchFn;
  /** Resolves `{{cred:slug}}` placeholders in connector config (client secrets, API keys). */
  credentials?: CredentialBroker;
  /** Attachments and Drive downloads (the Library, S13). */
  library?: LibrarySink;
  /** Connector records (in memory until the `connectors` table exists, docs/status/s09.md). */
  store?: ConnectorStore;
  /** Directory rows without a local implementation; default remote MCP presets and coming soon. */
  extraCatalogue?: CatalogueEntry[];
  /** Background sync of connected connectors; 0 disables (tests drive `registry.sync`). */
  syncIntervalMs?: number;
  /** Observes every connector event after the composition root has handled it. */
  onEvent?: (event: ConnectorEvent) => void;
  newId?: () => string;
}

/**
 * In-process `TokenVault` for tests that do not exercise the vault: tokens live in this process
 * only. The Gateway uses `VaultTokenVault`. Never logged, never in a connector record, never
 * model-visible.
 */
export class MemoryTokenVault implements TokenVault {
  readonly #tokens = new Map<string, StoredTokens>();
  async load(connectorId: string) {
    const t = this.#tokens.get(connectorId);
    return t === undefined ? undefined : structuredClone(t);
  }
  async save(connectorId: string, tokens: StoredTokens) {
    this.#tokens.set(connectorId, structuredClone(tokens));
  }
  async clear(connectorId: string) {
    this.#tokens.delete(connectorId);
  }
}

const noBrowser = () => {
  throw new PsycheError("unavailable", "no browser to open Google's consent page");
};

function defaultFactories(setup: ConnectorsSetup, services: ComposeServices): ConnectorFactory[] {
  const factories = [
    googleFactory({
      openBrowser: setup.openBrowser ?? noBrowser,
      ...(setup.oauthTimeoutMs === undefined ? {} : { timeoutMs: setup.oauthTimeoutMs }),
    }),
  ];
  if (setup.web?.search !== undefined) factories.push(createWebSearchFactory(setup.web.search));
  if (setup.web?.fetch !== undefined) {
    // Redirect hops stay inside the Task's approved origins (#72).
    factories.push(
      createWebFetchFactory({ allowedOrigins: taskOrigins(services), ...setup.web.fetch }),
    );
  }
  return factories;
}

export function composeConnectors(
  services: ComposeServices,
  setup: ConnectorsSetup = {},
): ComposedPart & { readonly registry: ConnectorRegistry } {
  const log = services.logger;
  const registry = new ConnectorRegistry({
    factories: setup.factories ?? defaultFactories(setup, services),
    extraCatalogue: setup.extraCatalogue ?? [...REMOTE_MCP_PRESETS, ...COMING_SOON],
    ...(setup.store === undefined ? {} : { store: setup.store }),
    context: {
      clock: services.clock,
      fetch: setup.fetch ?? ((input, init) => fetch(input, init)),
      tokens: setup.tokens ?? new VaultTokenVault(services.vault),
      ...(setup.credentials === undefined ? {} : { credentials: setup.credentials }),
      ...(setup.library === undefined ? {} : { library: setup.library }),
    },
    tools: services.tools,
    broker: services.broker,
    approvalFor: (callId) => services.calls.approvalFor(callId),
    authorityFor: (callId) => services.calls.authorityFor(callId),
    onEvent: (event) => {
      onConnectorEvent(services, event);
      setup.onEvent?.(event);
    },
    ...(setup.newId === undefined ? {} : { newId: setup.newId }),
  });

  // The Gateway refuses method names the protocol does not know; `connectors.catalogue |
  // connect | disconnect | status | setMatrix` wait for a `protocol:` PR (CONNECTOR_METHODS).
  const handlers: Record<string, HandlerDef> = {};
  for (const [name, fn] of Object.entries(connectorHandlers(registry))) {
    if (!isMethodName(name)) continue;
    handlers[name] = { run: (_call: Call, params: never) => fn(params) };
  }

  // A token revoked in the vault by anything but the registry's own disconnect (the owner, a
  // provider revocation) disconnects the connector: its tools are torn down, so pending
  // approvals bound to the connection fail re-verification, and `invalidated` is emitted (G13).
  // A `disconnect` revoke is the registry's own `tokens.clear`, already mid-disconnect.
  const unsubscribeRevoked = services.vault.onRevoked((event) => {
    if (event.reason === "disconnect") return;
    void disconnectRevoked(registry, event).catch((err) =>
      log?.log("warn", "disconnect after token revocation failed", {
        connectorId: event.connectorId,
        code: PsycheError.from(err).code,
      }),
    );
  });

  const interval = setup.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;
  const syncAll = async () => {
    // A slow provider never stacks sync rounds.
    if (syncing) return;
    syncing = true;
    try {
      for (const record of await registry.list()) {
        if (record.status !== "connected") continue;
        try {
          await registry.sync(record.id);
        } catch (err) {
          log?.log("warn", "connector sync failed", {
            connectorId: record.id,
            code: PsycheError.from(err).code,
          });
        }
      }
    } finally {
      syncing = false;
    }
  };

  return {
    registry,
    handlers,
    start() {
      if (interval <= 0) return;
      timer = setInterval(() => void syncAll(), interval);
      timer.unref?.();
    },
    async stop() {
      unsubscribeRevoked();
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await registry.close();
    },
  };
}

async function disconnectRevoked(
  registry: ConnectorRegistry,
  event: CredentialRevokedEvent,
): Promise<void> {
  const record = (await registry.list()).find((r) => r.id === event.connectorId);
  if (record === undefined || record.status === "disconnected") return;
  await registry.disconnect(event.connectorId);
}

/**
 * The protocol has no connector event yet (proposed with the `connectors.*` methods), so status
 * changes and invalidations reach the owner as notifications. Logs carry ids and codes only;
 * `reason` strings are the registry's own enums, never provider text.
 */
function onConnectorEvent(services: ComposeServices, event: ConnectorEvent): void {
  const log = services.logger;
  const at = services.clock.now();
  switch (event.type) {
    case "invalidated":
      log?.log("warn", "connector invalidated", {
        connectorId: event.connectorId,
        reason: event.reason,
        at,
      });
      notify(services, {
        title: "A connection changed",
        body: invalidatedCopy(event.reason),
        dedupeKey: `connector:${event.connectorId}:invalidated:${event.reason}`,
      });
      return;
    case "status":
      log?.log("info", "connector status", {
        connectorId: event.connectorId,
        status: event.status,
        at,
      });
      if (event.status === "needs_auth") {
        notify(services, {
          title: "Reconnect needed",
          body: "A connector lost access and needs you to sign in again.",
          dedupeKey: `connector:${event.connectorId}:needs_auth`,
        });
      }
      return;
    case "synced":
      log?.log("debug", "connector synced", {
        connectorId: event.connectorId,
        changes: event.changes,
        full: event.full,
      });
      return;
    case "matrix_changed":
      log?.log("info", "connector action matrix changed", { connectorId: event.connectorId });
      return;
  }
}

function invalidatedCopy(reason: Extract<ConnectorEvent, { type: "invalidated" }>["reason"]) {
  switch (reason) {
    case "account_changed":
      return "A connector now signs in to a different account. Work bound to the old account was stopped.";
    case "disconnected":
      return "A connector was disconnected. Work that needed it was stopped.";
    case "scope_changed":
      return "A connector is now read-only. Pending actions through it were stopped.";
    case "token_revoked":
      return "A connector's access was revoked. Sign in again to keep using it.";
  }
}

function notify(
  services: ComposeServices,
  input: { title: string; body: string; dedupeKey: string },
): void {
  services.notifier
    .notify({ kind: "system", route: "/settings/connectors", ...input })
    .catch((err) =>
      services.logger?.log("warn", "connector notification failed", {
        code: PsycheError.from(err).code,
      }),
    );
}
