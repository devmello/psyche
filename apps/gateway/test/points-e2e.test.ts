import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { getSetting, setSetting, updateDevice } from "@psyche/db";
import type { ModelEvent, PointsDigest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { assertPointsCaller, POINTS_ENABLED } from "../src/compose/points.ts";
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
 * Psyche points, end to end (docs/design/psyche-points-2026.md W9): the composed Gateway on a
 * temporary home, a FAKE helper node that serves the `points.*` capabilities and replays a recorded
 * two-page form, `points.start` -> W7 (compose/points.ts) -> W6 (points-plan / points-steps) with
 * `FakeModelProvider`. The real helper and real apps are never involved.
 */

const STREET = "1428 Elm Street";
// A secret-shaped value the (fake) helper's judge missed, in a field with a plain label: it must never go anywhere.
const SSN_VALUE = ["987", "65", "4321"].join("-");
const CARD_VALUE = ["4242", "4242", "4242", "4242"].join(" ");
const TITLE_1 = "Visa application, page 1";
const TITLE_2 = "Visa application, page 2";
const HOST = "forms.example.org";

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

const base = {
  app: { bundleId: "com.apple.Safari", name: "Safari" },
  host: HOST,
  tree: "ok" as const,
};

/** Page 1: a street, an identity field (no value, by contract), a city, a missed secret. */
const page1 = (): PointsDigest => ({
  ...base,
  windowTitle: TITLE_1,
  path: "/apply/address",
  headings: ["Your address"],
  instructions: "Fill in your address.",
  fingerprint: "page-1",
  fields: [
    { fieldId: "f1", role: "text", label: "Street address", path: [], state: "empty" },
    {
      fieldId: "f2",
      role: "text",
      label: "Social Security number",
      path: [],
      state: "filled",
      sensitive: "identity",
    },
    { fieldId: "f3", role: "text", label: "City", path: [], state: "empty" },
    // The helper's judge missed this one (a plain label): the Gateway's value-shape judge catches it.
    {
      fieldId: "f4",
      role: "text",
      label: "Reference",
      path: [],
      state: "filled",
      value: SSN_VALUE,
    },
  ],
});

/** Page 2: a card field and a button that pays. */
const page2 = (): PointsDigest => ({
  ...base,
  windowTitle: TITLE_2,
  path: "/apply/fee",
  headings: ["Application fee"],
  instructions: "Pay the fee.",
  fingerprint: "page-2",
  fields: [
    {
      fieldId: "f11",
      role: "text",
      label: "Card number",
      path: [],
      state: "empty",
      sensitive: "payment",
    },
    { fieldId: "f12", role: "button", label: "Pay $160.00", path: [], state: "empty" },
    {
      fieldId: "f13",
      role: "text",
      label: "Reference",
      path: [],
      state: "filled",
      value: CARD_VALUE,
    },
  ],
});

const PLAN_1 = {
  page: { title: "Address", summary: "Your address" },
  steps: [
    {
      fieldId: "f1",
      kind: "fill",
      note: "Your street and number",
      value: STREET,
      sources: ["goal"],
      derivation: "exact",
    },
    // A model that tries to give a value for the identity field: it is dropped.
    { fieldId: "f2", kind: "self", note: "It is on your card", value: SSN_VALUE },
    { fieldId: "f3", kind: "fill", note: "Your city" },
  ],
  done_when: "submit",
};

const PLAN_2 = {
  page: { title: "Fee", summary: "Pay the fee" },
  steps: [
    // A model note on a payment field is replaced by the fixed copy.
    { fieldId: "f11", kind: "self", note: `Use ${CARD_VALUE}`, value: CARD_VALUE },
    { fieldId: "f12", kind: "self", note: "Press Pay now" },
  ],
  done_when: "submit",
};

const reply = (plan: unknown, input: number): ModelEvent[] => [
  { type: "text_delta", text: JSON.stringify(plan) },
  {
    type: "usage",
    usage: { input, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

interface Rig {
  sessionId?: string | undefined;
  emit?: (data: unknown) => void;
  shows: { kind: string; note: string; value?: string; target: { fieldId?: string } }[];
}
const rig: Rig = { shows: [] };

const HELPER: FakeNodeHandler[] = [
  {
    capability: { name: "points.windows", sideEffect: "read" },
    run: () => ({
      windows: [{ pid: 101, windowIndex: 0, app: base.app, title: TITLE_1, frontmost: true }],
    }),
  },
  {
    capability: { name: "points.session", sideEffect: "read", streaming: true },
    run: (_p, emit, _a, invocationId) =>
      new Promise(() => {
        rig.sessionId = invocationId;
        rig.emit = emit;
      }),
    onCancel: (id) => {
      if (rig.sessionId === id) rig.sessionId = undefined;
    },
  },
  {
    capability: { name: "points.show", sideEffect: "none" },
    run: (p) => {
      rig.shows.push(p as Rig["shows"][number]);
      return { shown: true };
    },
  },
  { capability: { name: "points.look", sideEffect: "read" }, run: () => "should never run" },
  { capability: { name: "points.end", sideEffect: "none" }, run: () => ({}) },
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

async function setup(opts: { on?: boolean } = {}) {
  rig.shows = [];
  rig.emit = undefined;
  rig.sessionId = undefined;
  home = mkdtempSync(join(tmpdir(), "psyche-points-e2e-"));
  model = new FakeModelProvider().script([reply(PLAN_1, 900), reply(PLAN_2, 700)]);
  composed = await composeGateway({
    env: {},
    logger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: model, model: "fake/model" },
    points: { memoryLines: () => [] },
  });
  const c = composed;
  if (opts.on !== false) setSetting(c.db, POINTS_ENABLED, true);
  helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    handlers: HELPER,
  });
  const desk = await adminClient(c.gateway);
  clients.push(desk);
  return { c, desk };
}

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
  goal: `I live at ${STREET}`,
  goalSource: "owner",
  entry: "palette",
  locale: "en",
  strings: STRINGS,
  ...extra,
});

