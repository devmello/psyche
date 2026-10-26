import {
  type AppleHelper,
  appleFactories,
  type CatalogueEntry,
  COMING_SOON,
  type ConnectorEvent,
  type ConnectorFactory,
  ConnectorRegistry,
  type ConnectorStore,
  CustomConnectors,
  connectorHandlers,
  createWebFetchFactory,
  createWebSearchFactory,
  customConnectorHandlers,
  customFactory,
  type FetchFn,
  googleFactory,
  type ImapBackendOptions,
  imapFactory,
  jmapFactory,
  type LibrarySink,
  obsidianFactory,
  REMOTE_MCP_PRESETS,
  SqliteConnectorStore,
  type StoredTokens,
  type TokenVault,
  toWire,
  type WebFetchFactoryOptions,
  type WebSearchFactoryOptions,
} from "@psyche/connectors";
import { assertGranted, assertNoSymlinks, assertNotProtected } from "@psyche/files";
import {
  type CredentialBroker,
  type CredentialRevokedEvent,
  isMethodName,
  PsycheError,
} from "@psyche/protocol";
import { VaultTokenVault } from "@psyche/vault";
import type { Call, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import { fetchLimit, taskOrigins } from "./fetch-origins.ts";
import { type MailCredentials, mailCredentials } from "./mail-credentials.ts";
import { protectedRoots } from "./protected-paths.ts";
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
  /** Replaces the default factories (Google, IMAP, JMAP, plus web search / fetch when configured). */
  factories?: ConnectorFactory[];
  /** The IMAP backend's dialer (tests: the connector's fake servers). */
  imap?: ImapBackendOptions;
  /**
   * Opens Google's consent page in the owner's browser (desktop OAuth, loopback redirect). The
   * daemon has no browser of its own: without one, connecting Google fails `unavailable`.
   */
  openBrowser?: (url: URL) => void | Promise<void>;
  /** Loopback wait for the OAuth redirect (default: the package's 5 minutes). */
  oauthTimeoutMs?: number;
  /**
   * The owner's Google Cloud OAuth client (Desktop app), docs/guides/connectors-google.md.
   * `clientSecret` is a `{{cred:slug}}` placeholder, read under a credential approval at connect.
   * Without a client id, Google shows as not configured and connecting it is refused.
   */
  google?: { clientId?: string; clientSecret?: string };
  /** Web search / fetch connectors, only when the owner configured them (M8). */
  web?: { search?: WebSearchFactoryOptions; fetch?: WebFetchFactoryOptions };
  /**
   * OAuth token storage. Default: `VaultTokenVault` over the composed vault (G13): tokens are
   * connector-owned `oauth_token` items, so they survive a restart and need an unlocked vault.
   */
  tokens?: TokenVault;
  /** Every connector network call goes through this (tests inject a fake Google). */
  fetch?: FetchFn;
  /**
   * Resolves `{{cred:slug}}` placeholders in connector config (client secrets, API keys).
   * Default: the composed vault (G5).
   */
  credentials?: CredentialBroker;
  /** Attachments and Drive downloads (the Library, S13). */
  library?: LibrarySink;
  /** The paired Mac helper for the Apple app connectors (tests). Default: the newest live one. */
  appleHelper?: () => AppleHelper | undefined;
  /** Connector records. Default: the `connectors` table in the Gateway's database (#505). */
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

function defaultFactories(
  setup: ConnectorsSetup,
  services: ComposeServices,
  mail: MailCredentials,
  helper: () => AppleHelper | undefined,
): ConnectorFactory[] {
  const factories = [
    // Apple Notes, Reminders, Calendar and Mail through the paired Mac helper (#528).
    ...appleFactories({ helper }),
    // Obsidian (#639): the vault is a shared folder; every path passes the same checks as the
    // file tools (granted folder and its mode, protected roots, no symlinks).
    obsidianFactory({
      access: async (path, mode) => {
        assertNotProtected(path, protectedRoots(services.home));
        assertGranted(path, services.rawBroker.policy.folders ?? [], mode);
        await assertNoSymlinks(path);
      },
    }),
    googleFactory({
      openBrowser: setup.openBrowser ?? noBrowser,
      ...(setup.oauthTimeoutMs === undefined ? {} : { timeoutMs: setup.oauthTimeoutMs }),
      // The Desktop client's secret is a vault item: one credential card, reused while live.
      approveSecret: (placeholder, target) =>
        mail.approve({
          connectorId: "google-oauth-client",
          placeholder,
          target,
          purpose: "connect",
        }),
    }),
    // Other mail (M7): the app password or token is a vault item bound to the connector, read
    // under a credential_fill approval the owner gives once per mailbox (mail-credentials.ts).
    imapFactory({ approveCredential: mail.approve, ...(setup.imap ?? {}) }),
    jmapFactory({ approveCredential: mail.approve }),
    // Custom connectors (M9): installed only through their trust card (customConnectorHandlers);
    // their API key is a vault item read under the same once-per-credential approval.
    customFactory({
      approveCredential: (req, run) => mail.approve({ ...req, purpose: "tool" }, run),
    }),
  ];
  if (setup.web?.search !== undefined) factories.push(createWebSearchFactory(setup.web.search));
  if (setup.web?.fetch !== undefined) {
    // Redirect hops stay inside the Task's approved origins (#72).
    factories.push(
      createWebFetchFactory({
        allowedOrigins: taskOrigins(services),
        ...setup.web.fetch,
        beforeFetch: fetchLimit(services),
      }),
    );
  }
  return factories;
}

export function composeConnectors(
  services: ComposeServices,
  setup: ConnectorsSetup = {},
): ComposedPart & { readonly registry: ConnectorRegistry; readonly mail: MailCredentials } {
  const log = services.logger;
  const mail = mailCredentials(services, () => registry);
  let gateway: Gateway | undefined;
  const appleHelper = setup.appleHelper ?? macHelper(() => gateway);
  const factories = setup.factories ?? defaultFactories(setup, services, mail, appleHelper);
  /** Catalogue ids with an implementation here; the rest (remote MCP presets) show unavailable. */
  const implemented = new Set(factories.map((f) => f.entry.id));
  /** connectors.updated for Settings and onboarding (#505): the record as stored now. */
  const publishUpdate = async (event: ConnectorEvent): Promise<void> => {
    if (event.type !== "status" && event.type !== "matrix_changed") return;
    const connector = await registry.get(event.connectorId).catch(() => undefined);
    if (connector === undefined) return;
    const reason =
      event.type === "matrix_changed"
        ? "updated"
        : event.status === "connected"
          ? "connected"
          : event.status === "disconnected"
            ? "disconnected"
            : event.status === "needs_auth"
              ? "needs_auth"
              : "authorization_failed";
    services.publish("connectors.updated", {
      connector: toWire(connector),
      reason,
      ...(event.type === "status" && event.reason !== undefined && event.status !== "connected"
        ? { error: event.reason.slice(0, 200) }
        : {}),
    });
  };
  const registry: ConnectorRegistry = new ConnectorRegistry({
    factories,
    extraCatalogue: setup.extraCatalogue ?? [...REMOTE_MCP_PRESETS, ...COMING_SOON],
    store: setup.store ?? new SqliteConnectorStore(services.db.sqlite),
    context: {
      clock: services.clock,
      fetch: setup.fetch ?? ((input, init) => fetch(input, init)),
      tokens: setup.tokens ?? new VaultTokenVault(services.vault),
      credentials: setup.credentials ?? services.vault,
      ...(setup.library === undefined ? {} : { library: setup.library }),
    },
    tools: services.tools,
    broker: services.broker,
    approvalFor: (callId) => services.calls.approvalFor(callId),
    authorityFor: (callId) => services.calls.authorityFor(callId),
    onEvent: (event) => {
      onConnectorEvent(services, event);
      void publishUpdate(event);
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
  // #505: connect returns at once; an OAuth sign-in comes back pending with its consent page and
  // finishes as connectors.updated. The UI never shows Connected before tokens are stored.
  const googleDefaults = setup.google ?? {};
  const googleConfigured =
    typeof googleDefaults.clientId === "string" && googleDefaults.clientId !== "";
  handlers["connectors.connect"] = {
    run: async (_call: Call, params: never) => {
      const p = (params ?? {}) as {
        catalogueId: string;
        scopeMode: "read" | "read_act";
        label?: string;
        config?: Record<string, unknown>;
        connectorId?: string;
      };
      let config = p.config ?? {};
      if (p.catalogueId === "google") {
        config = {
          ...(googleDefaults.clientId === undefined ? {} : { clientId: googleDefaults.clientId }),
          ...(googleDefaults.clientSecret === undefined
            ? {}
            : { clientSecret: googleDefaults.clientSecret }),
          ...config,
        };
        if (typeof config.clientId !== "string" || config.clientId === "") {
          throw new PsycheError(
            "unavailable",
            "Google is not set up on this Gateway: add your OAuth client id (docs/guides/connectors-google.md)",
            { details: { reason: "not_configured", guide: "docs/guides/connectors-google.md" } },
          );
        }
      }
      const { record, authorization } = await registry.startConnect({
        catalogueId: p.catalogueId,
        scopeMode: p.scopeMode,
        config,
        ...(p.label === undefined ? {} : { label: p.label }),
        ...(p.connectorId === undefined ? {} : { connectorId: p.connectorId }),
      });
      return {
        connector: toWire(record),
        ...(authorization === undefined ? {} : { authorization }),
      };
    },
  };
  handlers["connectors.catalogue"] = {
    run: async () => ({
      // #529: nothing listed as available can fail with "no connector implementation".
      entries: registry.catalogue().map((e) => ({
        ...e,
        available: e.available && implemented.has(e.id),
        ...(e.id === "google" ? { configured: googleConfigured } : {}),
      })),
    }),
  };
  const custom = new CustomConnectors({
    registry,
    broker: services.rawBroker,
    clock: services.clock,
  });
  for (const [name, fn] of Object.entries(customConnectorHandlers(custom))) {
    if (!isMethodName(name)) continue;
    handlers[name] = { run: (_call: Call, params: never) => fn(params) };
  }
  // The agent may draft a custom connector (M9), never enable one: this only opens the owner's
  // device-only trust card. Whatever it submits is marked as agent-drafted on the card.
  const unregisterDraft = services.tools.register({
    spec: {
      name: "connectors_propose_custom",
      description:
        "Draft a custom REST connector for the owner to review. Give either a manifest (schemaVersion 1: id, name, description, version, https baseUrl, hosts, auth with a {{cred:slug}} placeholder, tools with method, path, params and sideEffect) or an OpenAPI 3 document with the operations to include. This only shows the owner a review card on their device; nothing is installed or enabled.",
      inputSchema: {
        type: "object",
        properties: {
          manifest: { type: "object" },
          openapi: {
            type: "object",
            properties: {
              document: { type: "string" },
              id: { type: "string" },
              operations: { type: "array", items: { type: "string" } },
            },
            required: ["document", "id"],
          },
        },
        additionalProperties: false,
      },
      sideEffect: "none",
      provenanceOut: "trusted",
    },
    execute: async (_callId, params) => {
      const p = (params ?? {}) as {
        manifest?: Record<string, unknown>;
        openapi?: { document: string; id: string; operations?: string[] };
      };
      const { proposal, approval } = await custom.propose({
        ...(p.manifest === undefined ? {} : { manifest: p.manifest }),
        ...(p.openapi === undefined ? {} : { openapi: p.openapi }),
        drafted: "agent",
      });
      return {
        output: {
          proposalId: proposal.id,
          approvalId: approval.id,
          hash: proposal.hash,
          findings: proposal.findings.map((f) => `${f.severity}: ${f.message}`),
          note: "The owner reviews this on their device; it is not installed.",
        },
        provenance: "trusted",
      };
    },
  });

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
        // Waiting on a macOS grant (#549): re-check it, so the row flips once it is allowed.
        if (record.status === "needs_auth" && typeof record.config.permission === "object") {
          await registry.status(record.id).catch(() => undefined);
          continue;
        }
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
    mail,
    handlers,
    start(gw) {
      gateway = gw;
      // After a restart: duplicates of one-per-machine connectors go (#549, oldest kept), then
      // connected records come back (tools registered, tokens from the vault).
      void (async () => {
        for (const { removed, kept } of await registry.dedupe()) {
          await services.audit
            .append({
              kind: "connector.duplicate_removed",
              actor: { type: "system" },
              data: { connectorId: removed.id, type: removed.type, kept } as never,
            })
            .catch(() => undefined);
        }
        await registry.restore();
      })().catch((err) =>
        log?.log("warn", "connector restore failed", { code: PsycheError.from(err).code }),
      );
      if (interval <= 0) return;
      timer = setInterval(() => void syncAll(), interval);
      timer.unref?.();
    },
    async stop() {
      unregisterDraft();
      unsubscribeRevoked();
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await registry.close();
    },
  };
}

/** The newest live Mac helper node with its advertised capabilities (J6 app adapters). */
export function macHelper(gateway: () => Gateway | undefined): () => AppleHelper | undefined {
  return () => {
    const nodes = gateway()?.context.nodes;
    if (nodes === undefined) return undefined;
    const node = nodes
      .list()
      .filter((n) => n.kind === "mac-helper" && nodes.isLive(n.id))
      .at(-1);
    const client = node === undefined ? undefined : nodes.client(node.id);
    if (node === undefined || client === undefined) return undefined;
    return {
      nodeId: node.id,
      capabilities: node.capabilities.map((c) => c.name),
      invoke: async (capability, params, options) => {
        const res = await client.invoke(capability, params, options);
        return {
          ok: res.ok,
          ...(res.result === undefined ? {} : { result: res.result }),
          ...(res.error === undefined
            ? {}
            : {
                error: {
                  code: res.error.code,
                  message: res.error.message,
                  ...(res.error.details === undefined
                    ? {}
                    : { details: res.error.details as Record<string, unknown> }),
                },
              }),
        };
      },
    };
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
