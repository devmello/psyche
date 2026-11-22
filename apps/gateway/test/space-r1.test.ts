import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import type { PsycheDb } from "@psyche/db";
import type { AutomationRunRequest, RunLauncher } from "@psyche/scheduler";
import {
  createDbSessionResolver,
  createDeliverer,
  SPACE_MAIN_CHAT_REASON,
  SqliteScheduler,
} from "@psyche/scheduler";
import { FakeClock, FakeNotifier } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { freeTimeTool } from "../src/compose/connectors.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import {
  idsLine,
  runSpaceById,
  runSpaceFor,
  spaceContextProvider,
  spaceTurnSections,
  trackerThirdParty,
} from "../src/compose/space-context.ts";
import { shelveAgentWidget, spaceTools } from "../src/compose/space-tools.ts";
import { threadTools } from "../src/compose/thread-tools.ts";
import { spacesHandlers } from "../src/spaces/handlers.ts";
import { SpaceStore } from "../src/spaces/store.ts";
import { adminClient, ik, startTestGateway, type TestClient, type TestGateway } from "./helpers.ts";

/**
 * Spaces S3, security review r1 (PR #1488): the Gateway's side. Each finding's probe rows are
 * table rows: what must hold next to what must still work.
 */

let t: TestGateway | null = null;
let c: TestClient | null = null;

afterEach(async () => {
  c?.close();
  c = null;
  await t?.cleanup();
  t = null;
});

// biome-ignore lint/suspicious/noExplicitAny: loose JSON payloads read by the assertions
type Json = Record<string, any>;

async function start() {
  t = await startTestGateway({ handlers: { ...spacesHandlers() } });
  c = await adminClient(t.gateway);
  return { db: t.gateway.context.db as PsycheDb, c, gw: t.gateway };
}

const newSpace = async (c: TestClient, params: Json = {}) =>
  (await c.call<Json>("spaces.create", { name: "Kitchen remodel", ...params }, ik())).space;
const newChat = async (c: TestClient, spaceId?: string, title = "Tiles"): Promise<string> => {
  const r = await c.call<Json>("threads.create", { kind: "side", title }, ik());
  if (spaceId !== undefined) {
    await c.call("spaces.threads.move", { threadIds: [r.thread.id], spaceId }, ik());
  }
  return r.thread.id;
};

let seq = 0;
function widget(
  db: PsycheDb,
  threadId: string,
  opts: { title?: string; root?: Json; state?: "live" | "frozen"; id?: string } = {},
): string {
  seq += 1;
  const id = opts.id ?? `wdg_r1_${seq}`;
  const root = opts.root ?? { id: "s", type: "status", label: "x", tone: "neutral" };
  db.sqlite
    .prepare(
      `INSERT INTO widgets (id, thread_id, message_id, rev, spec, taint, owner, state, pinned, created_at, updated_at)
       VALUES (?, ?, 'msg_1', 1, ?, '[]', '{"kind":"run","runId":"run_1"}', ?, 0, ?, ?)`,
    )
    .run(
      id,
      threadId,
      JSON.stringify({ v: 1, title: opts.title ?? "W", fallbackText: "ok", root }),
      opts.state ?? "live",
      db.now(),
      db.now(),
    );
  return id;
}
const shelve = (db: PsycheDb, spaceId: string, widgetId: string, kind = "bound", pos = 0) =>
  db.sqlite
    .prepare(
      "INSERT INTO space_trackers (space_id, widget_id, position, kind, added_by, created_at) VALUES (?, ?, ?, ?, 'owner', ?)",
    )
    .run(spaceId, widgetId, pos, kind, db.now());

const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({
    callId: "call_1",
    threadId: "thr_x",
    runId: "run_1",
    taint: false,
    permissionMode: "balanced",
    mode: "attended",
    signal: new AbortController().signal,
    onUpdate: () => undefined,
    ...over,
  }) as ToolRunContext;