async function begin(desk: TestClient, extra: Record<string, unknown> = {}) {
  const started = desk.call<{ sessionId: string }>("points.start", startParams(extra), ik());
  await vi.waitFor(() => expect(rig.emit).toBeDefined());
  rig.emit?.({ type: "digest", digest: page1() });
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

/** Walks page 1 field by field, then shows page 2. */
async function walk(desk: TestClient) {
  const s = await begin(desk);
  rig.emit?.({ type: "field", fieldId: "f1", state: "filled", value: STREET });
  await vi.waitFor(() => expect(rig.shows.length).toBe(2));
  rig.emit?.({ type: "field", fieldId: "f2", state: "filled" });
  await vi.waitFor(() => expect(rig.shows.length).toBe(3));
  rig.emit?.({ type: "field", fieldId: "f3", state: "filled", value: "Springfield" });
  rig.emit?.({ type: "digest", digest: page2() });
  await vi.waitFor(() => expect(model.requests.length).toBe(2));
  await vi.waitFor(() => expect(rig.shows.some((x) => x.target.fieldId === "f11")).toBe(true));
  return s;
}

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
  const dir = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) dir(p);
      else if (e.isFile() && statSync(p).size < 50_000_000) {
        try {
          if (readFileSync(p).includes(needle)) hits.push(`file ${p.slice(root.length)}`);
        } catch {
          // unreadable
        }
      }
    }
  };
  dir(root);
  return hits;
}

describe("points e2e: the default", () => {
  it("points.enabled is off on a fresh home (the owner's pass comes first)", async () => {
    const { c } = await setup({ on: false });
    expect(getSetting(c.db, POINTS_ENABLED)).not.toBe(true);
  });
});

describe("points e2e: who may call", () => {
  it("a phone and a remote Mac are refused; the desktop shell passes (control)", async () => {
    const { c, desk } = await setup();
    for (const platform of ["ios", "macos"] as const) {
      const other = await adminDevice(c, platform);
      expect(await failure(other.call("points.windows", {})), platform).toContain("forbidden");
      expect(await failure(other.call("points.start", startParams(), ik())), platform).toContain(
        "forbidden",
      );
    }
    expect((helper?.invocations ?? []).filter((i) => i.capability.startsWith("points."))).toEqual(
      [],
    );
    const { windows } = await desk.call<{ windows: unknown[] }>("points.windows", {});
    expect(windows.length).toBe(1);
  });

  it("a non-loopback connection is refused even for the desktop shell (control: loopback passes)", () => {
    const call = (shell: boolean, loopback: boolean) => ({
      identity: { desktopShell: shell },
      conn: { peer: { remoteLoopback: loopback } },
    });
    expect(() => assertPointsCaller(call(true, false))).toThrow(/only for the Psyche desktop/);
    expect(() => assertPointsCaller(call(true, true))).not.toThrow();
  });
});

