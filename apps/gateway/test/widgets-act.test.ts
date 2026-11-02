import { insertWidget } from "@psyche/db";
import type { Message, TaintSource, WidgetSpec } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ComposeServices } from "../src/compose/services.ts";
import { composeWidgets } from "../src/compose/widgets.ts";
import type { Call } from "../src/context.ts";
import { resolveToolAction, WIDGET_TOOL_DENY } from "../src/widgets/act.ts";
import { GatedAgentLoop, RecordingBroker } from "./agent.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

const spec: WidgetSpec = {
  v: 1,
  title: "Mail",
  fallbackText: "Mail actions",
  root: {
    id: "root",
    type: "stack",
    children: [
      {
        id: "send",
        type: "button",
        label: "Send the draft",
        action: { kind: "tool", tool: "email.send", args: { to: "a@b.c", draft: "d1" } },
      },
      { id: "reply", type: "button", label: "Say hi", action: { kind: "reply", text: "hi" } },
      {
        id: "evil",
        type: "button",
        label: "Grant it",
        action: { kind: "tool", tool: "request_permission", args: {} },
      },
      {
        id: "rows",
        type: "list",
        items: [
          {
            id: "r1",
            title: "Archive thread",
            action: { kind: "tool", tool: "mail.archive", args: { thread: "t1" } },
          },
        ],
      },
      {
        id: "form",
        type: "form",
        label: "Compose",
        fields: [
          { id: "to", label: "To", type: "text", required: true },
          { id: "n", label: "Count", type: "number" },
          { id: "pri", label: "Priority", type: "select", options: [{ id: "hi", label: "High" }] },
        ],
        submit: { label: "Send it", as: "tool", tool: "email.compose" },
      },
    ],
  },
};

describe("resolveToolAction", () => {
  it("takes the tool and arguments from the stored spec, and shows them in the text", () => {
    const a = resolveToolAction(spec, "send", undefined, { to: "attacker@evil.example" });
    expect(a).toMatchObject({ tool: "email.send", args: { to: "a@b.c", draft: "d1" } });
    expect(a.text).toBe('Run email.send with {"to":"a@b.c","draft":"d1"}');
    expect(resolveToolAction(spec, "rows", "r1", undefined).tool).toBe("mail.archive");
  });

  it("builds a form call from the owner's typed values only, and checks them", () => {
    const ok = resolveToolAction(spec, "form", undefined, { to: "x@y.z", n: "3", pri: "hi" });
    expect(ok).toMatchObject({ tool: "email.compose", args: { to: "x@y.z", n: 3, pri: "hi" } });
    expect(() => resolveToolAction(spec, "form", undefined, {})).toThrow(/required/);
    expect(() => resolveToolAction(spec, "form", undefined, { to: "x", extra: "y" })).toThrow(
      /no field 'extra'/,
    );
    expect(() => resolveToolAction(spec, "form", undefined, { to: "x", pri: "nope" })).toThrow(
      /offered options/,
    );
    expect(() => resolveToolAction(spec, "form", undefined, { to: "x", n: "abc" })).toThrow(
      /number/,
    );
  });

  it("refuses non-tool controls, unknown controls and host-owned tools", () => {
    expect(() => resolveToolAction(spec, "reply", undefined, undefined)).toThrow(/no tool call/);
    expect(() => resolveToolAction(spec, "nope", undefined, undefined)).toThrow(
      /not in this widget/,
    );
    expect(() => resolveToolAction(spec, "evil", undefined, undefined)).toThrow(/host-owned/);
    for (const t of [
      "request_permission",
      "exit_plan_mode",
      "install_capability",
      "run_script",
      "save_script_as_tool",
    ]) {
      expect(WIDGET_TOOL_DENY.has(t)).toBe(true);
    }
  });
});