describe("finding 1: an automation's Space context follows the chat it runs in", () => {
  /** Runs each automation once and records, at launch, the Space the run would get. */
  function scheduler(db: PsycheDb) {
    const seen: { title: string; threadId: string; space?: string; prompt: string }[] = [];
    const launcher: RunLauncher = {
      async launch(request: AutomationRunRequest) {
        const space = runSpaceFor(db, request.threadId)?.id;
        seen.push({
          title: request.automation.title,
          threadId: request.threadId,
          ...(space === undefined ? {} : { space }),
          prompt: request.prompt,
        });
        return {
          taskId: `task_${seen.length}`,
          result: Promise.resolve({ status: "done", summary: "ok" }),
        };
      },
    };
    const clock = new FakeClock(Date.parse("2026-11-20T12:00:00Z"));
    const notifier = new FakeNotifier({ clock });
    const s = new SqliteScheduler({
      db,
      clock,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      launcher,
      sessions: createDbSessionResolver(db),
      notifier,
      deliverer: createDeliverer({ notifier }),
    });
    return { s, seen };
  }
  const hourly = {
    kind: "interval",
    schedule: "PT1H",
    prompt: "Check the quotes",
    timezone: "UTC",
    delivery: {},
    scratch: null,
    enabled: true,
  } as const;

  it("refuses an automation in a Space aimed at the main chat, with the i18n reason", async () => {
    const { db, c } = await start();
    const a = await newSpace(c, { name: "Taxes" });
    const { s } = scheduler(db);
    await expect(
      s.create({ ...hourly, title: "Main", sessionTarget: "main", spaceId: a.id }),
    ).rejects.toMatchObject({ details: { reason: SPACE_MAIN_CHAT_REASON } });
    // Moving one that runs in main into a Space is refused the same way.
    const onMain = await s.create({ ...hourly, title: "Main", sessionTarget: "main" });
    expect(() => new SpaceStore(db).moveAutomations([onMain.id], a.id)).toThrow(
      expect.objectContaining({ details: { reason: SPACE_MAIN_CHAT_REASON } }),
    );
    expect(new SpaceStore(db).moveAutomations([onMain.id], null).moved).toEqual([]);
  });

  it("isolated runs get their Space; a named chat in another Space gets that chat's, never the automation's", async () => {
    const { db, c } = await start();
    const a = await newSpace(c, { name: "Taxes", instructions: "Be brief." });
    await c.call("spaces.update", { spaceId: a.id, private: true }, ik());
    const b = await newSpace(c, { name: "Trip" });
    const { s, seen } = scheduler(db);
    const iso = await s.create({
      ...hourly,
      title: "Iso",
      sessionTarget: "isolated",
      spaceId: a.id,
    });
    const named = await s.create({
      ...hourly,
      title: "Named",
      sessionTarget: "named:tiles",
      spaceId: a.id,
    });
    // The named chat exists and the owner moved it into Space B.
    await s.trigger(named.id);
    await s.idle();
    const namedThread = seen[0]?.threadId as string;
    await c.call("spaces.threads.move", { threadIds: [namedThread], spaceId: b.id }, ik());
    await s.trigger(iso.id);
    await s.idle();
    await s.trigger(named.id);
    await s.idle();
    expect(seen.map((x) => [x.title, x.space])).toEqual([
      ["Named", a.id],
      ["Iso", a.id],
      ["Named", b.id],
    ]);
    // The card comes from the run's own Space (the provider), so B's chat never shows A's name.
    const card = await spaceContextProvider(db).provide({
      threadId: namedThread,
      runId: "r",
      text: "Check the quotes",
      mode: "unattended",
      permissionMode: "balanced",
      spaceId: seen[2]?.space as string,
    });
    expect(JSON.stringify(card)).not.toContain("Taxes");
    // Finding 4: the scheduler's prompt (the Task goal, the run's owner words) has no card.
    for (const x of seen) {
      expect(x.prompt).not.toContain("You are working in the Space");
      expect(x.prompt).not.toContain("Taxes");
    }
  });
});

