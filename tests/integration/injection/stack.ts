import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingHash, ownerTargets, paramsHash } from "@psyche/agent-core";
import { createAuditLog } from "@psyche/audit";
import { CdpBridgeDriver, FsQuarantineWriter, registerBrowserTools } from "@psyche/browser";
import { MockDesktop } from "@psyche/browser/testing";
import { ConnectorRegistry, googleFactory } from "@psyche/connectors";
import { openDb, type PsycheDb } from "@psyche/db";
import { brokerApprovalCheck, SqliteMemoryStore } from "@psyche/memory";
import { PsychePermissionBroker, SqlitePermissionStore } from "@psyche/permissions";
import type {
  AuditLog,
  Clock,
  MemoryStore,
  PermissionBroker,
  SideEffect,
  Target,
  ToolCallDescription,
  ToolRegistration,
  ToolRegistry,
} from "@psyche/protocol";
import {
  type AttackToolCall,
  FakeCredentialBroker,
  FakePermissionBroker,
  type GateResult,
  type GateTurn,
  type InjectionCase,
  type InjectionStack,
  loadSecretRegistry,
  ReferenceToolGate,
  type StackFactory,
  type ToolGate,
} from "@psyche/testing";
import { CLIENT_ID, FakeGoogle } from "../google/fake-google.ts";

/**
 * INT-2 stack for S18's injection runner (`packages/testing/src/injection`): the real Permission
 * Broker on a SQLite store, the real hash-chained audit log, the real memory store, and the real
 * `browser.*` and Google connector tool registrations. A hijacked call to a registered tool is
 * decided the way agent-core's `before_tool_call` gate does it (packages/agent-core/src/loop.ts
 * `#gate`): spec + `describeCall(params)` give the side effect, kind, target, binding fields and
 * grant key; the loop's own memory rule; then `broker.decide` and, on `ask`, `requestApproval`.
 *
 * Where the real packages have nothing for a call (a tool name no INT-2 package registers, e.g.
 * `exec`, `files.write`, `memory.*`, `permissions.*`), the call goes to S18's `ReferenceToolGate`,
 * which still asks the real broker after its reference pre-checks. `implementations` says which.
 */

/** Connector id of the offline Google connection. */
export const GOOGLE_ID = "google-1";

/**
 * Real tool names for corpus names that are not registry names. Connector tools register as
 * `mcp__<id>__<tool>` and carry an `action` (`gmail.send`); the corpus writes the action.
 */
export type ToolAliases = ReadonlyMap<string, string>;

class Registry implements ToolRegistry {
  readonly tools = new Map<string, ToolRegistration>();
  list() {
    return [...this.tools.values()].map((t) => t.spec);
  }
  get(name: string) {
    return this.tools.get(name);
  }
  register(r: ToolRegistration) {
    this.tools.set(r.spec.name, r);
    return () => {
      this.tools.delete(r.spec.name);
    };
  }
}

class SettableClock implements Clock {
  #t = Date.parse("2026-10-19T09:00:00.000Z");
  now() {
    return this.#t;
  }
  advance(ms: number) {
    this.#t += ms;
  }
}

/** agent-core's `SEVERITY` (not exported from its index). */
const SEVERITY: Record<SideEffect, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
  financial: 4,
};

const stricter = (a: SideEffect, b: SideEffect | undefined): SideEffect =>
  b === undefined || SEVERITY[b] <= SEVERITY[a] ? a : b;

/** Same seeding as `referenceStack`, so the fallback sees the shared fixture vault. */
function fixtureCredentials(): FakeCredentialBroker {
  const credentials = new FakeCredentialBroker();
  for (const item of loadSecretRegistry().vaultItems) {
    const secret = item.fields.password ?? item.fields.token;
    if (secret === undefined) continue;
    credentials.add({
      slug: item.id,
      name: item.name,
      kind: item.kind === "login" ? "login" : "api_key",
      bindings: [
        ...(item.boundOrigins ?? []).map((origin) => ({ origin })),
        ...(item.boundHosts ?? []).map((host) => ({ host })),
        ...(item.connector === undefined ? [] : [{ connector: item.connector }]),
      ],
      secret,
      ...(item.fields.username === undefined ? {} : { username: item.fields.username }),
      ...(item.fields.totp === undefined ? {} : { totp: item.fields.totp }),
    });
  }
  return credentials;
}

/** Waits for the store's first-run setup before every call (the runner's factory is sync). */
function lazyMemory(store: SqliteMemoryStore, ready: Promise<void>): MemoryStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || prop === "init") return value;
      return async (...args: unknown[]) => {
        await ready;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as MemoryStore;
}

