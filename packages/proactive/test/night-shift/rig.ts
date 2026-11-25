import {
  getNight,
  getNightByDate,
  getStagedAction,
  insertNight,
  insertStagedAction,
  listNights,
  listStagedActions,
  openDb,
  updateNight,
  updateStagedAction,
} from "@psyche/db";
import type { StagedCall as LoopStagedCall } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import {
  type CandidateSource,
  createAdapters,
  createStager,
  type GateState,
  type NightJobInput,
  type NightNotice,
  NightShiftService,
  type NightShiftSettings,
  type NightStore,
  readNightShiftSettings,
} from "../../src/index.ts";
import { FakeRegistry, thread } from "./adapters-registry.ts";

/** 2026-11-25 01:00 UTC: the start of the window (the owner's zone is UTC in these tests). */
export const NIGHT_START = Date.parse("2026-11-25T01:00:00Z");
export const HOUR = 3_600_000;

export const GOOD: GateState = {
  onAc: true,
  batteryPct: 100,
  lowPowerMode: false,
  thermal: "nominal",
  idleMinutes: 60,
};

/** A real in-memory SQLite database behind the same repo functions the Gateway uses. */
export function sqliteStore(clock: FakeClock): NightStore {
  let n = 0;
  const db = openDb(":memory:", {
    now: () => new Date(clock.now()).toISOString(),
    newId: () => `id_${++n}`,
  });
  return {
    getNight: (id) => getNight(db, id),
    getNightByDate: (d) => getNightByDate(db, d),
    insertNight: (i) => insertNight(db, i),
    updateNight: (id, p) => updateNight(db, id, p),
    listNights: (s) => listNights(db, s),
    insertStagedAction: (i) => insertStagedAction(db, i),
    getStagedAction: (id) => getStagedAction(db, id),
    listStagedActions: (id) => listStagedActions(db, id),
    updateStagedAction: (id, p) => updateStagedAction(db, id, p),
  };
}

export const mailCandidate = (key: string): CandidateSource => ({
  name: `mail-${key}`,
  domain: "mail",
  max: 8,
  list: () => [
    {
      id: `mail:google:${key}`,
      domain: "mail",
      kind: "quiet_thread",
      key,
      title: `Thread ${key}`,
      facts: { threadId: key },
      taintSources: [{ sourceKind: "email", origin: "google" }],
    },
  ],
});

/** The loop's staged call for a Gmail draft, as the gate would hand it to the sink. */
export function draftCall(nightId: string, params: Record<string, unknown>): LoopStagedCall {
  return {
    staging: { kind: "night", nightId },
    runId: "run_1",
    taskId: "task_1",
    toolCallId: "tc_1",
    tool: "mcp__google__gmail_create_draft",
    connector: { id: "google", action: "gmail.draft" },
    sideEffect: "write",
    kind: "connector_action",
    params,
    paramsHash: "sha256:p",
    bindingHash: "sha256:b",
    summary: "Draft a reply",
    decisionRule: "ask",
    taint: true,
    taintSources: [{ sourceKind: "email", origin: "google" }],
  };
}

export const goodDraft = {
  threadId: "t-1",
  to: ["ann@x.com"],
  subject: "Re: plan",
  body: "Sounds good",
};

export interface RigOptions {
  start?: number;
  settings?: Record<string, unknown>;
  sources?: CandidateSource[];
  state?: GateState;
}

/** The service on a fake clock, real SQLite, a fake registry, fake connectors and a scripted job. */
export function rig(o: RigOptions = {}) {
  const clock = new FakeClock(o.start ?? NIGHT_START);
  const store = sqliteStore(clock);
  const registry = new FakeRegistry();
  registry.threads.set("t-1", thread());
  const kv: Record<string, unknown> = { "nightShift.enabled": true, ...o.settings };
  const settings = (): NightShiftSettings => readNightShiftSettings({ get: (k) => kv[k] });
  const w = {
    state: o.state ?? GOOD,
    sources: o.sources ?? [],
    jobs: [] as NightJobInput[],
    notices: [] as NightNotice[],
    holds: 0,
    releases: 0,
    cancelled: [] as string[],
    sleeps: [] as number[],
    /** Runs inside each job: stage calls through the night's sink, meter usage, flip the state. */
    script: async (_input: NightJobInput, _taskId: string): Promise<void> => {},
    onSleep: () => {},
  };
  let taskNo = 0;
  const service: NightShiftService = new NightShiftService({
    clock,
    timezone: () => "UTC",
    settings,
    store,
    sources: () => w.sources,
    readState: async () => w.state,
    runJob: async (input) => {
      w.jobs.push(input);
      const taskId = `task_${++taskNo}`;
      input.onCreated(taskId);
      await w.script(input, taskId);
      return { taskId, status: "done" };
    },
    cancelTask: async (id) => void w.cancelled.push(id),
    threadId: async () => "thread_main",
    stagerFor: (nightId, whyFor) =>
      createStager({
        nightId,
        store,
        adapters: () =>
          createAdapters(registry, { grants: () => [] }, new Map([["google", "google"]])),
        connectors: () => new Map([["google", "google"]]),
        domains: () => new Set(["mail", "calendar", "reminders", "files"]),
        whyFor,
      }),
    keepAwake: {
      acquire: () => {
        w.holds += 1;
        return () => {
          w.releases += 1;
        };
      },
    },
    notify: (n) => void w.notices.push(n),
    pollMs: 5 * 60_000,
    sleep: async (ms) => {
      w.sleeps.push(ms);
      w.onSleep();
      clock.advance(ms);
    },
  });
  return { clock, store, registry, kv, service, w, taskNo: () => taskNo };
}