describe("finding 2: the thread tools keep a private Space's chats out", () => {
  function threadToolRun(db: PsycheDb, gw: TestGateway["gateway"]) {
    const tools: Record<string, AgentToolRegistration> = Object.fromEntries(
      threadTools({ db, gateway: () => gw }).map((x) => [x.spec.name, x]),
    );
    return (name: string, params: unknown, cx: ToolRunContext) =>
      tools[name]?.run?.(params, cx) as Promise<Json>;
  }

  it.each([
    // [label, caller, sees the private chat?]
    ["from the main chat", "outside", false],
    ["from another Space", "other", false],
    ["from inside the private Space", "inside", true],
  ] as const)("%s", async (_label, caller, sees) => {
    const { db, c, gw } = await start();
    const secret = await newSpace(c, { name: "Taxes" });
    await c.call("spaces.update", { spaceId: secret.id, private: true }, ik());
    const open = await newSpace(c, { name: "Trip" });
    const hidden = await newChat(c, secret.id, "Audit letter");
    const sibling = await newChat(c, secret.id, "Receipts");
    const outside = await newChat(c, undefined, "Lunch");
    const other = await newChat(c, open.id, "Flights");
    const from = { outside, other, inside: sibling }[caller];
    const spaceId = { outside: undefined, other: open.id, inside: secret.id }[caller];
    const run = threadToolRun(db, gw);
    const cx = ctx({ threadId: from, ...(spaceId === undefined ? {} : { spaceId }) });
    const listed = await run("threads_list", {}, cx);
    const titles = listed.output.threads.map((x: Json) => x.title);
    expect(titles.includes("Audit letter")).toBe(sees);
    expect(titles).toContain(from === outside ? "Flights" : "Lunch");
    const read = run("thread_read", { threadId: hidden }, cx);
    const message = run("thread_message", { threadId: hidden, content: "hi" }, cx);
    if (sees) {
      await expect(read).resolves.toMatchObject({ output: { threadId: hidden } });
    } else {
      await expect(read).rejects.toMatchObject({ code: "not_found" });
      await expect(message).rejects.toMatchObject({ code: "not_found" });
    }
    await message.catch(() => undefined);
  });

  it("a chat in an open Space stays visible everywhere", async () => {
    const { db, c, gw } = await start();
    const open = await newSpace(c, { name: "Trip" });
    const shown = await newChat(c, open.id, "Flights");
    const outside = await newChat(c, undefined, "Lunch");
    const run = threadToolRun(db, gw);
    const listed = await run("threads_list", {}, ctx({ threadId: outside }));
    expect(listed.output.threads.map((x: Json) => x.threadId)).toContain(shown);
  });
});