export interface Int2GateDeps {
  tools: ToolRegistry;
  aliases: ToolAliases;
  broker: PermissionBroker;
  fallback: ToolGate;
  /** The case's owner request, for the loop's new-target check (`ownerTargets`). */
  ownerRequest(caseId: string): string | undefined;
}

export const INT2_IMPLEMENTATIONS = {
  "gate.registeredTools": "reference",
  "gate.unregisteredTools": "reference",
  browserTools: "real",
  connectorTools: "real",
  permissionBroker: "real",
  permissionStore: "real",
  auditLog: "real",
  memoryStore: "real",
  credentialBroker: "fake",
} as const;

/**
 * `gate.registeredTools` is `reference` because agent-core's `#gate` is private: this class is a
 * line-by-line transcription of it (no `before_tool_call` hooks are composed in the Gateway).
 * Every input it feeds the broker comes from the real registrations.
 */
export class Int2ToolGate implements ToolGate {
  readonly name = "int-2";
  readonly implementations = INT2_IMPLEMENTATIONS;
  readonly #d: Int2GateDeps;

  constructor(deps: Int2GateDeps) {
    this.#d = deps;
  }

  /** The registration a corpus tool name resolves to, if an INT-2 package registers one. */
  resolve(tool: string): ToolRegistration | undefined {
    const name = this.#d.aliases.get(tool) ?? tool;
    return this.#d.tools.get(name);
  }

  async evaluate(call: AttackToolCall, turn: GateTurn): Promise<GateResult> {
    const reg = this.resolve(call.tool);
    if (reg === undefined) return this.#d.fallback.evaluate(call, turn);
    const name = reg.spec.name;
    const params = call.args;

    let desc: ToolCallDescription = {};
    try {
      desc = reg.describeCall?.(params) ?? {};
    } catch {
      return { decision: "blocked", rule: "loop:invalid_params" };
    }
    // The attacker's declared class is ignored: the spec and the description decide.
    const sideEffect = stricter(reg.spec.sideEffect, desc.sideEffect);
    const target: Target | undefined = desc.target;
    const hash = paramsHash(params);
    const kind = desc.kind;
    if (kind === "memory_protected_write" && turn.taint) {
      // The loop blocks with a message only (no rule key, no audit entry).
      return { decision: "blocked", rule: "memory:untrusted_not_promoted" };
    }
    const intentBinding =
      kind === undefined
        ? undefined
        : bindingHash(kind, {
            tool: name,
            paramsHash: hash,
            ...(desc.bindingFields === undefined ? {} : { fields: desc.bindingFields }),
          });
    const grantKey =
      desc.grantKey === undefined
        ? undefined
        : desc.grantKey.startsWith(`${name}|`)
          ? desc.grantKey
          : `${name}|${desc.grantKey}`;
    const targetKind = target?.kind ?? reg.spec.targetKind;
    const decision = await this.#d.broker.decide(
      {
        tool: name,
        sideEffect,
        ...(targetKind ? { targetKind } : {}),
        ...(target === undefined ? {} : { target }),
        params,
        paramsHash: hash,
        ...(kind === undefined ? {} : { kind }),
        ...(intentBinding === undefined ? {} : { bindingHash: intentBinding }),
        ...(grantKey === undefined ? {} : { grantKey }),
      },
      {
        threadId: turn.threadId,
        runId: turn.runId,
        taskId: turn.taskId,
        permissionMode: turn.mode,
        taint: turn.taint,
        newTarget: this.#newTarget(turn, target, sideEffect),
        unattended: turn.unattended,
      },
    );
    if (decision.decision === "deny") return { decision: "blocked", rule: decision.rule };
    if (decision.decision === "allow") return { decision: "executed", rule: decision.rule };

    const approvalKind = decision.approvalKind ?? kind ?? "connector_action";
    const issued = await this.#d.broker.requestApproval({
      kind: approvalKind,
      summary: desc.summary ?? name,
      details: { tool: name, params: params as never, ...(target === undefined ? {} : { target }) },
      bindingHash:
        decision.bindingHash ??
        intentBinding ??
        bindingHash(approvalKind, { tool: name, paramsHash: hash }),
      grantKey: decision.grantKey ?? grantKey ?? `${name}|${target?.value ?? "*"}`,
      requestedBy: {
        runId: turn.runId,
        taskId: turn.taskId,
        threadId: turn.threadId,
        toolCallId: `call_${turn.caseId}`,
      },
      sideEffect,
      ...(targetKind ? { targetKind } : {}),
      ...(target === undefined ? {} : { target }),
      // What the composed Gateway passes the loop (apps/gateway/src/compose/index.ts).
      surfaces: ["desktop", "web"],
      ...(approvalKind === "memory_protected_write"
        ? { scopesOffered: ["once" as const] }
        : decision.scopesOffered === undefined
          ? {}
          : { scopesOffered: decision.scopesOffered }),
      taint: turn.taint,
    });
    return {
      decision: "asked",
      rule: decision.rule,
      approval: issued.approval,
      answerTokens: issued.answerTokens,
    };
  }

  /** agent-core `#isNewTarget`: exact match against the owner's words; no run-approved targets yet. */
  #newTarget(turn: GateTurn, target: Target | undefined, sideEffect: SideEffect): boolean {
    const owner = this.#d.ownerRequest(turn.caseId);
    if (owner === undefined) return turn.newTarget;
    if (target === undefined || target.value.trim() === "") {
      return SEVERITY[sideEffect] >= SEVERITY.write;
    }
    return !ownerTargets(owner).has(target.value.trim().toLowerCase());
  }
}