describe("widgets.act / widgets.preview", () => {
  let t: TestGateway;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await t?.cleanup();
  });

  async function setup() {
    const agent = new GatedAgentLoop();
    // The widgets part is mounted late: its handlers need the Gateway's own database.
    let part: ReturnType<typeof composeWidgets> | undefined;
    const late = (name: string, transactional: boolean) => ({
      ...(transactional ? { transactional: true as const } : {}),
      run: (call: Call, params: unknown) => {
        const run = part?.handlers?.[name]?.run as ((c: Call, p: unknown) => unknown) | undefined;
        if (run === undefined) throw new Error(`widgets handler ${name} is not mounted`);
        return run(call, params);
      },
    });
    t = await startTestGateway({
      agent,
      broker: new RecordingBroker({ armDelayMs: 0 }),
      handlers: {
        "widgets.act": late("widgets.act", true),
        "widgets.preview": late("widgets.preview", false),
      } as never,
    });
    part = composeWidgets({
      db: t.gateway.context.db,
      tools: { register: () => () => {} },
      publish: () => {},
    } as unknown as ComposeServices);
    const c = await desktopClient(t.gateway);
    clients.push(c);
    const make = async () =>
      (
        await c.call<{ thread: { id: string } }>(
          "threads.create",
          { kind: "side", title: "t" },
          ik(),
        )
      ).thread;
    const widgetIn = (threadId: string, taint: TaintSource[] = []) =>
      insertWidget(t.gateway.context.db, {
        threadId,
        messageId: "m",
        spec,
        taint,
        owner: { kind: "run", runId: "r" },
      });
    return { agent, c, make, widgetIn };
  }

  it("proposes the call to the loop with the widget's taint, a visible message, and no owner words", async () => {
    const { agent, c, make, widgetIn } = await setup();
    const thread = await make();
    const taint = [{ sourceKind: "email", sender: "x@evil.example" }];
    const w = widgetIn(thread.id, taint);
    await c.call("widgets.act", { widgetId: w.id, nodeId: "send" }, ik());
    await t.gateway.context.sessions.idle();
    const turn = agent.turns[0];
    expect(turn?.proposedCall).toEqual({ tool: "email.send", input: { to: "a@b.c", draft: "d1" } });
    expect(turn?.taintSources).toEqual(taint);
    expect(turn?.ownerWords).toBe(false);
    const { messages } = await c.call<{ messages: Message[] }>("chat.history", {
      threadId: thread.id,
    });
    const user = messages.find((m) => m.role === "user");
    expect(user?.via).toBe("widget");
    expect(user?.blocks[0]).toEqual({
      type: "text",
      md: 'Run email.send with {"to":"a@b.c","draft":"d1"}',
    });
  });

  it("a clean widget starts a clean turn but still proposes through the loop", async () => {
    const { agent, c, make, widgetIn } = await setup();
    const thread = await make();
    const w = widgetIn(thread.id);
    await c.call("widgets.act", { widgetId: w.id, nodeId: "rows", itemId: "r1" }, ik());
    await t.gateway.context.sessions.idle();
    expect(agent.turns[0]?.taintSources ?? []).toEqual([]);
    expect(agent.turns[0]?.proposedCall?.tool).toBe("mail.archive");
  });

  it("cannot be asked for a different call: the request carries no tool or arguments", async () => {
    const { c, make, widgetIn } = await setup();
    const thread = await make();
    const w = widgetIn(thread.id);
    await expect(
      c.call(
        "widgets.act",
        { widgetId: w.id, nodeId: "send", tool: "shell.run", args: { cmd: "rm -rf /" } },
        ik(),
      ),
    ).rejects.toThrow();
    await expect(c.call("widgets.act", { widgetId: w.id, nodeId: "evil" }, ik())).rejects.toThrow(
      /host-owned/,
    );
    await expect(c.call("widgets.act", { widgetId: "nope", nodeId: "send" }, ik())).rejects.toThrow(
      /"code":"not_found"/,
    );
  });

  it("is rate limited to one click a second and refused while the chat is busy", async () => {
    const { agent, c, make, widgetIn } = await setup();
    agent.script([{ type: "wait", gate: "g" } as never]);
    const thread = await make();
    const w = widgetIn(thread.id);
    await c.call("widgets.act", { widgetId: w.id, nodeId: "send" }, ik());
    await expect(c.call("widgets.act", { widgetId: w.id, nodeId: "send" }, ik())).rejects.toThrow(
      /"code":"rate_limited"/,
    );
    agent.open("g");
    await t.gateway.context.sessions.idle();
  });

  it("previews what the broker would say, with the widget's taint", async () => {
    const { agent, c, make, widgetIn } = await setup();
    const seen: unknown[] = [];
    (agent as unknown as { previewCall: unknown }).previewCall = async (i: unknown) => {
      seen.push(i);
      return { decision: "ask" };
    };
    const thread = await make();
    const taint = [{ sourceKind: "web", origin: "https://evil.example" }];
    const w = widgetIn(thread.id, taint);
    const r = await c.call<{ tool: string; decision: string }>("widgets.preview", {
      widgetId: w.id,
      nodeId: "send",
    });
    expect(r).toEqual({ tool: "email.send", decision: "ask" });
    expect(seen[0]).toMatchObject({ tool: "email.send", taintSources: taint, threadId: thread.id });
    const f = await c.call<{ tool: string }>("widgets.preview", { widgetId: w.id, nodeId: "form" });
    expect(f.tool).toBe("email.compose");
  });
});