describe("r2 finding 1: a private Space's automation and job threads stay inside it", () => {
  async function setupTaxes() {
    const { db, c, gw } = await start();
    const taxes = await newSpace(c, { name: "Taxes" });
    await c.call("spaces.update", { spaceId: taxes.id, private: true }, ik());
    const clock = new FakeClock(Date.parse("2026-11-20T12:00:00Z"));
    const notifier = new FakeNotifier({ clock });
    const resolver = createDbSessionResolver(db);
    const s = new SqliteScheduler({
      db,
      clock,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      launcher: {
        launch: () => ({ taskId: "t", result: Promise.resolve({ status: "done", summary: "ok" }) }),
      } as unknown as RunLauncher,
      sessions: resolver,
      notifier,
      deliverer: createDeliverer({ notifier }),
    });
    const base = {
      kind: "interval",
      schedule: "PT1H",
      prompt: "Audit",
      timezone: "UTC",
      delivery: {},
      scratch: null,
      enabled: true,
      spaceId: taxes.id,
    } as const;
    const iso = await s.create({ ...base, title: "Audit iso", sessionTarget: "isolated" });
    const named = await s.create({ ...base, title: "Audit named", sessionTarget: "named:audit" });
    const runThread = await resolver.resolve("isolated", { automation: iso, runId: "run_1" });
    const namedThread = await resolver.resolve("named:audit", {
      automation: named,
      runId: "run_2",
    });
    const home = db.sqlite
      .prepare("SELECT id FROM threads WHERE session_key = ?")
      .get(`automation:${iso.id}`) as { id: string };
    // A specialist job of a chat in the Space: a subagent thread whose task names the Space.
    const job = db.sqlite
      .prepare(
        "INSERT INTO threads (id, kind, session_key, title, created_at, updated_at) VALUES ('thr_job', 'subagent', 'specialist:r:1', 'Job', ?, ?)",
      )
      .run(db.now(), db.now());
    void job;
    db.sqlite
      .prepare(
        "INSERT INTO tasks (id, thread_id, title, goal, status, created_from, specialist, created_at, updated_at) VALUES ('task_job', 'thr_job', 'Job', 'g', 'queued', 'subagent', ?, ?, ?)",
      )
      .run(JSON.stringify({ spaceId: taxes.id }), db.now(), db.now());
    const hiddenIds = [runThread, namedThread, home.id, "thr_job"];
    const inside = await newChat(c, taxes.id, "Receipts");
    const outside = await newChat(c, undefined, "Lunch");
    return { db, gw, taxes, hiddenIds, inside, outside };
  }
  const runTools = (db: PsycheDb, gw: TestGateway["gateway"]) => {
    const tools: Record<string, AgentToolRegistration> = Object.fromEntries(
      threadTools({ db, gateway: () => gw }).map((x) => [x.spec.name, x]),
    );
    return tools;
  };

  it("lists and reads none of them from outside; the Space's own chat still does", async () => {
    const { db, gw, taxes, hiddenIds, inside, outside } = await setupTaxes();
    const tools = runTools(db, gw);
    const out = ctx({ threadId: outside });
    const listed = (await tools.threads_list?.run?.({}, out)) as Json;
    const ids = listed.output.threads.map((x: Json) => x.threadId);
    for (const id of hiddenIds) {
      expect(ids).not.toContain(id);
      await expect(tools.thread_read?.run?.({ threadId: id }, out)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        tools.thread_message?.run?.({ threadId: id, content: "hi" }, out),
      ).rejects.toMatchObject({ code: "not_found" });
      // No approval card for a hidden id.
      expect(() =>
        tools.thread_read?.describeCall?.({ threadId: id }, { runId: "r", threadId: outside }),
      ).toThrow(/not found/);
      expect(() =>
        tools.thread_archive?.describeCall?.({ threadId: id }, { runId: "r", threadId: outside }),
      ).toThrow(/not found/);
    }
    const inCtx = ctx({ threadId: inside, spaceId: taxes.id });
    for (const id of hiddenIds.filter((x) => x !== hiddenIds[0])) {
      await expect(tools.thread_read?.run?.({ threadId: id }, inCtx)).resolves.toBeDefined();
      expect(() =>
        tools.thread_read?.describeCall?.(
          { threadId: id },
          { runId: "r", threadId: inside, spaceId: taxes.id },
        ),
      ).not.toThrow();
    }
  });
});

describe("finding 5: bindings at any depth the validator allows count", () => {
  const nest = (depth: number, source: string): Json => {
    let node: Json = { id: "leaf", type: "status", bind: { source, id: "x", field: "status" } };
    for (let i = 0; i < depth; i += 1) node = { id: `n${i}`, type: "stack", children: [node] };
    return node;
  };
  it.each([
    ["research at depth 1", 1, "research", true],
    ["research at depth 6", 6, "research", true],
    ["research at depth 8", 8, "research", true],
    ["mail inside tabs", -1, "mail", true],
    ["task at depth 6", 6, "task", false],
    ["job at depth 8", 8, "job", false],
  ] as const)("%s", (_label, depth, source, thirdParty) => {
    const root =
      depth === -1
        ? {
            id: "t",
            type: "tabs",
            tabs: [{ label: "a", children: [nest(2, source)] }],
          }
        : nest(depth, source);
    const spec = JSON.stringify({ v: 1, title: "x", root });
    expect(trackerThirdParty({ kind: "bound", taint: "[]", spec })).toBe(thirdParty);
  });
});

