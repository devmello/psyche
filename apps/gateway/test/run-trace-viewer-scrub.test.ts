import { updateDevice } from "@psyche/db";
import type { Json, RunStep, ToolCall } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { Call } from "../src/context.ts";
import { runsHandlers } from "../src/handlers/runs.ts";
import type { Reader } from "../src/message-scrub.ts";
import {
  bareToolName,
  ownerOnlySourceOfTool,
  scrubModelPayloads,
} from "../src/run-trace/viewer-scrub.ts";
import { GatedAgentLoop } from "./agent.ts";
import {
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Run traces held to the viewer (`run-trace/viewer-scrub.ts`): a tool that read Contacts, Messages,
 * Memory or mail shows its step to a remote viewer with a placeholder in place of its input and
 * output; an ordinary tool's step is unchanged; the desktop shell on this Mac sees everything.
 */

const OWNER_SECRET = "Alice Example +1 555 0100";
const OWNER_QUERY = "who is Alice";
const WEB_OUTPUT = "Lisbon weather: sunny";
const WEB_QUERY = "lisbon weather";
const PLACEHOLDER = "Read from Contacts: hidden on this device";

let t: TestGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
  t = null;
});

const record = (runId: string, id: string, tool: string, params: Json): ToolCall => ({
  id,
  runId,
  messageId: null,
  tool,
  paramsRedacted: params,
  paramsHash: "sha256:x",
  sideEffect: "read",
  target: null,
  decision: null,
  decisionRule: null,
  approvalId: null,
  taintIn: false,
  taintOut: true,
  resultRef: null,
  provenanceOut: "untrusted",
  receiptId: null,
  startedAt: "2026-10-25T10:00:00.000Z",
  endedAt: "2026-10-25T10:00:01.000Z",
  status: "ok",
});