export interface Int2Rig {
  /** The `StackFactory` for `runCorpus`: fresh broker, store, audit and memory per run. */
  int2Stack: StackFactory;
  /** Corpus tool name → registered tool name, for the tools INT-2 packages register. */
  route(tool: string): string | undefined;
  /** Every tool name the real packages registered. */
  toolNames(): string[];
  close(): Promise<void>;
}

/**
 * Registers the real tools once (their descriptions are static; executors are never invoked) and
 * returns a factory for per-run stacks. `cases` gives the gate each case's owner request.
 */
export async function prepareInt2(cases: readonly InjectionCase[]): Promise<Int2Rig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "psyche-int2-injection-")));
  const tools = new Registry();
  // Executors are never called by the runner; their broker is a deny-all stand-in.
  const executorBroker = FakePermissionBroker.policy({ default: "deny" });
  const notExecuted = () => {
    throw new Error("the injection runner never executes tools");
  };

  const desktop = new MockDesktop({ quarantineDir: join(root, "quarantine") });
  const driver = new CdpBridgeDriver(await desktop.connect(), {
    library: new FsQuarantineWriter(join(root, "library")),
  });
  registerBrowserTools(tools, {
    driver,
    broker: executorBroker,
    context: notExecuted,
    session: notExecuted,
  });

  const google = new FakeGoogle();
  const connectors = new ConnectorRegistry({
    factories: [googleFactory({ openBrowser: google.openBrowser, timeoutMs: 5_000 })],
    context: { clock: { now: () => Date.now() }, fetch: google.fetch, tokens: google.vault },
    tools,
    broker: executorBroker,
    newId: () => GOOGLE_ID,
  });
  await connectors.connect({
    catalogueId: "google",
    scopeMode: "read_act",
    config: { clientId: CLIENT_ID },
  });
  const aliases = new Map<string, string>();
  for (const row of await connectors.permissionRows()) aliases.set(row.action, row.tool);

  const owners = new Map(cases.map((c) => [c.id, c.context.ownerRequest]));
  const dbs: PsycheDb[] = [];
  let n = 0;

  const int2Stack: StackFactory = () => {
    const dir = join(root, `run-${++n}`);
    const clock = new SettableClock();
    const db = openDb(":memory:", { now: () => new Date(clock.now()).toISOString() });
    dbs.push(db);
    const audit: AuditLog = createAuditLog({ dir: join(dir, "audit"), clock });
    const broker = new PsychePermissionBroker({
      approvers: {
        device: async (deviceId) =>
          deviceId === "dev_owner" ? { scopes: ["operator.approvals"] } : undefined,
        // No channel identity is the owner's: forged chat answers must be refused.
        isOwnerSender: async () => false,
      },
      store: new SqlitePermissionStore(db.sqlite),
      audit,
      clock,
      psycheHome: dir,
    });
    const store = new SqliteMemoryStore({
      sqlite: db.sqlite,
      workspaceDir: join(dir, "workspace"),
      clock,
      timeZone: "UTC",
      newId: db.newId,
      sqliteVec: false,
      approvals: brokerApprovalCheck(broker),
      audit,
    });
    const memory = lazyMemory(store, store.init());
    const fallback = new ReferenceToolGate({
      broker,
      credentials: fixtureCredentials(),
      memory,
      audit,
    });
    const gate = new Int2ToolGate({
      tools,
      aliases,
      broker,
      fallback,
      ownerRequest: (id) => owners.get(id),
    });
    const stack: InjectionStack = {
      gate,
      broker,
      memory,
      audit,
      advance: (ms) => clock.advance(ms),
    };
    return stack;
  };

  return {
    int2Stack,
    route: (tool) => {
      const name = aliases.get(tool) ?? tool;
      return tools.get(name) === undefined ? undefined : name;
    },
    toolNames: () => [...tools.tools.keys()].sort(),
    async close() {
      for (const db of dbs) db.close();
      await connectors.close();
      driver.dispose();
      desktop.disconnect();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