describe("finding 6: the third-party ids line is cut by whole ids only", () => {
  const ulid = (i: number) => `wdg_01JD${String(i).padStart(22, "0")}`;
  it("lists all 12 ULID trackers whole", async () => {
    const { db, c } = await start();
    const space = await newSpace(c);
    const chat = await newChat(c, space.id);
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = widget(db, chat, {
        id: ulid(i),
        root: { id: "s", type: "status", bind: { source: "mail", id: "m", field: "status" } },
      });
      shelve(db, space.id, id, "bound", i);
      ids.push(id);
    }
    const { trackers } = spaceTurnSections(db, space.id);
    for (const id of ids) expect(trackers).toContain(id);
    expect(trackers).not.toContain("more:");
  });

  it.each([
    ["all fit", 3, 200, 0],
    ["two do not fit", 5, 140, 2],
    ["none fit", 3, 30, 3],
  ] as const)("%s", (_label, n, cap, more) => {
    const ids = Array.from({ length: n }, (_, i) => ulid(i));
    const line = idsLine("ids: ", ids, cap);
    expect(line.length).toBeLessThanOrEqual(Math.max(cap, 60));
    const listed = ids.filter((id) => line.includes(id));
    expect(listed).toHaveLength(n - more);
    // Whatever is listed is a whole id, and nothing is half an id.
    const tokens = line.match(/wdg_[0-9A-Z]+/g) ?? [];
    for (const tok of tokens) expect(ids).toContain(tok);
    if (more > 0) expect(line).toContain(`(+${more} more: space_get lists them)`);
  });
});

describe("finding 7: calendar_find_free_time keeps to the Space's connectors", () => {
  function tool() {
    const asked: string[] = [];
    const services = {
      tools: {
        get: (name: string) => ({
          execute: async () => {
            asked.push(name);
            return { output: { busy: [] }, provenance: "trusted" };
          },
        }),
      },
    } as unknown as ComposeServices;
    const registry = {
      list: async () => [
        { id: "gcal", type: "google", status: "connected", label: "Google" },
        { id: "apple-calendar", type: "apple:calendar", status: "connected", label: "Apple" },
      ],
    } as unknown as Parameters<typeof freeTimeTool>[1];
    return { reg: freeTimeTool(services, registry), asked };
  }
  const params = {
    from: "2026-11-23T09:00:00Z",
    to: "2026-11-23T17:00:00Z",
    durationMinutes: 30,
  };
  it.each([
    ["no scope reads every calendar", undefined, ["Google", "Apple"]],
    ["a scope reads only its calendars", ["gcal"], ["Google"]],
    ["a scope of other connectors reads none", ["notion"], []],
  ] as const)("%s", async (_label, scope, used) => {
    const { reg } = tool();
    const run = reg.run?.(
      params,
      ctx(scope === undefined ? {} : { connectorScope: [...scope], spaceId: "spc_1" }),
    );
    if (used.length === 0) {
      await expect(run).rejects.toMatchObject({ code: "unavailable" });
    } else {
      expect(((await run) as Json).output.calendars).toEqual(used);
    }
  });
});

describe("finding 8: an archived Space gives no context", () => {
  it("its chats run as plain chats; the Space tools see no Space", async () => {
    const { db, c } = await start();
    const space = await newSpace(c, { instructions: "Budget is $25k." });
    const chat = await newChat(c, space.id);
    expect(runSpaceFor(db, chat)?.id).toBe(space.id);
    await c.call("spaces.archive", { spaceId: space.id }, ik());
    expect(runSpaceFor(db, chat)).toBeUndefined();
    expect(runSpaceById(db, space.id)).toBeUndefined();
  });
});

