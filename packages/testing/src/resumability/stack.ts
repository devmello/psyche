// The real stack for crash tests: SqliteTaskEngine + TaskWorkerPool + the agent-core loop + the
// real PermissionBroker and receipts, all on one SQLite file. Imported by relative path on purpose:
// tasks, agent-core, permissions and audit list @psyche/testing as a devDependency, so declaring
// them in package.json would make a workspace cycle that `turbo run typecheck` rejects.
import type {
  Clock,
  IssuedApproval,
  ModelProvider,
  Receipt,
  ReceiptInput,
  ToolResult,
} from "@psyche/protocol";
import {
  type AgentToolRegistration,
  createAgentLoop,
  type PsycheAgentLoop,
  type ThreadStateStore,
  type ToolRunContext,
} from "../../../agent-core/src/index.ts";
import { Receipts, SqliteReceiptStore } from "../../../audit/src/index.ts";
import { createThread, openDb, type PsycheDb } from "../../../db/src/index.ts";
import {
  createPermissionBroker,
  type PolicyConfig,
  type PsychePermissionBroker,
  SqlitePermissionStore,
} from "../../../permissions/src/index.ts";
import { SqliteTaskEngine, TaskWorkerPool, type Timers } from "../../../tasks/src/index.ts";
import type { FakeClock } from "../clock.ts";

export type { PolicyConfig, ToolRunContext };

/** Thrown by every durable call a killed process makes: a dead Gateway writes nothing. */
export class ProcessKilled extends Error {
  constructor() {
    super("the process was killed");
    this.name = "ProcessKilled";
  }
}

/** One Gateway process. `alive = false` is SIGKILL: its timers stop and its writes throw. */
export interface Generation {
  index: number;
  alive: boolean;
  db: PsycheDb;
  engine: SqliteTaskEngine;
  broker: PsychePermissionBroker;
  loop: PsycheAgentLoop;
  pool: TaskWorkerPool;
}

export interface BootOptions {
  file: string;
  index: number;
  clock: FakeClock;
  /** The durable transcript store (the Gateway's `messages`), shared by every generation. */
  threads: ThreadStateStore;
  threadId: string;
  leaseMs: number;
  policy?: PolicyConfig;
  provider: (gen: Generation) => ModelProvider;
  tools: {
    name: string;
    spec: AgentToolRegistration["spec"];
    describe?: AgentToolRegistration["describeCall"];
    run: (gen: Generation, params: unknown, ctx: ToolRunContext) => Promise<ToolResult>;
  }[];
  onIssued: (gen: Generation, issued: IssuedApproval) => void;
  recordReceipt: (
    gen: Generation,
    real: (input: ReceiptInput) => Promise<Receipt>,
    input: ReceiptInput,
  ) => Promise<Receipt>;
  isReplaySafe?: (tool: string) => boolean;
}

/** Every method call goes through `overrides` first and throws once the process is dead. */
function frozen<T extends object>(target: T, gen: { alive: boolean }, overrides: object = {}): T {
  return new Proxy(target, {
    get(t, prop) {
      const own = prop in overrides;
      const value: unknown = own ? Reflect.get(overrides, prop) : Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (!gen.alive) throw new ProcessKilled();
        return (value as (...a: unknown[]) => unknown).apply(own ? overrides : t, args);
      };
    },
  });
}

/** Boots generation `index` on the shared database file (generation 0 also creates the thread). */
export function bootGeneration(o: BootOptions): Generation {
  const gen = { index: o.index, alive: true } as Generation;
  let n = 0;
  const id = (prefix = "id") => `${prefix}_g${o.index}_${String(++n).padStart(4, "0")}`;
  const clock: Clock & { setTimer: FakeClock["setTimer"] } = {
    now: () => o.clock.now(),
    setTimer: (at, fn) => o.clock.setTimer(at, () => gen.alive && fn()),
  };
  const timers: Timers = {
    setTimeout: (fn, ms) => clock.setTimer(clock.now() + ms, fn),
    clearTimeout: (h) => (h as (() => void) | undefined)?.(),
  };
  gen.db = openDb(o.file, {
    now: () => new Date(o.clock.now()).toISOString(),
    newId: () => id("db"),
  });
  if (o.index === 0) {
    createThread(gen.db, { id: o.threadId, kind: "main", sessionKey: `main:${o.threadId}` });
  }
  const real = createPermissionBroker({
    approvers: {
      device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
      isOwnerSender: async () => false,
    },
    clock,
    store: new SqlitePermissionStore(gen.db.sqlite),
    receipts: new Receipts({
      clock,
      store: new SqliteReceiptStore(gen.db.sqlite),
      newId: () => id("rcp"),
    }),
    armDelayMs: 0,
    newId: (prefix) => id(prefix),
    ...(o.policy === undefined ? {} : { policy: o.policy }),
  });
  gen.broker = frozen(real, gen, {
    requestApproval: async (input: Parameters<PsychePermissionBroker["requestApproval"]>[0]) => {
      const issued = await real.requestApproval(input);
      o.onIssued(gen, issued);
      return issued;
    },
    recordReceipt: (input: ReceiptInput) =>
      o.recordReceipt(gen, (i) => real.recordReceipt(i), input),
  });
  gen.engine = frozen(new SqliteTaskEngine({ db: gen.db, clock, newId: () => id("t") }), gen);
  gen.loop = createAgentLoop({
    provider: frozen(o.provider(gen), gen),
    model: "fake/main",
    broker: gen.broker,
    state: frozen(o.threads, gen),
    clock,
    ids: { next: id },
    builtins: false,
  });
  for (const t of o.tools) {
    gen.loop.registry.register({
      spec: t.spec,
      ...(t.describe === undefined ? {} : { describeCall: t.describe }),
      run: (params, ctx) => t.run(gen, params, ctx),
      execute: () => Promise.reject(new Error(`${t.name} runs in-process`)),
    });
  }
  gen.pool = new TaskWorkerPool({
    engine: gen.engine,
    loop: gen.loop,
    clock,
    timers,
    owner: `gw${o.index}`,
    leaseMs: o.leaseMs,
    broker: gen.broker,
    ...(o.isReplaySafe === undefined
      ? { tools: gen.loop.registry }
      : { isReplaySafe: o.isReplaySafe }),
    newRunId: () => id("run"),
  });
  return gen;
}