/** A device paired once through the secret, then reconnected as itself (never the shell). */
async function pairedRemote(
  gw: TestGateway["gateway"],
  platform: "macos" | "ios" | "web",
): Promise<TestClient> {
  const key = newDeviceKey();
  const deviceId = `${platform}-${Math.random().toString(36).slice(2)}`;
  const first = await desktopClient(gw, key, deviceId, platform);
  first.close();
  updateDevice(gw.context.db, deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const c = await TestClient.open(wsUrlOf(gw));
  const r = await handshake(c, gw.origin, { key, deviceId, platform });
  if ((r.verifyRes?.payload as { phase?: string } | undefined)?.phase !== "paired")
    throw new Error(`${platform} did not pair`);
  return c;
}

/** One run with an owner-only tool (Contacts) and an ordinary one (web search). */
async function setup() {
  const agent = new GatedAgentLoop();
  t = await startTestGateway({ agent });
  const gw = t.gateway;
  const desk = await desktopClient(gw);
  const ios = await pairedRemote(gw, "ios");
  const mac = await pairedRemote(gw, "macos");
  const web = await pairedRemote(gw, "web");
  clients.push(desk, ios, mac, web);
  const { thread } = await desk.call<{ thread: { id: string } }>(
    "threads.create",
    { kind: "main" },
    ik(),
  );
  const sink = gw.context.runTrace;
  const runId = () => agent.turns.at(-1)?.runId as string;
  const tool = (id: string, name: string, status: "running" | "ok") => ({
    type: "tool_call" as const,
    toolCallId: id,
    tool: name,
    status,
    level1: name === "web_search" ? "Searching the web" : "Searching contacts for Alice",
    details: { paramsRedacted: name === "web_search" ? { q: WEB_QUERY } : { q: OWNER_QUERY } },
  });
  agent.script([
    tool("tc_owner", "mcp__apple-contacts__contacts_search", "running"),
    tool("tc_owner", "mcp__apple-contacts__contacts_search", "ok"),
    {
      type: "do",
      fn: () =>
        sink.toolResult(
          record(runId(), "tc_owner", "mcp__apple-contacts__contacts_search", { q: OWNER_QUERY }),
          { output: { contacts: [OWNER_SECRET] }, provenance: "untrusted" },
        ),
    },
    tool("tc_web", "web_search", "running"),
    tool("tc_web", "web_search", "ok"),
    {
      type: "do",
      fn: () =>
        sink.toolResult(record(runId(), "tc_web", "web_search", { q: WEB_QUERY }), {
          output: WEB_OUTPUT,
          provenance: "untrusted",
        }),
    },
    { type: "end", outcome: "final" },
  ]);
  await desk.call("chat.send", { threadId: thread.id, content: "Find Alice" }, ik());
  await gw.context.sessions.idle();
  const id = runId();
  const steps = (await desk.call<{ steps: RunStep[] }>("runs.get", { runId: id })).steps;
  const ownerStep = steps.find((s) => s.toolCallId === "tc_owner") as RunStep;
  const webStep = steps.find((s) => s.toolCallId === "tc_web") as RunStep;
  return { gw, desk, ios, mac, web, runId: id, ownerStep, webStep };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Every surface's answer for one viewer, as one string per tool class. */
async function surfaces(
  ask: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  s: Setup,
): Promise<Record<string, { owner: string; ordinary: string }>> {
  const stepOf = (steps: RunStep[], id: string) =>
    JSON.stringify(steps.find((x) => x.toolCallId === id));
  const get = (await ask("runs.get", { runId: s.runId })) as { steps: RunStep[] };
  const page = (await ask("runs.steps", { runId: s.runId })) as { steps: RunStep[] };
  const one = async (stepId: string) =>
    JSON.stringify(await ask("runs.step", { runId: s.runId, stepId }));
  const exp = async (format: string) => {
    const r = (await ask("runs.export", { runId: s.runId, format })) as { dataBase64: string };
    return Buffer.from(r.dataBase64, "base64").toString("utf8");
  };
  const json = await exp("psyche-trace+json");
  const md = await exp("markdown");
  return {
    "runs.get": { owner: stepOf(get.steps, "tc_owner"), ordinary: stepOf(get.steps, "tc_web") },
    "runs.steps": { owner: stepOf(page.steps, "tc_owner"), ordinary: stepOf(page.steps, "tc_web") },
    "runs.step": { owner: await one(s.ownerStep.id), ordinary: await one(s.webStep.id) },
    // An export holds both steps: each class is judged on the same document.
    "runs.export json": { owner: json, ordinary: json },
    // Markdown lists step labels only, never payloads: judged on the labels.
    "runs.export markdown": {
      owner: md.includes("Searching contacts for Alice") ? `${md} 555 0100 ${OWNER_QUERY}` : md,
      ordinary: md.includes("Searching the web") ? `${md} ${WEB_OUTPUT} ${WEB_QUERY}` : md,
    },
  };
}

const expectFull = (owner: string, ordinary: string) => {
  expect(owner).toContain("555 0100");
  expect(owner).toContain(OWNER_QUERY);
  expect(ordinary).toContain(WEB_OUTPUT);
};

const expectScrubbed = (owner: string, ordinary: string) => {
  expect(owner).not.toContain("555 0100");
  expect(owner).not.toContain(OWNER_QUERY);
  expect(owner).not.toContain("Searching contacts for Alice");
  // Positive control: the ordinary tool's output is still there for the same viewer.
  expect(ordinary).toContain(WEB_OUTPUT);
  expect(ordinary).toContain(WEB_QUERY);
};

describe("run trace viewer scrub: methods × viewer × tool class", () => {
  it("the desktop shell sees everything; iOS, a remote Mac, the web shell and a spoofed param see placeholders", async () => {
    const s = await setup();
    const via =
      (c: TestClient, extra: Record<string, unknown> = {}) =>
      (method: string, params: Record<string, unknown>) =>
        c.call(method, { ...params, ...extra });
    const desk = await surfaces(via(s.desk), s);
    for (const [method, r] of Object.entries(desk)) {
      expect(r.owner, `desktop ${method}`).not.toContain(PLACEHOLDER);
      expectFull(r.owner, r.ordinary);
    }
    const viewers: [string, TestClient, Record<string, unknown>][] = [
      ["iOS", s.ios, {}],
      ["remote Mac", s.mac, {}],
      ["web", s.web, {}],
      ["spoofed desktopShell param", s.ios, { desktopShell: true, local: true }],
    ];
    for (const [name, c, extra] of viewers) {
      const got = await surfaces(via(c, extra), s);
      for (const [method, r] of Object.entries(got)) {
        expectScrubbed(r.owner, r.ordinary);
        expect(r.owner, `${name} ${method}`).toContain(
          method === "runs.export markdown"
            ? "Used Contacts"
            : method === "runs.export json"
              ? "hidden on this device"
              : PLACEHOLDER,
        );
      }
    }
  });

  it("a desktopShell identity on a peer that is not loopback is remote", async () => {
    const s = await setup();
    const handler = (method: string) =>
      runsHandlers[method] as { run: (c: Call, p: never) => unknown };
    const callAs = (loopback: boolean) =>
      ({
        ctx: s.gw.context,
        identity: { role: "client", desktopShell: true, deviceId: "d", scopes: ["operator.read"] },
        conn: { peer: { remoteLoopback: loopback } },
      }) as unknown as Call;
    const ask = (loopback: boolean) => async (method: string, params: Record<string, unknown>) =>
      handler(method).run(callAs(loopback), params as never);
    for (const [method, r] of Object.entries(await surfaces(ask(false), s)))
      expect(() => expectScrubbed(r.owner, r.ordinary), method).not.toThrow();
    // Positive control: the same identity on loopback is the desktop shell.
    for (const [, r] of Object.entries(await surfaces(ask(true), s)))
      expectFull(r.owner, r.ordinary);
  });

  it("the run.step event: the desktop shell gets it whole, every other subscriber the placeholder", async () => {
    const s = await setup();
    const stepEvents = (c: TestClient, id: string) =>
      c
        .eventsNamed("run.step")
        .map((e) => (e.payload as { step: RunStep }).step)
        .filter((x) => x.toolCallId === id);
    await s.ios.waitForEvent(
      (e) =>
        e.event === "run.step" &&
        (e.payload as { step: RunStep }).step.toolCallId === "tc_web" &&
        (e.payload as { step: RunStep }).step.preview?.output !== undefined,
    );
    const deskOwner = JSON.stringify(stepEvents(s.desk, "tc_owner"));
    expect(deskOwner).toContain("555 0100");
    expect(deskOwner).toContain("Searching contacts for Alice");
    for (const c of [s.ios, s.mac, s.web]) {
      const owner = stepEvents(c, "tc_owner");
      expect(owner.length).toBeGreaterThan(0);
      expectScrubbed(JSON.stringify(owner), JSON.stringify(stepEvents(c, "tc_web")));
      expect(owner.at(-1)?.label).toBe("Used Contacts");
      expect(owner.at(-1)?.status).toBe("ok");
      expect(owner.at(-1)?.endedAt).not.toBeNull();
    }

    // Bus readers directly: a shell identity without the loopback mark is remote.
    const seen = (reader: Reader) => {
      const frames: string[] = [];
      const off = s.gw.context.bus.subscribe(
        ["operator.read"],
        (f) => frames.push(f),
        null,
        reader,
      );
      s.gw.context.bus.publish("run.step", { runId: s.runId, step: s.ownerStep });
      s.gw.context.bus.publish("run.step", { runId: s.runId, step: s.webStep });
      off();
      return frames;
    };
    const local = seen({ role: "client", desktop: true, local: true });
    expectFull(local[0] as string, local[1] as string);
    for (const reader of [
      { role: "client", desktop: true, local: false },
      { role: "client", desktop: true },
      { role: "client", desktop: false },
      { role: null, desktop: false },
    ] as Reader[]) {
      const f = seen(reader);
      expect(f).toHaveLength(2);
      expectScrubbed(f[0] as string, f[1] as string);
    }
  });
});

describe("ownerOnlySourceOfTool", () => {
  const OWNER_ONLY: [string, string][] = [
    ["mcp__apple-contacts__contacts_search", "contacts"],
    ["mcp__Apple_Contacts__contacts_read", "contacts"],
    ["contacts_search", "contacts"],
    ["Contacts_Search", "contacts"],
    ["ｃｏｎｔａｃｔｓ_search", "contacts"],
    ["messages_send", "messages"],
    ["mcp__apple-mail__mail_read", "mail"],
    ["mail_search_messages", "mail"],
    ["mail_read_message", "mail"],
    ["gmail_read_thread", "mail"],
    ["mcp__google__gmail_search_threads", "mail"],
    ["memory", "memory"],
    ["remember", "memory"],
    ["memory_recall", "memory"],
    ["entity_recall", "memory"],
  ];
  const ORDINARY = [
    "web_search",
    "web_fetch",
    "web.fetch",
    "read_file",
    "list_dir",
    "calendar_list_events",
    "notes_read",
    "reminders_list",
    "browser.read_text",
    "memoryless_tool",
    "mailbox_cleaner",
    "messages",
    "search_everything",
  ];
  it.each(OWNER_ONLY)("%s is owner-only (%s)", (tool, source) => {
    expect(ownerOnlySourceOfTool(tool)).toBe(source);
  });
  it.each(ORDINARY)("%s is ordinary", (tool) => {
    expect(ownerOnlySourceOfTool(tool)).toBeNull();
  });
  it("search_everything follows what it returned", () => {
    expect(ownerOnlySourceOfTool("search_everything", '{"hits":[{"id":"files:/a"}]}')).toBeNull();
    expect(
      ownerOnlySourceOfTool("search_everything", '{"hits":[{"id":"messages:chat1:42"}]}'),
    ).toBe("messages");
    expect(ownerOnlySourceOfTool("search_everything", '{"id":"Memory:people/alice.md"}')).toBe(
      "memory",
    );
  });
  it("bareToolName strips any connector prefix and folds", () => {
    expect(bareToolName("mcp__srv_with_underscores__contacts_search")).toBe("contacts_search");
    expect(bareToolName("CONTACTS_SEARCH")).toBe("contacts_search");
  });
});

describe("scrubModelPayloads", () => {
  it("never sends the model input, and hides owner-only tool call inputs", () => {
    const out = scrubModelPayloads({
      input: { system: "USER.md: Alice is my sister", messages: [] },
      output: {
        text: "Here is the plan",
        toolCalls: [
          { id: "1", name: "contacts_search", input: { q: OWNER_QUERY } },
          { id: "2", name: "web_search", input: { q: WEB_QUERY } },
        ],
      },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("Alice is my sister");
    expect(text).not.toContain(OWNER_QUERY);
    // Positive controls: the reply text and an ordinary call's input stay.
    expect(text).toContain("Here is the plan");
    expect(text).toContain(WEB_QUERY);
  });
});
