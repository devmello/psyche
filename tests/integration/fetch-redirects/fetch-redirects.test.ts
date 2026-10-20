import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import type { ConnectorRegistry, PinnedRequest, Transport } from "@psyche/connectors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeConnectors } from "../../../apps/gateway/src/compose/connectors.ts";
import type { ComposeServices } from "../../../apps/gateway/src/compose/services.ts";
import { type PartsSkeleton, startWithParts } from "../google/harness.ts";
import type { Client } from "../walking-skeleton/harness.ts";
import { MAIN, ScriptedModel, UTILITY } from "../walking-skeleton/scripted-model.ts";

/**
 * Issue #72 end to end: the composed Gateway's `web_fetch` follows a redirect only into the
 * Task's approved origins. https://a.example/start redirects to https://b.example/page; the hop
 * is refused until the owner grants b.example to this Task (a `task`-scoped `new_origin` grant
 * answered on the desktop), and a grant for another Task does not count.
 */

const ID = "web-fetch-1";
const TOOL = `mcp__${ID}__web_fetch`;
const TASK = "task_redirects";

const contacted: string[] = [];
const pages: Record<string, { status: number; headers: Record<string, string>; body?: string }> = {
  "https://a.example/start": { status: 302, headers: { location: "https://b.example/page" } },
  "https://b.example/page": {
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "b page",
  },
};
const transport: Transport = async (req: PinnedRequest) => {
  contacted.push(req.url.href);
  const page = pages[req.url.href] ?? {
    status: 404,
    headers: { "content-type": "text/plain" },
    body: "",
  };
  return {
    status: page.status,
    headers: page.headers,
    body: (async function* () {
      if (page.body !== undefined) yield new TextEncoder().encode(page.body);
    })(),
    close: () => undefined,
  };
};

let sk: PartsSkeleton;
let c: Client;
let services: ComposeServices;
let registry: ConnectorRegistry;
let threadId: string;

function fetchVia(taskId: string, callId: string) {
  const reg = services.tools.get(TOOL) as AgentToolRegistration | undefined;
  if (reg?.run === undefined) throw new Error(`${TOOL} is not registered`);
  const ctx: ToolRunContext = {
    callId,
    threadId,
    runId: "run_72",
    taskId,
    taint: false,
    permissionMode: "balanced",
    mode: "attended",
    signal: new AbortController().signal,
    onUpdate: () => {},
  };
  return reg.run({ url: "https://a.example/start" }, ctx) as Promise<{
    output: Record<string, unknown>;
  }>;
}

/** The owner allows b.example for one Task on the desktop card. */
async function grantOrigin(origin: string, taskId: string) {
  const issued = await services.broker.requestApproval({
    kind: "new_origin",
    summary: `Open ${origin}`,
    details: { url: origin, origin },
    bindingHash: `sha256:${"0".repeat(64)}`,
    grantKey: `new_origin:${origin}`,
    requestedBy: { runId: null, taskId, threadId, toolCallId: `grant_${taskId}` },
    sideEffect: "read",
    targetKind: "origin",
    target: { kind: "origin", value: origin },
    surfaces: ["desktop"],
    taint: false,
  });
  const { answerToken } = await c.call<{ answerToken?: string }>("approvals.get", {
    approvalId: issued.approval.id,
  });
  await new Promise((r) => setTimeout(r, 600));
  await c.call("approvals.answer", {
    approvalId: issued.approval.id,
    answerToken,
    decision: "approve",
    scope: "task",
  });
}

beforeAll(async () => {
  sk = await startWithParts({
    model: { provider: new ScriptedModel(), model: MAIN, utilityModel: UTILITY },
    timeZone: "America/Los_Angeles",
    parts: [
      (s) => {
        services = s;
        const part = composeConnectors(s, {
          web: {
            fetch: {
              transport,
              lookup: async () => [{ address: "93.184.215.14", family: 4 }],
            },
          },
          syncIntervalMs: 0,
          newId: () => ID,
        });
        registry = part.registry;
        return part;
      },
    ],
  });
  c = sk.client;
  const { thread } = await c.call<{ thread: { id: string } }>(
    "threads.create",
    { kind: "main" },
    true,
  );
  threadId = thread.id;
  await registry.connect({ catalogueId: "web-fetch", scopeMode: "read", config: {} });
});

afterAll(async () => {
  await sk?.stop();
});

describe("web_fetch redirect hops through the composed Gateway (#72)", () => {
  it("refuses a redirect out of the Task's origins before contacting the new host", async () => {
    await expect(fetchVia(TASK, "c1")).rejects.toMatchObject({
      code: "policy_denied",
      details: { reason: "redirect_not_allowlisted", origin: "https://b.example" },
    });
    expect(contacted).toEqual(["https://a.example/start"]);
  });

  it("follows the hop once the owner grants that origin to this Task", async () => {
    await grantOrigin("https://b.example", TASK);
    contacted.length = 0;
    const out = await fetchVia(TASK, "c2");
    expect(out.output).toMatchObject({ url: "https://b.example/page", markdown: "b page" });
    expect(contacted).toEqual(["https://a.example/start", "https://b.example/page"]);
  });

  it("a grant for another Task does not open the hop", async () => {
    contacted.length = 0;
    await expect(fetchVia("task_other", "c3")).rejects.toMatchObject({
      details: { reason: "redirect_not_allowlisted" },
    });
    expect(contacted).toEqual(["https://a.example/start"]);
  });
});