describe("finding 11: space_add_tracker respects frozen widgets", () => {
  it.each([
    ["a live widget of this chat", "live", undefined],
    ["a frozen widget of this chat", "frozen", "conflict"],
  ] as const)("%s", async (_label, state, code) => {
    const { db, c } = await start();
    const space = await newSpace(c);
    const chat = await newChat(c, space.id);
    const w = widget(db, chat, { state });
    const add = () => shelveAgentWidget(db, { spaceId: space.id, widgetId: w, threadId: chat });
    if (code === undefined) expect(add()).toBe(w);
    else expect(add).toThrow(expect.objectContaining({ code }));
  });
});

describe("finding 12: Library item and note links must exist and be this run's to see", () => {
  async function setup() {
    const { db, c } = await start();
    const space = await newSpace(c);
    const secret = await newSpace(c, { name: "Taxes" });
    await c.call("spaces.update", { spaceId: secret.id, private: true }, ik());
    const chat = await newChat(c, space.id);
    const secretChat = await newChat(c, secret.id);
    const item = (id: string, threadId: string | null, quarantined = 0) =>
      db.sqlite
        .prepare(
          `INSERT INTO library_items (id, kind, name, mime, path, size, sha256, origin, thread_id, quarantined, created_at)
           VALUES (?, 'document', 'Quote.pdf', 'application/pdf', ?, 1, 'x', 'upload', ?, ?, ?)`,
        )
        .run(id, `${id}.pdf`, threadId, quarantined, db.now());
    item("lib_ok", null);
    item("lib_here", chat);
    item("lib_secret", secretChat);
    item("lib_quarantined", null, 1);
    const notes = new Set(["notes/plan.md"]);
    const list = spaceTools({
      db,
      publish: () => undefined,
      noteExists: (p) => notes.has(p),
    });
    const run = (input: Json) =>
      list
        .find((x) => x.spec.name === "space_add_link")
        ?.run?.(
          input as never,
          ctx({ threadId: chat, spaceId: space.id }) as never,
        ) as Promise<Json>;
    return { run };
  }

  it.each([
    ["an existing Library item", { kind: "library_item", ref: "lib_ok" }, true],
    ["an item from this Space's chat", { kind: "library_item", ref: "lib_here" }, true],
    ["an unknown item id", { kind: "library_item", ref: "lib_nope" }, false],
    ["an item from a private Space's chat", { kind: "library_item", ref: "lib_secret" }, false],
    ["a quarantined item", { kind: "library_item", ref: "lib_quarantined" }, false],
    ["an existing note", { kind: "note", ref: "notes/plan.md" }, true],
    ["a missing note", { kind: "note", ref: "notes/other.md" }, false],
    ["a note path that climbs out", { kind: "note", ref: "../secrets/plan.md" }, false],
    ["an absolute note path", { kind: "note", ref: "/etc/passwd" }, false],
  ] as const)("%s", async (_label, link, ok) => {
    const { run } = await setup();
    const r = await run({ ...link, label: "Quote" });
    if (ok) expect(r.isError).toBeUndefined();
    else expect(r.output.error.code).toBe("not_found");
  });

  it("refuses note links when notes cannot be checked", async () => {
    const { db, c } = await start();
    const space = await newSpace(c);
    const chat = await newChat(c, space.id);
    const r = await spaceTools({ db, publish: () => undefined })
      .find((x) => x.spec.name === "space_add_link")
      ?.run?.(
        { kind: "note", ref: "notes/plan.md", label: "Plan" } as never,
        ctx({ threadId: chat, spaceId: space.id }) as never,
      );
    expect((r as Json).output.error.code).toBe("not_found");
  });
});