describe("points e2e: a two-page form", () => {
  it("steps reach the starting device only, with fixed copy for sensitive and payment fields", async () => {
    const { c, desk } = await setup();
    const bystander = await adminClient(c.gateway);
    clients.push(bystander);
    await walk(desk);
    expect(rig.shows[0]).toMatchObject({ kind: "fill", target: { fieldId: "f1" }, value: STREET });
    expect(rig.shows[1]).toMatchObject({ kind: "self", target: { fieldId: "f2" } });
    expect(rig.shows[1]?.value).toBeUndefined();
    expect(rig.shows[1]?.note).toContain("You fill this yourself");
    expect(JSON.stringify(rig.shows)).not.toContain(SSN_VALUE);
    const card = rig.shows.find((s) => s.target.fieldId === "f11");
    expect(card).toMatchObject({ kind: "self", note: "You fill this yourself" });
    expect(card?.value).toBeUndefined();
    expect(JSON.stringify(rig.shows)).not.toContain(CARD_VALUE);
    rig.emit?.({ type: "field", fieldId: "f11", state: "filled" });
    await vi.waitFor(() => expect(rig.shows.some((s) => s.target.fieldId === "f12")).toBe(true));
    const pay = rig.shows.find((s) => s.target.fieldId === "f12");
    expect(pay?.note).toBe(STRINGS.payButton);
    expect(pay?.note).not.toMatch(/press pay/i);
    expect(desk.eventsNamed("points.updated").length).toBeGreaterThan(2);
    expect(bystander.eventsNamed("points.updated")).toEqual([]);
  });

  it("no sensitive value reaches the model, and the scan finds nothing kept (with positive control)", async () => {
    const { c, desk } = await setup();
    const { thread } = await desk.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const started = desk.call<{ sessionId: string }>(
      "points.start",
      startParams({ entry: "chat", threadId: thread.id }),
      ik(),
    );
    await vi.waitFor(() => expect(rig.emit).toBeDefined());
    rig.emit?.({ type: "digest", digest: page1() });
    const s = await started;
    await vi.waitFor(() => expect(rig.shows.length).toBeGreaterThan(0));
    rig.emit?.({ type: "field", fieldId: "f1", state: "filled", value: STREET });
    rig.emit?.({ type: "digest", digest: page2() });
    await vi.waitFor(() => expect(model.requests.length).toBe(2));
    await desk.call("points.stop", { sessionId: s.sessionId }, ik());
    // Positive control: the model did see the goal's street and the plain labels.
    const sent = JSON.stringify(model.requests);
    expect(sent).toContain(STREET);
    for (const l of ["Street address", "City", TITLE_1]) expect(sent).toContain(l);
    // The sensitive and payment values were in the digests and are in no request.
    for (const v of [SSN_VALUE, CARD_VALUE]) expect(sent).not.toContain(v);
    // And nothing is kept: the sensitive values, the street, the labels, the host, the log.
    for (const needle of [SSN_VALUE, CARD_VALUE, STREET, "Social Security", "Card number", HOST])
      expect(findIn(c, home, needle), needle).toEqual([]);
    expect(logLines.join("\n")).not.toMatch(/Elm|Social Security|Card number|4242/);
    // Control, after the real scan (the WAL would keep the planted rows): the scanner finds a planted value.
    c.db.sqlite.exec("CREATE TABLE scan_control (a TEXT, b BLOB)");
    c.db.sqlite
      .prepare("INSERT INTO scan_control VALUES (?, ?)")
      .run(`plain ${SSN_VALUE}`, gzipSync(Buffer.from(`zipped ${SSN_VALUE}`)));
    expect(findIn(c, home, SSN_VALUE)).toEqual(
      expect.arrayContaining(["scan_control.a", "scan_control.b (gzip)"]),
    );
    c.db.sqlite.exec("DROP TABLE scan_control");
  });

  it("a page seen again makes no second model call, and the numbers match section 7", async () => {
    const { c, desk } = await setup();
    await walk(desk);
    expect(model.requests.length).toBe(2);
    // Back to page 1 and to page 2 again: both plans are reused.
    rig.emit?.({ type: "digest", digest: page1() });
    rig.emit?.({ type: "digest", digest: page2() });
    await new Promise((r) => setTimeout(r, 150));
    expect(model.requests.length).toBe(2);
    // Section 7: no tools, one call per new page, and each request within the 6k-token target.
    const approx = model.requests.map((r) => Math.ceil(JSON.stringify(r).length / 4));
    for (const r of model.requests) expect(r.tools).toBeUndefined();
    for (const t of approx) expect(t).toBeLessThan(6000);
    const n = (
      c.db.sqlite.prepare("SELECT count(*) AS n FROM usage WHERE job = 'points.plan'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(2);
    if (process.env.POINTS_E2E_NUMBERS === "1")
      process.stderr.write(
        `points-e2e numbers ${JSON.stringify({ calls: 2, pages: 2, approx })}\n`,
      );
  });

  it("losing the helper ends the session and leaves the closing note in the thread", async () => {
    const { desk } = await setup();
    const { thread } = await desk.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const s = await begin(desk, {
      entry: "chat",
      threadId: thread.id,
      closingNote: "Pointed you through {app}: {pages} pages, {fields} fields.",
    });
    await helper?.close();
    helper = null;
    await vi.waitFor(() =>
      expect(desk.eventsNamed("points.updated").at(-1)?.payload).toMatchObject({
        sessionId: s.sessionId,
        state: "ended",
        reason: "helper_lost",
      }),
    );
    expect(await desk.call("points.status", {})).toEqual({});
    await vi.waitFor(async () => {
      const { messages } = await desk.call<{ messages: { blocks: { md?: string }[] }[] }>(
        "chat.history",
        { threadId: thread.id },
      );
      const texts = messages.flatMap((m) => m.blocks.map((b) => b.md ?? ""));
      expect(texts).toContain("Pointed you through Safari: 1 pages, 1 fields.");
    });
  });
});
