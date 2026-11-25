import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { setSetting, updateDevice } from "@psyche/db";
import type { ModelEvent, NodeClient, NodeInvokeResult, PointsDigest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_APPS } from "../src/compose/computer-settings.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import {
  assertPointsCaller,
  composePoints,
  POINTS_ENABLED,
  POINTS_OFFER_FALLBACK,
  pointsNode,
  pointsStartRefusal,
} from "../src/compose/points.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import type { Logger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import {
  adminClient,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  TestClient,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Psyche points, the Gateway wiring (docs/design/psyche-points-2026.md W7): only the Host's own
 * desktop shell on loopback; the helper behind an allowlist; the §2.2 refusals; one session at a
 * time; events to the starting device only; audit rows with counts; model calls counted; and
 * nothing of the form kept anywhere (§5.3).
 */

const SECRET = "1428 Elm Street";
const WINDOW_TITLE = "Mailing address form";
const LABELS = ["Street address", "Social Security number", "City"];

const STRINGS = {
  back: "Back",
  skip: "Skip",
  next: "Next",
  looksWrong: "Looks wrong?",
  stuck: "Stuck?",
  stuckMissing: "I don't have this",
  stuckUnclear: "I don't get this field",
  stuckBlocked: "The form won't go on",
  askInPsyche: "Ask in Psyche",
  letLook: "Let Psyche look",
  stop: "Stop",
  hideNote: "Hide note",
  copy: "Copy",
  selfFill: "You fill this yourself: {label}",
  selfFillPlain: "You fill this yourself",
  payButton: "This button pays. Check the amount, then decide yourself.",
  unknownValue: "Psyche doesn't know this one.",
  scrollTo: "Scroll down to {label}",
  menuBarTitle: "Pointing: {app}",
  stepFormat: "{n}/{total}",
  visionBadge: "Looking",
  followWindow: "Follow to the new window?",
};

const digest = (fingerprint = "fp1", extra: Partial<PointsDigest> = {}): PointsDigest => ({
  app: { bundleId: "com.apple.Safari", name: "Safari" },
  windowTitle: WINDOW_TITLE,
  host: "forms.example.org",
  path: "/address",
  headings: ["Mailing address"],
  instructions: "Fill in your mailing address.",
  fingerprint,
  tree: "ok",
  fields: [
    { fieldId: "f1", role: "text", label: LABELS[0] as string, path: [], state: "empty" },
    {
      fieldId: "f2",
      role: "text",
      label: LABELS[1] as string,
      path: [],
      state: "empty",
      sensitive: "identity",
    },
    { fieldId: "f3", role: "text", label: LABELS[2] as string, path: [], state: "empty" },
  ],
  ...extra,
});

const PLAN = {
  page: { title: "Address", summary: "Your mailing address" },
  steps: [
    {
      fieldId: "f1",
      kind: "fill",
      note: "Your street and number",
      value: SECRET,
      sources: ["goal"],
      derivation: "exact",
    },
    { fieldId: "f2", kind: "self", note: "Type it in", value: "123-45-6789" },
    { fieldId: "f3", kind: "fill", note: "Your city" },
  ],
  done_when: "submit",
};

const reply = (plan: unknown = PLAN): ModelEvent[] => [
  { type: "text_delta", text: JSON.stringify(plan) },
  {
    type: "usage",
    usage: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

interface Rig {
  windows: unknown[];
  emit?: (data: unknown) => void;
  finish?: (v: unknown) => void;
  shows: { kind: string; note: string; value?: string; target: { fieldId?: string } }[];
  ended: unknown[];
}

const rig: Rig = { windows: [], shows: [], ended: [] };

const win = (pid: number, bundleId: string, name: string, title = WINDOW_TITLE) => ({
  pid,
  windowIndex: 0,
  app: { bundleId, name },
  title,
  frontmost: true,
});

const HELPER: FakeNodeHandler[] = [
  {
    capability: { name: "points.windows", sideEffect: "read" },
    run: () => ({ windows: rig.windows }),
  },
  {
    capability: { name: "points.session", sideEffect: "read", streaming: true },
    run: (_p, emit) =>
      new Promise((resolve) => {
        rig.emit = emit;
        rig.finish = resolve;
      }),
  },
  {
    capability: { name: "points.show", sideEffect: "none" },
    run: (p) => {
      rig.shows.push(p as Rig["shows"][number]);
      return { shown: true };
    },
  },
  { capability: { name: "points.look", sideEffect: "read" }, run: () => "should never run" },
  {
    capability: { name: "points.end", sideEffect: "none" },
    run: (p) => {
      rig.ended.push(p);
      return {};
    },
  },
];

let composed: ComposedGateway | null = null;
let home = "";
let helper: FakeNode | null = null;
let model: FakeModelProvider;
const clients: TestClient[] = [];
const logLines: string[] = [];
const logger: Logger = {
  log: (level, msg, fields) => void logLines.push(JSON.stringify({ level, msg, fields })),
};

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await helper?.close().catch(() => undefined);
  helper = null;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  logLines.length = 0;
});

