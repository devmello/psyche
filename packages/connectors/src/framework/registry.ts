import {
  type Clock,
  namespacedGrantKey,
  type PermissionBroker,
  PsycheError,
  type SideEffect,
  type ToolCallAuthority,
  type ToolCallDescription,
  type ToolRegistry,
  type ToolResult,
  type Unsubscribe,
} from "@psyche/protocol";
import { toolCallBindingHash } from "./binding.ts";
import type {
  ActionRule,
  CatalogueEntry,
  Connector,
  ConnectorContext,
  ConnectorEvent,
  ConnectorFactory,
  ConnectorRecord,
  ConnectorStore,
  ConnectorTool,
  PendingAuthorization,
  ScopeMode,
} from "./types.ts";

/** Side-effect classes that never take an `allow` rule (security §3.4: no standing grants). */
const NO_STANDING: SideEffect[] = ["destructive", "financial"];
const READ_ONLY: SideEffect[] = ["none", "read"];

export class MemoryConnectorStore implements ConnectorStore {
  readonly #rows = new Map<string, ConnectorRecord>();
  async get(id: string) {
    const r = this.#rows.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }
  async list() {
    return [...this.#rows.values()].map((r) => structuredClone(r));
  }
  async put(record: ConnectorRecord) {
    this.#rows.set(record.id, structuredClone(record));
  }
  async delete(id: string) {
    this.#rows.delete(id);
  }
}

export interface ConnectorRegistryOptions {
  factories: ConnectorFactory[];
  /** Catalogue entries without a local implementation (remote MCP presets, coming-soon rows). */
  extraCatalogue?: CatalogueEntry[];
  store?: ConnectorStore;
  context: Omit<ConnectorContext, "emit">;
  /** Agent-core registry; connector tools register as `mcp__<connectorId>__<tool>`. */
  tools?: ToolRegistry;
  /** Receipts for every write and binding re-verification right before dispatch. */
  broker?: PermissionBroker;
  /** The approval id the broker issued for a tool call (from the agent loop), if any. */
  approvalFor?: (callId: string) => string | undefined;
  /**
   * What authorized a tool call as the agent loop verified it (`ToolRunContext.authority`): an
   * approval the owner answered, or a standing `task` / `site` / `session` / `always` grant.
   * Preferred over `approvalFor`, which cannot carry a standing grant.
   */
  authorityFor?: (callId: string) => ToolCallAuthority | undefined;
  onEvent?: (event: ConnectorEvent) => void;
  newId?: () => string;
}

export interface ConnectOptions {
  /** Called once the record exists as `needs_auth`, before the sign-in starts. */
  onPending?: (record: ConnectorRecord) => void;
  /** Passed to the connector: the consent page to show the owner. */
  onAuthorization?: (pending: PendingAuthorization) => void;
}

export interface ConnectRequest {
  /** Catalogue id of a first-party connector. */
  catalogueId: string;
  scopeMode: ScopeMode;
  label?: string;
  config?: Record<string, unknown>;
  /** Reconnect an existing record (re-auth, scope change). */
  connectorId?: string;
}

interface Live {
  connector: Connector;
  unregister: Unsubscribe[];
}

/**
 * Owns connector records and instances: catalogue, connect / disconnect, action matrix, status,
 * sync, and tool registration with enforcement (matrix deny, read-only scope, binding
 * re-verification, receipts). Emits `invalidated` when the account behind a connection changes
 * or the connection goes away, so tasks and approvals bound to it can be dropped (M5).
 */
export class ConnectorRegistry {
  readonly #opts: ConnectorRegistryOptions;
  readonly #store: ConnectorStore;
  readonly #factories = new Map<string, ConnectorFactory>();
  readonly #live = new Map<string, Live>();
  readonly #clock: Clock;
  #seq = 0;

  constructor(options: ConnectorRegistryOptions) {
    this.#opts = options;
    this.#store = options.store ?? new MemoryConnectorStore();
    this.#clock = options.context.clock;
    for (const f of options.factories) this.#factories.set(f.entry.id, f);
  }

  catalogue(): CatalogueEntry[] {
    const local = [...this.#factories.values()].map((f) => f.entry);
    const ids = new Set(local.map((e) => e.id));
    return [...local, ...(this.#opts.extraCatalogue ?? []).filter((e) => !ids.has(e.id))].map((e) =>
      structuredClone(e),
    );
  }

  list(): Promise<ConnectorRecord[]> {
    return this.#store.list();
  }

  async get(id: string): Promise<ConnectorRecord> {
    const r = await this.#store.get(id);
    if (r === undefined) throw new PsycheError("not_found", `connector ${id} not found`);
    return r;
  }

  async connect(req: ConnectRequest, options: ConnectOptions = {}): Promise<ConnectorRecord> {
    const factory = this.#factories.get(req.catalogueId);
    if (factory === undefined || !factory.entry.available) {
      throw new PsycheError("not_found", `no connector implementation for ${req.catalogueId}`);
    }
    if (req.scopeMode !== "read" && req.scopeMode !== "read_act") {
      throw new PsycheError("invalid_params", "scopeMode must be read or read_act");
    }
    const now = new Date(this.#clock.now()).toISOString();
    const existing = req.connectorId === undefined ? undefined : await this.get(req.connectorId);
    if (existing !== undefined && existing.type !== factory.entry.type) {
      throw new PsycheError("conflict", "connector type cannot change");
    }
    const record: ConnectorRecord = existing ?? {
      id: this.#newId(factory.entry.id),
      type: factory.entry.type,
      label: req.label ?? factory.entry.label,
      account: null,
      scopes: [],
      scopeMode: req.scopeMode,
      actionMatrix: Object.fromEntries(factory.entry.actions.map((a) => [a.id, a.defaultRule])),
      credentialId: null,
      status: "needs_auth",
      config: {},
      lastSync: null,
      createdAt: now,
      updatedAt: now,
    };
    const previousAccount = record.account;
    const previousMode = record.scopeMode;
    record.scopeMode = req.scopeMode;
    record.config = { ...record.config, ...(req.config ?? {}) } as ConnectorRecord["config"];
    await this.#teardown(record.id);
    if (options.onPending !== undefined) {
      // Visible as "signing in" (needs_auth) while the owner finishes the consent elsewhere.
      record.status = "needs_auth";
      record.updatedAt = now;
      await this.#store.put(record);
      options.onPending(structuredClone(record));
    }
    const connector = factory.create(record, {
      ...this.#opts.context,
      emit: (e) => void this.#fromConnector(e),
    });
    try {
      const result = await connector.connect({
        scopeMode: req.scopeMode,
        config: record.config,
        ...(options.onAuthorization === undefined
          ? {}
          : { onAuthorization: options.onAuthorization }),
      });
      record.account = result.account;
      record.scopes = result.scopes;
      if (result.credentialId !== undefined) record.credentialId = result.credentialId;
      if (result.config !== undefined) record.config = { ...record.config, ...result.config };
      record.status = "connected";
    } catch (err) {
      record.status = "error";
      record.updatedAt = new Date(this.#clock.now()).toISOString();
      await this.#store.put(record);
      this.#emit({ type: "status", connectorId: record.id, status: "error", reason: message(err) });
      throw err;
    }
    record.updatedAt = new Date(this.#clock.now()).toISOString();
    await this.#store.put(record);
    if (existing !== undefined && previousAccount !== null && previousAccount !== record.account) {
      this.#emit({
        type: "invalidated",
        connectorId: record.id,
        reason: "account_changed",
        previousAccount,
        account: record.account,
      });
    } else if (
      existing !== undefined &&
      previousMode === "read_act" &&
      record.scopeMode === "read"
    ) {
      this.#emit({
        type: "invalidated",
        connectorId: record.id,
        reason: "scope_changed",
        previousAccount,
        account: record.account,
      });
    }
    this.#live.set(record.id, { connector, unregister: this.#register(record, connector) });
    this.#emit({ type: "status", connectorId: record.id, status: "connected" });
    return structuredClone(record);
  }

  /**
   * Starts connecting without waiting for the owner (#505): resolves as soon as a sign-in is
   * pending (with its consent page) or the connect finished, whichever comes first. A connect
   * that completes later ends in a `status` event (`connected` or `error`).
   */
  startConnect(
    req: ConnectRequest,
  ): Promise<{ record: ConnectorRecord; authorization?: PendingAuthorization }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let pending: ConnectorRecord | undefined;
      const done = this.connect(req, {
        onPending: (r) => {
          pending = r;
        },
        onAuthorization: (authorization) => {
          if (settled || pending === undefined) return;
          settled = true;
          resolve({ record: structuredClone(pending), authorization });
        },
      });
      done.then(
        (record) => {
          if (settled) return;
          settled = true;
          resolve({ record });
        },
        (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
      );
    });
  }

  /**
   * After a restart: bring stored `connected` records back to life (tools registered, tokens
   * read from the vault on use) without running their sign-in again. A record whose connector
   * cannot be created (config gone bad, factory missing) turns `error`.
   */
  async restore(): Promise<number> {
    let n = 0;
    for (const record of await this.#store.list()) {
      if (record.status !== "connected" || this.#live.has(record.id)) continue;
      const factory = [...this.#factories.values()].find((f) => f.entry.type === record.type);
      try {
        if (factory === undefined)
          throw new PsycheError("not_found", `no factory for ${record.type}`);
        const connector = factory.create(record, {
          ...this.#opts.context,
          emit: (e) => void this.#fromConnector(e),
        });
        this.#live.set(record.id, { connector, unregister: this.#register(record, connector) });
        n += 1;
      } catch (err) {
        record.status = "error";
        record.updatedAt = new Date(this.#clock.now()).toISOString();
        await this.#store.put(record);
        this.#emit({
          type: "status",
          connectorId: record.id,
          status: "error",
          reason: message(err),
        });
      }
    }
    return n;
  }

  async disconnect(id: string): Promise<ConnectorRecord> {
    const record = await this.get(id);
    const live = this.#live.get(id);
    await this.#teardown(id);
    await live?.connector.disconnect().catch(() => undefined);
    await this.#opts.context.tokens.clear(id);
    record.status = "disconnected";
    record.updatedAt = new Date(this.#clock.now()).toISOString();
    await this.#store.put(record);
    this.#emit({
      type: "invalidated",
      connectorId: id,
      reason: "disconnected",
      previousAccount: record.account,
      account: null,
    });
    this.#emit({ type: "status", connectorId: id, status: "disconnected" });
    return structuredClone(record);
  }

  async remove(id: string): Promise<void> {
    if (this.#live.has(id)) await this.disconnect(id);
    await this.#store.delete(id);
  }

  async status(id: string) {
    const record = await this.get(id);
    const live = this.#live.get(id);
    if (live === undefined) {
      return { ok: false, status: record.status, checkedAt: this.#clock.now() };
    }
    return live.connector.health();
  }

  /** Merge rule changes; unknown actions and `allow` on destructive / financial actions are refused. */
  async setMatrix(id: string, patch: Record<string, ActionRule>): Promise<ConnectorRecord> {
    const record = await this.get(id);
    const actions = this.#actionsFor(record);
    for (const [key, rule] of Object.entries(patch)) {
      const action = actions.find((a) => a.id === key);
      if (action === undefined) throw new PsycheError("invalid_params", `unknown action ${key}`);
      if (rule !== "allow" && rule !== "ask" && rule !== "deny") {
        throw new PsycheError("invalid_params", `invalid rule for ${key}`);
      }
      if (rule === "allow" && NO_STANDING.includes(action.sideEffect)) {
        throw new PsycheError(
          "policy_denied",
          `${key} is ${action.sideEffect}; it can only be ask or deny`,
        );
      }
    }
    record.actionMatrix = { ...record.actionMatrix, ...patch };
    record.updatedAt = new Date(this.#clock.now()).toISOString();
    await this.#store.put(record);
    this.#emit({ type: "matrix_changed", connectorId: id, matrix: { ...record.actionMatrix } });
    return structuredClone(record);
  }

  async sync(id: string, signal?: AbortSignal) {
    const record = await this.get(id);
    const live = this.#live.get(id);
    if (live === undefined || record.status !== "connected") {
      throw new PsycheError("unavailable", `connector ${id} is not connected`, { retryable: true });
    }
    if (live.connector.sync === undefined)
      return { changes: 0, full: false, cursor: record.lastSync ?? {} };
    const result = await live.connector.sync(record.lastSync, signal);
    record.lastSync = result.cursor;
    record.updatedAt = new Date(this.#clock.now()).toISOString();
    await this.#store.put(record);
    this.#emit({ type: "synced", connectorId: id, changes: result.changes, full: result.full });
    return result;
  }

  /** Rules for the Permissions screen: every connector action, keyed by tool name (M11). */
  async permissionRows() {
    const rows: {
      connectorId: string;
      tool: string;
      action: string;
      sideEffect: SideEffect;
      rule: ActionRule;
    }[] = [];
    for (const record of await this.#store.list()) {
      const live = this.#live.get(record.id);
      if (live === undefined) continue;
      for (const t of live.connector.tools()) {
        rows.push({
          connectorId: record.id,
          tool: toolName(record.id, t.name),
          action: t.action,
          sideEffect: t.sideEffect,
          rule: record.actionMatrix[t.action] ?? "ask",
        });
      }
    }
    return rows;
  }

  /** The live instance (for the Gateway's pollers and tests). */
  instance(id: string): Connector | undefined {
    return this.#live.get(id)?.connector;
  }

  async close(): Promise<void> {
    for (const id of [...this.#live.keys()]) await this.#teardown(id);
  }

  // --- internals ------------------------------------------------------------------------------

  #actionsFor(record: ConnectorRecord) {
    const live = this.#live.get(record.id);
    if (live !== undefined) return live.connector.actions();
    const f = [...this.#factories.values()].find((x) => x.entry.type === record.type);
    return f?.entry.actions ?? [];
  }

  #register(record: ConnectorRecord, connector: Connector): Unsubscribe[] {
    const registry = this.#opts.tools;
    if (registry === undefined) return [];
    const out: Unsubscribe[] = [];
    for (const tool of connector.tools()) {
      // A read-only connection does not even offer write tools to the model.
      if (record.scopeMode === "read" && !READ_ONLY.includes(tool.sideEffect)) continue;
      const reg: Parameters<ToolRegistry["register"]>[0] = {
        spec: {
          name: toolName(record.id, tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
          sideEffect: tool.sideEffect,
          provenanceOut: "untrusted",
        },
        execute: (callId, params, signal) => this.#run(record.id, tool, callId, params, signal),
      };
      if (tool.describeCall !== undefined) reg.describeCall = tool.describeCall;
      out.push(registry.register(reg));
    }
    return out;
  }

  /** Executor wrapper: matrix and scope enforcement, binding check, receipt. */
  async #run(
    connectorId: string,
    tool: ConnectorTool,
    callId: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) throw new PsycheError("cancelled", "call aborted");
    const record = await this.get(connectorId);
    const live = this.#live.get(connectorId);
    if (live === undefined || record.status !== "connected") {
      throw new PsycheError("unavailable", `connector ${connectorId} is not connected`, {
        retryable: true,
      });
    }
    const desc: ToolCallDescription | undefined = tool.describeCall?.(params);
    // The more severe of the spec's class and the per-call description (AgentLoop contract).
    const effect = moreSevere(tool.sideEffect, desc?.sideEffect);
    const writes = !READ_ONLY.includes(effect);
    let rule = record.actionMatrix[tool.action] ?? "ask";
    if (rule === "allow" && NO_STANDING.includes(effect)) rule = "ask";
    if (rule === "deny") throw new PsycheError("policy_denied", `${tool.action} is set to deny`);
    if (writes && record.scopeMode === "read") {
      throw new PsycheError("policy_denied", "this connection is read-only");
    }
    const authority = this.#opts.authorityFor?.(callId);
    const approvalId = authority?.approvalId ?? this.#opts.approvalFor?.(callId);
    // A standing grant the loop verified, when no approval was answered for this very call.
    const grantId = approvalId === undefined ? authority?.grantId : undefined;
    // Fail closed: an `ask` write needs an approval or a standing grant, and a broker to verify
    // it against.
    if (writes && rule === "ask" && approvalId === undefined && grantId === undefined) {
      throw new PsycheError("approval_required", `${tool.action} needs the owner's approval`);
    }
    const name = toolName(connectorId, tool.name);
    if (writes && approvalId !== undefined) {
      const broker = this.#opts.broker;
      if (broker === undefined) {
        throw new PsycheError("unavailable", "no permission broker to verify the approval");
      }
      // The loop is the single verifier: it consumed the approval (`verifyBinding`) right before
      // dispatch. Here the executor only confirms, without consuming, that the approval it was
      // handed is approved, belongs to this call and binds these exact arguments (issue #78).
      const approval = await broker.get(approvalId);
      const expected = toolCallBindingHash(name, params, desc);
      const reason =
        approval === undefined
          ? "not_found"
          : approval.status !== "approved"
            ? `not_approved (${approval.status})`
            : approval.requestedBy.toolCallId !== undefined &&
                approval.requestedBy.toolCallId !== callId
              ? "another_call"
              : approval.bindingHash !== expected
                ? "binding_mismatch"
                : undefined;
      if (reason !== undefined) {
        throw new PsycheError("binding_mismatch", `approval does not cover this call (${reason})`);
      }
    } else if (writes && grantId !== undefined) {
      const broker = this.#opts.broker;
      if (broker === undefined) {
        throw new PsycheError("unavailable", "no permission broker to verify the grant");
      }
      // The same check for a standing grant (security §3.4, §3.7 "Dispatch"): the grant is live
      // and its key is the one these exact arguments produce. A tool without a grant key of its
      // own can only be covered by an approval, never by a grant (PR #86 note).
      const grant = (await broker.listGrants()).find((g) => g.id === grantId);
      const expected =
        desc?.grantKey === undefined ? undefined : namespacedGrantKey(name, desc.grantKey);
      const now = this.#opts.context.clock.now();
      const reason =
        grant === undefined
          ? "not_found"
          : grant.revokedAt != null
            ? "revoked"
            : grant.expiresAt != null && Date.parse(grant.expiresAt) <= now
              ? "expired"
              : expected === undefined
                ? "no_grant_key"
                : grant.grantKey !== expected
                  ? "grant_key_mismatch"
                  : effect === "financial"
                    ? "no_standing_grants_for_financial"
                    : effect === "destructive" && grant.scope !== "task"
                      ? `scope_${grant.scope}_not_allowed_for_destructive`
                      : undefined;
      if (reason !== undefined) {
        throw new PsycheError(
          "binding_mismatch",
          `standing grant does not cover this call (${reason})`,
        );
      }
    }
    try {
      const out = await tool.execute(params, {
        signal,
        callId,
        ...(approvalId === undefined ? {} : { approvalId }),
        ...(authority === undefined ? {} : { authority }),
      });
      let receiptId: string | undefined;
      if (writes && this.#opts.broker !== undefined) {
        const r = await this.#opts.broker.recordReceipt({
          kind: tool.action,
          outcome: out.isError === true ? "failed" : "ok",
          summary: out.receiptSummary ?? desc?.summary ?? `${tool.action} via ${connectorId}`,
          toolCallId: callId,
          approvalId: approvalId ?? null,
          ...(out.externalRefs === undefined ? {} : { externalRefs: out.externalRefs }),
        });
        receiptId = r.id;
      }
      const result: ToolResult = { output: out.output, provenance: out.provenance };
      if (out.isError === true) result.isError = true;
      if (receiptId !== undefined) result.receiptId = receiptId;
      return result;
    } catch (err) {
      if (
        writes &&
        this.#opts.broker !== undefined &&
        !(err instanceof PsycheError && err.code === "cancelled")
      ) {
        // A write that threw mid-flight may or may not have reached the provider.
        await this.#opts.broker
          .recordReceipt({
            kind: tool.action,
            outcome: "uncertain",
            summary: `${tool.action} via ${connectorId} did not confirm`,
            toolCallId: callId,
            approvalId: approvalId ?? null,
          })
          .catch(() => undefined);
      }
      throw err;
    }
  }

  async #teardown(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (live === undefined) return;
    this.#live.delete(id);
    for (const u of live.unregister) u();
  }

  #newId(prefix: string): string {
    if (this.#opts.newId !== undefined) return this.#opts.newId();
    this.#seq += 1;
    return `${prefix.replace(/[^a-z0-9-]/g, "-")}-${this.#clock.now().toString(36)}${this.#seq}`;
  }

  /** Connector-originated events: a status change (e.g. `needs_auth`) updates the record first. */
  async #fromConnector(event: ConnectorEvent): Promise<void> {
    if (event.type === "status") {
      const record = await this.#store.get(event.connectorId);
      if (record !== undefined && record.status !== event.status) {
        record.status = event.status;
        record.updatedAt = new Date(this.#clock.now()).toISOString();
        await this.#store.put(record);
      }
    }
    this.#emit(event);
  }

  #emit(event: ConnectorEvent): void {
    try {
      this.#opts.onEvent?.(event);
    } catch {
      // listeners never break the registry
    }
  }
}

const SEVERITY: SideEffect[] = ["none", "read", "write", "destructive", "financial"];

function moreSevere(a: SideEffect, b: SideEffect | undefined): SideEffect {
  if (b === undefined) return a;
  return SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a;
}

/** Connector tools use the MCP naming so allow / ask / deny rules look the same (ToolSpec). */
export function toolName(connectorId: string, tool: string): `mcp__${string}__${string}` {
  return `mcp__${connectorId.replace(/[^a-z0-9-]/g, "-")}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
