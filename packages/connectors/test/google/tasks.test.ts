import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { toolCallBindingHash } from "../../src/framework/binding.ts";
import { ConnectorRegistry } from "../../src/framework/registry.ts";
import type { ConnectorRecord, ConnectorTool, ToolRunContext } from "../../src/framework/types.ts";
import { GOOGLE_SCOPES } from "../../src/google/auth.ts";
import { GoogleConnector, googleFactory } from "../../src/google/connector.ts";
import { dayIn } from "../../src/google/tasks.ts";
import { TASKS_ACTIONS, tasksAccess, tasksTools } from "../../src/google/tasks-tools.ts";
import { TODO_ACTIONS, todoTools } from "../../src/microsoft/todo-tools.ts";
import { MapRegistry, run, stubBroker } from "../mail/helpers.ts";
import { CLIENT_ID, FakeGoogle, fixture } from "./fake-google.ts";
import { type FakeTaskList, FakeTasksApi } from "./fake-tasks.ts";

type Out = { output: Record<string, unknown>; provenance?: string; receiptId?: string };

// Days are computed from the clock and this machine's zone, so the tests hold in any zone.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TODAY = dayIn(new FakeClock().now(), TZ);
/** The day `n` days from today, as Google stores a due day (UTC midnight). */
const plus = (n: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dueOf = (n: number) => `${plus(n)}T00:00:00.000Z`;
/** An instant at noon UTC on the day `n` days from today: its day is `plus(n)` in any zone near UTC. */
const noonOf = (n: number) => `${plus(n)}T12:00:00Z`;

const LISTS = (): FakeTaskList[] => [
  {
    id: "L1",
    title: "My Tasks",
    tasks: [
      {
        id: "T1",
        title: "Call the dentist",
        notes: "Ask about the crown",
        status: "needsAction",
        due: dueOf(0),
        updated: "2026-10-18T00:00:00Z",
      },
      {
        id: "T2",
        title: "Pay rent",
        status: "needsAction",
        due: dueOf(-2),
        updated: "2026-10-18T00:00:00Z",
      },
      {
        id: "T3",
        title: "Send the slides",
        status: "needsAction",
        due: dueOf(3),
        updated: "2026-10-18T00:00:00Z",
      },
      { id: "T4", title: "Buy milk", status: "needsAction", updated: "2026-10-18T00:00:00Z" },
      {
        id: "T5",
        title: "Old chore",
        status: "completed",
        due: dueOf(-5),
        completed: "2026-10-10T09:00:00.000Z",
        updated: "2026-10-10T09:00:00.000Z",
      },
    ],
  },
  {
    id: "L2",
    title: "Work",
    tasks: [
      {
        id: "T6",
        title: "Dentist follow-up",
        status: "needsAction",
        due: dueOf(1),
        updated: "2026-10-18T00:00:00Z",
      },
    ],
  },
];

async function connected(scopeMode: "read" | "read_act" = "read_act", lists = LISTS()) {
  const g = new FakeGoogle();
  g.route("GET", "/gmail/v1/users/me/profile", fixture("profile"));
  const api = new FakeTasksApi(g, lists);
  const tools = new MapRegistry();
  const { broker, receipts, approved } = stubBroker();
  const registry = new ConnectorRegistry({
    factories: [googleFactory({ openBrowser: g.openBrowser, timeoutMs: 5000 })],
    context: g.context(),
    tools,
    broker,
    approvalFor: (id) => (id === "call-approved" ? "apr_1" : undefined),
    newId: () => "google-1",
  });
  const record = await registry.connect({
    catalogueId: "google",
    scopeMode,
    config: { clientId: CLIENT_ID },
  });
  const approve = (name: string, params: unknown) => {
    const desc = tools.get(`mcp__google-1__${name}`)?.describeCall?.(params);
    approved.apr_1 = toolCallBindingHash(`mcp__google-1__${name}`, params, desc);
    return desc;
  };
  return { g, api, registry, record, tools, receipts, approve };
}

type Connected = Awaited<ReturnType<typeof connected>>;

const write = async (t: Connected, name: string, params: Record<string, unknown>) => {
  t.approve(name, params);
  return (await run(t.tools, `mcp__google-1__${name}`, params, "call-approved")) as Out;
};

const titlesOf = (out: Out) => (out.output.reminders as { title: string }[]).map((r) => r.title);

/** A connector built from a stored record, without the registry (for connections that predate Tasks). */
function storedConnector(scopes: string[]) {
  const g = new FakeGoogle();
  const api = new FakeTasksApi(g, LISTS());
  const record: ConnectorRecord = {
    id: "google-old",
    type: "google",
    label: "Google",
    account: "owner@example.com",
    scopes,
    scopeMode: "read_act",
    actionMatrix: {},
    credentialId: null,
    status: "connected",
    config: { clientId: CLIENT_ID },
    lastSync: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const c = new GoogleConnector(
    record,
    { ...g.context(), emit: () => {} },
    { openBrowser: g.openBrowser },
  );
  return { g, api, c };
}

const toolNamed = (c: GoogleConnector, name: string): ConnectorTool => {
  const t = c.tools().find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool ${name} not listed`);
  return t;
};
const ctx = () =>
  ({ signal: new AbortController().signal, callId: "call-1" }) as unknown as ToolRunContext;

const NAMES = [
  "reminders_list_lists",
  "reminders_list",
  "reminders_create",
  "reminders_update",
  "reminders_complete",
  "reminders_set_flagged",
  "reminders_delete",
];

describe("Google Tasks consent", () => {
  it("asks for the tasks scope (read and act) or tasks.readonly (read only), and stores what was granted", async () => {
    const t = await connected();
    expect(t.g.lastAuthorize?.get("scope")?.split(" ")).toContain(GOOGLE_SCOPES.tasks);
    expect(t.record.scopes).toContain(GOOGLE_SCOPES.tasks);
    const names = t.tools.list().map((x) => x.name);
    for (const n of NAMES) expect(names).toContain(`mcp__google-1__${n}`);
    expect(t.tools.get("mcp__google-1__reminders_delete")?.spec.sideEffect).toBe("destructive");

    const ro = await connected("read");
    expect(ro.g.lastAuthorize?.get("scope")?.split(" ")).toContain(GOOGLE_SCOPES.tasksReadonly);
    const roNames = ro.tools.list().map((x) => x.name);
    expect(roNames).toContain("mcp__google-1__reminders_list");
    expect(roNames).not.toContain("mcp__google-1__reminders_create");
  });

  it("the Tasks scope check reads the granted scope set", () => {
    expect(tasksAccess([GOOGLE_SCOPES.tasks])).toEqual({ read: true, write: true });
    expect(tasksAccess([GOOGLE_SCOPES.tasksReadonly])).toEqual({ read: true, write: false });
    expect(tasksAccess([GOOGLE_SCOPES.gmailModify, GOOGLE_SCOPES.calendar])).toEqual({
      read: false,
      write: false,
    });
  });
});

describe("Google Tasks has the same tool set as Microsoft To Do", () => {
  it("the same action rows, tool names, actions and side effects", () => {
    expect(TASKS_ACTIONS).toEqual(TODO_ACTIONS);
    const google = tasksTools({
      connectorId: "g",
      tasks: {} as never,
      access: () => ({ read: true, write: true }),
      guard: (fn) => fn(),
    }).map(({ name, action, sideEffect }) => ({ name, action, sideEffect }));
    const microsoft = todoTools({
      connectorId: "m",
      todo: {} as never,
      guard: (fn) => fn(),
    }).map(({ name, action, sideEffect }) => ({ name, action, sideEffect }));
    expect(google).toEqual(microsoft);
  });
});

describe("Google Tasks reads", () => {
  it("lists the task lists as the owner's own, unshared lists", async () => {
    const t = await connected();
    const out = (await run(t.tools, "mcp__google-1__reminders_list_lists", {})) as Out;
    expect(out.output.lists).toEqual([
      { id: "L1", title: "My Tasks", source: "Google Tasks", writable: true, shared: false },
      { id: "L2", title: "Work", source: "Google Tasks", writable: true, shared: false },
    ]);
    expect(out.provenance).toBe("trusted");
  });

  it("a task reads as a reminder: id <listId>|<taskId>, the due day, its notes", async () => {
    const t = await connected();
    const out = (await run(t.tools, "mcp__google-1__reminders_list", {
      listIds: ["L1"],
      completed: false,
    })) as Out;
    const dentist = (out.output.reminders as Record<string, unknown>[]).find(
      (r) => r.title === "Call the dentist",
    );
    expect(dentist).toMatchObject({
      id: "L1|T1",
      listId: "L1",
      list: "My Tasks",
      notes: "Ask about the crown",
      due: dueOf(0),
      completed: false,
      priority: 0,
      url: null,
      flagged: false,
      recurrence: null,
      shared: false,
      source: "Google Tasks",
    });
  });

  it.each([
    [
      "no filter: everything, soonest due first, undated last",
      {},
      [
        "Old chore",
        "Pay rent",
        "Call the dentist",
        "Dentist follow-up",
        "Send the slides",
        "Buy milk",
      ],
    ],
    [
      "completed false",
      { completed: false },
      ["Pay rent", "Call the dentist", "Dentist follow-up", "Send the slides", "Buy milk"],
    ],
    ["completed true", { completed: true }, ["Old chore"]],
    ["dueToday", { dueToday: true, completed: false }, ["Call the dentist"]],
    ["overdue: open and due before today", { overdue: true }, ["Pay rent"]],
    [
      "dueBefore tomorrow, open",
      { dueBefore: noonOf(1), completed: false },
      ["Pay rent", "Call the dentist", "Dentist follow-up"],
    ],
    ["query in title or notes", { query: "DENTIST" }, ["Call the dentist", "Dentist follow-up"]],
    ["query in notes", { query: "crown" }, ["Call the dentist"]],
    ["listIds", { listIds: ["L2"] }, ["Dentist follow-up"]],
    ["offset and limit", { limit: 2, offset: 1 }, ["Pay rent", "Call the dentist"]],
  ])("filters: %s", async (_label, params, expected) => {
    const t = await connected();
    const out = (await run(t.tools, "mcp__google-1__reminders_list", params)) as Out;
    expect(titlesOf(out)).toEqual(expected);
  });

  it("follows the page tokens of a list (two tasks a page)", async () => {
    const t = await connected();
    await run(t.tools, "mcp__google-1__reminders_list", { listIds: ["L1"] });
    expect(t.api.queries.some((q) => q.pageToken !== undefined)).toBe(true);
  });

  it("refuses a flagged filter: Google Tasks has no Important flag", async () => {
    const t = await connected();
    await expect(
      run(t.tools, "mcp__google-1__reminders_list", { flagged: true }),
    ).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

describe("Google Tasks writes", () => {
  it("is never run without the owner's approval (connector_action)", async () => {
    const t = await connected();
    await expect(
      run(t.tools, "mcp__google-1__reminders_create", { title: "Renew passport" }),
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(t.api.writes).toHaveLength(0);
    const desc = t.approve("reminders_create", { title: "Renew passport" });
    expect(desc).toMatchObject({
      kind: "connector_action",
      grantKey: "connector_action:google-1:reminders_create",
    });
  });

  it("creates a task in the first list, or in the list named, with the due day", async () => {
    const t = await connected();
    const first = (await write(t, "reminders_create", {
      title: "Renew passport",
      notes: "Form DS-11",
      due: noonOf(4),
    })) as Out;
    expect(t.api.writes.at(-1)).toEqual({
      method: "POST",
      path: "/tasks/v1/lists/L1/tasks",
      body: { title: "Renew passport", notes: "Form DS-11", due: dueOf(4) },
    });
    expect(first.output.reminder).toMatchObject({ listId: "L1", due: dueOf(4), completed: false });

    await write(t, "reminders_create", { title: "Book flights", listId: "L2" });
    expect(t.api.writes.at(-1)?.path).toBe("/tasks/v1/lists/L2/tasks");
  });

  it("updates only the fields given", async () => {
    const t = await connected();
    const out = (await write(t, "reminders_update", {
      id: "L1|T1",
      title: "Call the dentist back",
    })) as Out;
    expect(t.api.writes.at(-1)).toEqual({
      method: "PATCH",
      path: "/tasks/v1/lists/L1/tasks/T1",
      body: { title: "Call the dentist back" },
    });
    expect(out.output.reminder).toMatchObject({ id: "L1|T1", title: "Call the dentist back" });
  });

  it("completes by id, reopens by title, and refuses an unknown title", async () => {
    const t = await connected();
    const done = (await write(t, "reminders_complete", { id: "L1|T2" })) as Out;
    expect(t.api.writes.at(-1)?.body).toEqual({ status: "completed" });
    expect(done.output.reminder).toMatchObject({ completed: true });

    const reopened = (await write(t, "reminders_complete", {
      title: "old chore",
      completed: false,
    })) as Out;
    expect(t.api.writes.at(-1)).toMatchObject({ body: { status: "needsAction" } });
    expect(reopened.output.reminder).toMatchObject({ completed: false });

    await expect(write(t, "reminders_complete", { title: "No such task" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("asks for an ambiguous title to be given by id", async () => {
    const lists = LISTS();
    lists[1]?.tasks.push({
      id: "T7",
      title: "Pay rent",
      status: "needsAction",
      updated: "2026-10-18T00:00:00Z",
    });
    const t = await connected("read_act", lists);
    await expect(write(t, "reminders_complete", { title: "pay rent" })).rejects.toMatchObject({
      code: "invalid_params",
      details: { reason: "ambiguous", ids: ["L1|T2", "L2|T7"] },
    });
  });

  it("deletes one task (destructive, asks)", async () => {
    const t = await connected();
    await expect(
      run(t.tools, "mcp__google-1__reminders_delete", { id: "L1|T4" }),
    ).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(t.api.writes).toHaveLength(0);
    const out = (await write(t, "reminders_delete", { id: "L1|T4" })) as Out;
    expect(out.output).toEqual({ deleted: true });
    expect(t.api.writes.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/tasks/v1/lists/L1/tasks/T4",
    });
  });
});

describe("Google Tasks refuses what Google Tasks cannot hold", () => {
  const refusals: [string, Record<string, unknown>, string | undefined, RegExp][] = [
    ["reminders_create", { title: "x", priority: 1 }, "reminders_create", /priority/],
    ["reminders_create", { title: "x", url: "https://example.com/a" }, "reminders_create", /url/],
    [
      "reminders_create",
      { title: "x", alarm: { relativeMinutes: -60 } },
      "reminders_create",
      /alarm/,
    ],
    [
      "reminders_create",
      { title: "x", recurrence: { frequency: "daily" } },
      "reminders_create",
      /recurrence/,
    ],
    ["reminders_update", { id: "L1|T1", priority: 2 }, "reminders_update", /priority/],
    ["reminders_update", { id: "L1|T1", due: null }, "reminders_update", /due date/],
    ["reminders_update", { id: "T1", title: "x" }, "reminders_update", /<listId>\|<taskId>/],
    [
      "reminders_set_flagged",
      { id: "L1|T1", flagged: true },
      "reminders_set_flagged",
      /Important flag/,
    ],
    [
      "reminders_set_flagged",
      { id: "L1|T1", flagged: false },
      "reminders_set_flagged",
      /Important flag/,
    ],
    ["reminders_complete", { id: "T1" }, "reminders_complete", /<listId>\|<taskId>/],
  ];

  it.each(refusals)("%s refuses %j", async (name, params, approveName, message) => {
    const t = await connected();
    // Approved, so the refusal (not the approval) is what stops the call.
    if (approveName !== undefined) t.approve(approveName, params);
    await expect(run(t.tools, `mcp__google-1__${name}`, params, "call-approved")).rejects.toThrow(
      message,
    );
    expect(t.api.writes).toHaveLength(0);
  });
});

describe("Google Tasks without the Tasks scope", () => {
  it("an existing connection (made before Tasks) keeps its other tools and says to reconnect for Tasks", async () => {
    const { g, api, c } = storedConnector([
      GOOGLE_SCOPES.gmailModify,
      GOOGLE_SCOPES.calendar,
      GOOGLE_SCOPES.driveFile,
    ]);
    expect(c.tools().some((t) => t.name === "gmail_search_threads")).toBe(true);
    await expect(toolNamed(c, "reminders_list").execute({}, ctx())).rejects.toMatchObject({
      reason: "missing_scopes",
      message: expect.stringMatching(/did not grant: tasks\. Reconnect Google/),
    });
    await expect(toolNamed(c, "reminders_create").execute({ title: "x" }, ctx())).rejects.toThrow(
      /did not grant: tasks/,
    );
    expect(api.writes).toHaveLength(0);
    expect(g.requests.filter((r) => r.url.hostname === "tasks.googleapis.com")).toHaveLength(0);
  });

  it("a read-only grant reads but says changing needs read and act", async () => {
    const { api, c } = storedConnector([GOOGLE_SCOPES.tasksReadonly]);
    await expect(
      toolNamed(c, "reminders_update").execute({ id: "L1|T1", title: "x" }, ctx()),
    ).rejects.toThrow(/changing tasks needs read and act/);
    expect(api.writes).toHaveLength(0);
  });

  it("the actions list still names the Tasks rows, so the approval matrix shows them", () => {
    const { c } = storedConnector([GOOGLE_SCOPES.gmailModify]);
    expect(c.actions().map((a) => a.id)).toEqual(
      expect.arrayContaining(["reminders.read", "reminders.write", "reminders.delete"]),
    );
  });
});