async function setup(
  opts: {
    on?: boolean;
    helper?: boolean;
    script?: ModelEvent[][];
    idleMs?: number;
    modelBudget?: { burstCalls: number };
  } = {},
) {
  rig.windows = [win(101, "com.apple.Safari", "Safari")];
  rig.shows = [];
  rig.ended = [];
  rig.emit = undefined;
  rig.finish = undefined;
  home = mkdtempSync(join(tmpdir(), "psyche-points-"));
  model = new FakeModelProvider().script(opts.script ?? [reply(), reply()]);
  composed = await composeGateway({
    env: {},
    logger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
    points: {
      ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
      memoryLines: () => [],
    },
    ...(opts.modelBudget === undefined
      ? {}
      : {
          limits: {
            modelBudget: {
              burstCalls: opts.modelBudget.burstCalls,
              burstWindowMs: 60_000,
              hourlyCalls: 240,
              hourlyWindowMs: 3_600_000,
            },
          },
        }),
  });
  const c = composed;
  if (opts.on !== false) setSetting(c.db, POINTS_ENABLED, true);
  if (opts.helper !== false)
    helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
      origin: c.gateway.origin,
      secret: c.gateway.handshakeSecret,
      handlers: HELPER,
    });
  const desk = await adminClient(c.gateway);
  clients.push(desk);
  return { c, desk };
}

/** A paired device with every scope that is not the desktop shell (no handshake secret). */
async function adminDevice(c: ComposedGateway, platform: "ios" | "macos"): Promise<TestClient> {
  const key = newDeviceKey();
  const deviceId = `dev-${Math.random().toString(36).slice(2)}`;
  const first = await desktopClient(c.gateway, key, deviceId, platform);
  first.close();
  updateDevice(c.gateway.context.db, deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const again = await TestClient.open(wsUrlOf(c.gateway));
  await handshake(again, c.gateway.origin, { key, deviceId, platform });
  clients.push(again);
  return again;
}

const startParams = (extra: Record<string, unknown> = {}) => ({
  window: "101:0",
  goal: `I live at ${SECRET}`,
  goalSource: "owner",
  entry: "palette",
  locale: "en",
  strings: STRINGS,
  ...extra,
});

/** Starts a session and feeds it the first page; resolves once the first arrow was drawn. */
async function begin(desk: TestClient, extra: Record<string, unknown> = {}, fp = "fp1") {
  const started = desk.call<{ sessionId: string; app: { bundleId: string } }>(
    "points.start",
    startParams(extra),
    ik(),
  );
  await vi.waitFor(() => expect(rig.emit).toBeDefined());
  rig.emit?.({ type: "digest", digest: digest(fp) });
  const s = await started;
  await vi.waitFor(() => expect(rig.shows.length).toBeGreaterThan(0));
  return s;
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error("expected the call to fail");
}

const METHODS: [string, unknown][] = [
  ["points.windows", {}],
  ["points.start", startParams()],
  ["points.stop", { sessionId: "x" }],
  ["points.status", {}],
  ["points.ask", { sessionId: "x", text: "what is this?" }],
];

const pointsCalls = () =>
  (helper?.invocations ?? []).filter((i) => i.capability.startsWith("points."));

describe("who can use Psyche points", () => {
  it("only the Host's desktop shell: a phone and a remote Mac are refused on every method", async () => {
    const { c, desk } = await setup();
    for (const platform of ["ios", "macos"] as const) {
      const other = await adminDevice(c, platform);
      for (const [method, params] of METHODS)
        expect(await failure(other.call(method, params, ik())), `${platform} ${method}`).toContain(
          "forbidden",
        );
    }
    expect(pointsCalls()).toEqual([]);
    // Control: the desktop shell reaches the helper.
    const { windows } = await desk.call<{ windows: { ref: string }[] }>("points.windows", {});
    expect(windows.map((w) => w.ref)).toEqual(["101:0"]);
    expect(pointsCalls().length).toBe(1);
  });

  it("a connection that is not loopback is refused even for the desktop shell", () => {
    const call = (shell: boolean, loopback: boolean) => ({
      identity: { desktopShell: shell },
      conn: { peer: { remoteLoopback: loopback } },
    });
    expect(() => assertPointsCaller(call(true, false))).toThrow(/only for the Psyche desktop/);
    expect(() => assertPointsCaller(call(false, true))).toThrow(/only for the Psyche desktop/);
    expect(() => assertPointsCaller(call(true, true))).not.toThrow();
  });

  it("is off until the owner turns it on, and needs the Host's Mac helper", async () => {
    const off = await setup({ on: false });
    expect(await failure(off.desk.call("points.windows", {}))).toContain("policy_denied");
    setSetting(off.c.db, POINTS_ENABLED, true);
    await helper?.close();
    helper = null;
    await vi.waitFor(async () =>
      expect(await failure(off.desk.call("points.windows", {}))).toContain("unavailable"),
    );
  });
});

describe("the helper behind an allowlist", () => {
  const spy = () => {
    const seen: string[] = [];
    const client = {
      nodeId: "n",
      info: async () => ({}),
      capabilities: async () => [],
      invoke: async (capability: string): Promise<NodeInvokeResult> => {
        seen.push(capability);
        return { ok: true, result: {} };
      },
    } as unknown as NodeClient;
    return { seen, node: pointsNode(client) };
  };

  it.each([
    "computer.click",
    "computer.key",
    "computer.type",
    "apps.applescript",
    "screen.context",
    "dictation.insert",
    "teach.record.start",
    "vault.unlock",
    "points.click",
    "points.type",
    "points.",
    "points",
    "POINTS.show",
    "points.show ",
    "points:show",
    "points.windows.extra",
    "",
  ])("refuses %j without reaching the node", async (name) => {
    const { seen, node } = spy();
    const r = await node.invoke(name as never, {});
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(seen).toEqual([]);
  });

  it("positive control: the five points.* capabilities pass, with their own parameters only", async () => {
    const { seen, node } = spy();
    const ok = [
      ["points.windows", {}],
      ["points.session", { window: "1:0", strings: STRINGS }],
      [
        "points.show",
        {
          sessionId: "s",
          target: { fieldId: "f1" },
          kind: "fill",
          note: "x",
          step: { n: 1, of: 2 },
        },
      ],
      ["points.look", { sessionId: "s", actionId: "a" }],
      ["points.end", { sessionId: "s" }],
    ] as const;
    for (const [name, params] of ok)
      expect(await node.invoke(name, params)).toMatchObject({ ok: true });
    expect(seen).toEqual(ok.map(([n]) => n));
    // A shape with a click in it is not a points.show.
    const bad = await node.invoke("points.show", {
      sessionId: "s",
      target: { fieldId: "f1" },
      kind: "fill",
      note: "x",
      step: { n: 1, of: 2 },
      click: { x: 1, y: 2 },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(seen.length).toBe(5);
  });
});

describe("§2.2 refusals", () => {
  const OWNER_OFF = [{ id: "com.example.Offapp", name: "Off", tier: "off" }];
  it.each([
    ["com.psyche.desktop", "never_app"],
    ["com.apple.systempreferences", "never_app"],
    ["com.1password.1password", "never_app"],
    ["com.apple.Terminal", "terminal_or_ide"],
    ["com.microsoft.VSCode", "terminal_or_ide"],
    ["com.example.Offapp", "owner_off"],
    ["COM.EXAMPLE.OFFAPP", "owner_off"],
  ])("%s is refused: %s", (id, why) => {
    expect(pointsStartRefusal(id, OWNER_OFF)).toBe(why);
  });

  it.each([
    "com.apple.Safari",
    "com.google.Chrome",
    "org.mozilla.firefox",
    "com.apple.Preview",
    "com.apple.Notes",
    "com.example.Offapp2",
  ])("%s is allowed (near-miss control)", (id) => {
    expect(pointsStartRefusal(id, OWNER_OFF)).toBeUndefined();
  });

  it("a refused window never starts a session and never reaches the helper's session", async () => {
    const { c, desk } = await setup();
    setSetting(c.db, COMPUTER_USE_APPS, [{ id: "com.example.Offapp", name: "Off", tier: "off" }]);
    rig.windows = [
      win(1, "com.apple.Terminal", "Terminal"),
      win(2, "com.psyche.desktop", "Psyche"),
      win(3, "com.example.Offapp", "Off"),
      win(4, "com.apple.Safari", "Safari"),
    ];
    const { windows } = await desk.call<{ windows: { ref: string; refusal?: string }[] }>(
      "points.windows",
      {},
    );
    expect(windows.map((w) => w.refusal)).toEqual([
      "terminal_or_ide",
      "never_app",
      "owner_off",
      undefined,
    ]);
    for (const pid of [1, 2, 3])
      expect(
        await failure(desk.call("points.start", startParams({ window: `${pid}:0` }), ik())),
      ).toContain("policy_denied");
    expect(
      await failure(desk.call("points.start", startParams({ window: "9:9" }), ik())),
    ).toContain("not_found");
    expect(pointsCalls().filter((i) => i.capability === "points.session")).toEqual([]);
  });
});

describe("one session at a time", () => {
  it("draws the plan, moves on by itself, sends events to the starting device only, and ends cleanly", async () => {
    const { c, desk } = await setup();
    const bystander = await adminClient(c.gateway);
    clients.push(bystander);
    const s = await begin(desk);
    expect(s.app.bundleId).toBe("com.apple.Safari");
    // The first arrow: the street, with a value grounded in the owner's goal.
    expect(rig.shows[0]).toMatchObject({
      kind: "fill",
      target: { fieldId: "f1" },
      value: SECRET,
    });
    // A second start is refused while one is running.
    expect(await failure(desk.call("points.start", startParams(), ik()))).toContain("conflict");
    // Typing the street and leaving the field moves the arrow to the sensitive one.
    rig.emit?.({ type: "field", fieldId: "f1", state: "filled", value: SECRET });
    await vi.waitFor(() => expect(rig.shows.length).toBe(2));
    expect(rig.shows[1]).toMatchObject({ kind: "self", target: { fieldId: "f2" } });
    // No model value, no value at all, for the sensitive field; the fixed copy names its label.
    expect(rig.shows[1]?.value).toBeUndefined();
    expect(JSON.stringify(rig.shows[1])).not.toContain("123-45-6789");
    expect(rig.shows[1]?.note).toContain("You fill this yourself");
    rig.emit?.({ type: "field", fieldId: "f2", state: "filled" });
    await vi.waitFor(() => expect(rig.shows.length).toBe(3));
    expect(rig.shows[2]).toMatchObject({ kind: "fill", target: { fieldId: "f3" } });
    const status = await desk.call<{ session?: { step: number; of: number; state: string } }>(
      "points.status",
      {},
    );
    expect(status.session).toMatchObject({ step: 3, of: 3, state: "pointing" });
    // Events: only the device that started it.
    expect(desk.eventsNamed("points.updated").length).toBeGreaterThan(2);
    expect(bystander.eventsNamed("points.updated")).toEqual([]);
    expect(await desk.call("points.stop", { sessionId: s.sessionId }, ik())).toEqual({
      ended: true,
    });
    await vi.waitFor(() => expect(rig.ended).toEqual([{ sessionId: s.sessionId }]));
    expect(await desk.call("points.status", {})).toEqual({});
    expect(desk.eventsNamed("points.updated").at(-1)?.payload).toMatchObject({
      sessionId: s.sessionId,
      state: "ended",
      reason: "stop",
    });
    // A new session may start once the first has ended.
    rig.emit = undefined;
    const again = desk.call("points.start", startParams(), ik());
    await vi.waitFor(() => expect(rig.emit).toBeDefined());
    (rig as Rig).emit?.({ type: "digest", digest: digest("fp-again") });
    await again;
  });

  it("ends when the helper is lost, and when the session is idle", async () => {
    const lost = await setup();
    const s = await begin(lost.desk);
    await helper?.close();
    helper = null;
    await vi.waitFor(() =>
      expect(lost.desk.eventsNamed("points.updated").at(-1)?.payload).toMatchObject({
        sessionId: s.sessionId,
        state: "ended",
        reason: "helper_lost",
      }),
    );
    expect(await lost.desk.call("points.status", {})).toEqual({});
    for (const c of clients.splice(0)) c.close();
    await composed?.stop("test");
    composed = null;
    rmSync(home, { recursive: true, force: true });

    const idle = await setup({ idleMs: 250 });
    const s2 = await begin(idle.desk);
    await vi.waitFor(
      () =>
        expect(idle.desk.eventsNamed("points.updated").at(-1)?.payload).toMatchObject({
          sessionId: s2.sessionId,
          reason: "idle",
        }),
      { timeout: 3000 },
    );
  });

  it("the helper's own end event ends it with the helper's reason", async () => {
    const { desk } = await setup();
    const s = await begin(desk);
    rig.emit?.({ type: "ended", reason: "window_closed" });
    await vi.waitFor(() =>
      expect(desk.eventsNamed("points.updated").at(-1)?.payload).toMatchObject({
        sessionId: s.sessionId,
        reason: "window_closed",
      }),
    );
  });

  it("a session started from Chat leaves one counts-only note in that thread", async () => {
    const { desk } = await setup();
    const { thread } = await desk.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const s = await begin(desk, { entry: "chat", threadId: thread.id });
    await desk.call("points.stop", { sessionId: s.sessionId }, ik());
    const { messages } = await desk.call<{ messages: { blocks: { md?: string }[] }[] }>(
      "chat.history",
      { threadId: thread.id },
    );
    const texts = messages.flatMap((m) => m.blocks.map((b) => b.md ?? ""));
    expect(texts).toContain("Pointed you through Safari: 1 page, 1 field.");
    for (const t of texts) {
      expect(t).not.toContain(SECRET);
      for (const l of LABELS) expect(t).not.toContain(l);
    }
  });
});

describe("model calls", () => {
  it("each plan call is counted in usage and held to the device's model budget", async () => {
    const { c, desk } = await setup({ modelBudget: { burstCalls: 1 } });
    await begin(desk);
    const rows = () =>
      c.db.sqlite
        .prepare("SELECT job, model_ref AS m, input, output FROM usage WHERE job = 'points.plan'")
        .all() as { job: string; m: string; input: number; output: number }[];
    expect(model.requests.length).toBe(1);
    expect(rows()).toEqual([{ job: "points.plan", m: "fake/model", input: 120, output: 40 }]);
    // A second page needs a second call, and the device's burst budget is spent: no call is made.
    rig.emit?.({ type: "digest", digest: digest("fp2") });
    await vi.waitFor(() =>
      expect(
        desk.eventsNamed("points.updated").some((e) => (e.payload as { page?: number }).page === 2),
      ).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(model.requests.length).toBe(1);
    expect(rows().length).toBe(1);
  });

  it("the plan request has no tools, and a second page costs one more call (control)", async () => {
    const { c, desk } = await setup();
    await begin(desk);
    rig.emit?.({ type: "digest", digest: digest("fp2") });
    await vi.waitFor(() => expect(model.requests.length).toBe(2));
    for (const r of model.requests) {
      expect(r.tools).toBeUndefined();
      expect(r.toolChoice).toBeUndefined();
    }
    await vi.waitFor(() =>
      expect(
        (
          c.db.sqlite
            .prepare("SELECT count(*) AS n FROM usage WHERE job = 'points.plan'")
            .get() as {
            n: number;
          }
        ).n,
      ).toBe(2),
    );
    // Seeing the first page again reuses its plan: no call.
    rig.emit?.({ type: "digest", digest: digest("fp1") });
    await new Promise((r) => setTimeout(r, 100));
    expect(model.requests.length).toBe(2);
  });

  it("Ask in Psyche answers with one model call that is counted", async () => {
    const { c, desk } = await setup({
      script: [
        reply(),
        [
          { type: "text_delta", text: "It is where your street goes." },
          {
            type: "usage",
            usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
          },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const s = await begin(desk);
    const { answer } = await desk.call<{ answer: string }>(
      "points.ask",
      {
        sessionId: s.sessionId,
        text: "What goes in the first box?",
      },
      ik(),
    );
    expect(answer).toBe("It is where your street goes.");
    expect(model.requests.length).toBe(2);
    expect(model.requests[1]?.tools).toBeUndefined();
    expect(
      (
        c.db.sqlite.prepare("SELECT count(*) AS n FROM usage WHERE job = 'points.plan'").get() as {
          n: number;
        }
      ).n,
    ).toBe(2);
  });
});

// ---- §5.3: nothing is kept ----

/** Every string in every table, with blobs also read as gzip; and every file under the home. */
function findIn(c: ComposedGateway, root: string, needle: string): string[] {
  const hits: string[] = [];
  const see = (where: string, v: unknown) => {
    if (typeof v === "string" && v.includes(needle)) hits.push(where);
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      const b = Buffer.from(v);
      if (b.includes(needle)) hits.push(`${where} (blob)`);
      try {
        if (gunzipSync(b).includes(needle)) hits.push(`${where} (gzip)`);
      } catch {
        // not gzip
      }
    }
  };
  const tables = c.db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    try {
      for (const row of c.db.sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<
        string,
        unknown
      >[])
        for (const [col, v] of Object.entries(row)) see(`${name}.${col}`, v);
    } catch {
      // a virtual table that cannot be read whole
    }
  }
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size < 50_000_000) {
        try {
          const b = readFileSync(p);
          if (b.includes(needle)) hits.push(`file ${p.slice(root.length)}`);
        } catch {
          // unreadable
        }
      }
    }
  };
  walk(root);
  return hits;
}

describe("§5.3 nothing is kept", () => {
  it("the scanner finds a planted value in a table, in gzip and in a file (positive control)", async () => {
    const { c } = await setup();
    c.db.sqlite.exec("CREATE TABLE scan_control (a TEXT, b BLOB)");
    c.db.sqlite
      .prepare("INSERT INTO scan_control VALUES (?, ?)")
      .run(`plain ${SECRET}`, gzipSync(Buffer.from(`zipped ${SECRET}`)));
    const hits = findIn(c, home, SECRET);
    expect(hits).toEqual(expect.arrayContaining(["scan_control.a", "scan_control.b (gzip)"]));
    c.db.sqlite.exec("DROP TABLE scan_control");
  });

  it("a whole session plants the street and leaves it nowhere: tables, gzip step payloads, files, logs", async () => {
    const { c, desk } = await setup();
    const { thread } = await desk.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const s = await begin(desk, { entry: "chat", threadId: thread.id });
    // The street was typed, the sensitive field filled, the owner asked about the form.
    rig.emit?.({ type: "field", fieldId: "f1", state: "filled", value: SECRET });
    await vi.waitFor(() => expect(rig.shows.length).toBe(2));
    rig.emit?.({ type: "field", fieldId: "f2", state: "filled" });
    await vi.waitFor(() => expect(rig.shows.length).toBe(3));
    await desk.call("points.stop", { sessionId: s.sessionId }, ik());
    await vi.waitFor(() => expect(rig.ended.length).toBe(1));
    // Positive control: the model did receive the street (the goal) and the page's labels, and
    // the helper was told it (the first arrow), so a miss below is not a session that did nothing.
    const sent = JSON.stringify(model.requests);
    expect(sent).toContain(SECRET);
    for (const l of [LABELS[0], LABELS[2], WINDOW_TITLE]) expect(sent).toContain(l);
    expect(JSON.stringify(rig.shows)).toContain(SECRET);
    // And now nowhere in the Gateway.
    expect(findIn(c, home, SECRET)).toEqual([]);
    expect(logLines.join("\n")).not.toContain("Elm");
    for (const needle of [...LABELS, WINDOW_TITLE, "forms.example.org"])
      expect(findIn(c, home, needle), needle).toEqual([]);
    expect(logLines.join("\n")).not.toContain(WINDOW_TITLE);
  });

  it("audit rows carry the bundle id and counts, never a label, a title or a value", async () => {
    const { desk } = await setup();
    const s = await begin(desk);
    rig.emit?.({ type: "field", fieldId: "f1", state: "filled", value: SECRET });
    await vi.waitFor(() => expect(rig.shows.length).toBe(2));
    await desk.call("points.stop", { sessionId: s.sessionId }, ik());
    let entries: { kind: string; data: Record<string, unknown> }[] = [];
    await vi.waitFor(async () => {
      ({ entries } = await desk.call<{ entries: typeof entries }>("audit.list", {
        kindPrefix: "points.",
      }));
      expect(entries.map((e) => e.kind)).toEqual(
        expect.arrayContaining(["points.started", "points.ended"]),
      );
    });
    const text = JSON.stringify(entries);
    for (const bad of [...LABELS, WINDOW_TITLE, SECRET, "forms.example.org", "Mailing address"])
      expect(text, bad).not.toContain(bad);
    expect(entries.find((e) => e.kind === "points.started")?.data).toMatchObject({
      bundleId: "com.apple.Safari",
      entry: "palette",
    });
    expect(entries.find((e) => e.kind === "points.ended")?.data).toMatchObject({
      reason: "stop",
      pages: 1,
      steps: 2,
      modelCalls: 1,
      sensitiveFields: 1,
    });
  });
});

describe("points.offer", () => {
  const fake = (enabled: boolean, mac: boolean) => {
    const regs = new Map<string, { run: (p: unknown, c: unknown) => Promise<unknown> }>();
    const db = composed?.db;
    if (db === undefined) throw new Error("no db");
    setSetting(db, POINTS_ENABLED, enabled);
    const services = {
      db,
      home,
      tools: {
        register: (r: { spec: { name: string }; run: never }) => {
          regs.set(r.spec.name, r as never);
          return () => regs.delete(r.spec.name);
        },
      },
    } as unknown as ComposeServices;
    const part = composePoints({ provider: model, model: "fake/model" })(services);
    part.start?.({
      context: {
        nodes: {
          hostHelper: () => (mac ? { info: { kind: "mac-helper" }, client: {} } : undefined),
        },
        deviceDisconnected: new Set(),
      },
      bus: { publishToDevice() {} },
    } as never);
    return regs.get("points.offer");
  };
  const ctx = (blocks: unknown[]) => ({ turn: { emitBlock: (b: unknown) => blocks.push(b) } });

  it("renders a points_offer part on a Mac Host with Points on, and starts nothing", async () => {
    await setup({ helper: false });
    const blocks: unknown[] = [];
    const out = (await fake(true, true)?.run({ goal: "2026 tax return" }, ctx(blocks))) as {
      output: { status: string };
    };
    expect(out.output.status).toBe("offered");
    expect(blocks).toEqual([{ type: "points_offer", goal: "2026 tax return" }]);
    expect(pointsCalls()).toEqual([]);
  });

  it("says where to start it when Points is off or there is no Mac helper", async () => {
    await setup({ helper: false });
    for (const [on, mac] of [
      [false, true],
      [true, false],
    ] as const) {
      const blocks: unknown[] = [];
      const out = (await fake(on, mac)?.run({ goal: "visa" }, ctx(blocks))) as {
        output: { text: string };
      };
      expect(out.output.text).toBe(POINTS_OFFER_FALLBACK);
      expect(blocks).toEqual([]);
    }
  });
});
