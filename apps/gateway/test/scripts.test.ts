import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, DeferredToolsApi, ToolRunContext } from "@psyche/agent-core";
import type { ChangeInput } from "@psyche/audit";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp } from "../src/compose/mcp.ts";
import { scriptTools, wrapperSource } from "../src/compose/scripts.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { adminClient, type TestClient } from "./helpers.ts";

/** Build and run: a script runs after one card with its code; a kept one becomes a connector. */

/** Stands in for srt: drops `--settings <file> --` and runs the rest. */
const fakeSrtLauncher = {
  isolation: "srt" as const,
  prepare: async (spec: { command: string[]; cwd?: string }) => ({
    command: spec.command[0] as string,
    args: spec.command.slice(1),
    env: { PATH: process.env.PATH ?? "" },
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
  }),
};

const SUM = `let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const { a, b } = JSON.parse(s);
  process.stdout.write(String(a + b));
});
`;

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-scripts-"));
  const srtPath = join(home, "fake-srt");
  writeFileSync(srtPath, '#!/bin/sh\nshift 3\nexec "$@"\n');
  chmodSync(srtPath, 0o755);
  let mcp: ComposedMcp | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) => {
        services = s;
        mcp = composeMcp(s, { hostOptions: { launcher: fakeSrtLauncher } });
        return mcp;
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  const s = services as ComposeServices;
  const records: ChangeInput[] = [];
  const tools = scriptTools({
    record: (c) => records.push(c),
    services: s,
    srt: { resolve: async () => ({ path: srtPath }) },
    vault: { redact: (t) => t },
  });
  const tool = (name: string) => tools.find((t) => t.spec.name === name) as AgentToolRegistration;
  const run = async (name: string, p: unknown, c: ToolRunContext) =>
    (await (tool(name).run as NonNullable<AgentToolRegistration["run"]>)(p, c)) as {
      output: Record<string, unknown>;
      provenance: string;
      isError?: boolean;
    };
  return { owner, services: s, mcp: mcp as ComposedMcp, run, records };
}

function ctx(extra: Partial<ToolRunContext> = {}) {
  const loaded: string[] = [];
  const deferredTools: DeferredToolsApi = {
    deferred: () => [],
    load: (names) => {
      loaded.push(...names);
      return { loaded: [...names], already: [], unknown: [] };
    },
  };
  const c = {
    callId: "call_1",
    threadId: "thr_1",
    runId: "run_1",
    taint: false,
    permissionMode: "balanced",
    mode: "attended",
    signal: new AbortController().signal,
    onUpdate: () => undefined,
    turn: { deferredTools },
    ...extra,
  } as unknown as ToolRunContext;
  return { c, loaded };
}

interface Card {
  id: string;
  kind: string;
  scopesOffered: string[];
  surfaces: string[];
  taint: boolean;
  details: Record<string, unknown>;
}

async function nextCard(owner: TestClient, seen: number): Promise<Card> {
  const until = Date.now() + 15_000;
  while (owner.events.filter((e) => e.event === "approval.created").length <= seen) {
    if (Date.now() > until) throw new Error("no approval card");
    await new Promise((r) => setTimeout(r, 20));
  }
  const all = owner.events.filter((e) => e.event === "approval.created");
  return ((all[seen] as { payload: unknown }).payload as { approval: Card }).approval;
}
const cardsSeen = (owner: TestClient) =>
  owner.events.filter((e) => e.event === "approval.created").length;

async function answer(owner: TestClient, approvalId: string, decision: "approve" | "deny") {
  const { answerToken } = await owner.call<{ answerToken?: string }>("approvals.get", {
    approvalId,
  });
  await new Promise((r) => setTimeout(r, 450));
  await owner.call("approvals.answer", {
    approvalId,
    answerToken,
    decision,
    ...(decision === "approve" ? { scope: "once" } : {}),
  });
}

/** Runs the sum script through its card, answered with `decision`. */
async function sum(
  env: Awaited<ReturnType<typeof setup>>,
  decision: "approve" | "deny",
  c: ToolRunContext,
) {
  const seen = cardsSeen(env.owner);
  const pending = env.run(
    "run_script",
    { language: "node", code: SUM, purpose: "add two numbers", input: { a: 2, b: 3 } },
    c,
  );
  const card = await nextCard(env.owner, seen);
  await answer(env.owner, card.id, decision);
  return { card, result: await pending };
}

describe("run_script (build and run in the same turn)", () => {
  it("shows the code on one card, runs it sandboxed after approval, output untrusted", async () => {
    const env = await setup();
    const { card, result } = await sum(env, "approve", ctx().c);
    expect(card).toMatchObject({
      kind: "skill_install",
      surfaces: ["desktop"],
      scopesOffered: ["once"],
      taint: false,
      details: { kind: "script_run", language: "node", network: [] },
    });
    expect(String(card.details.input)).toBe('{"a":2,"b":3}');
    const [file] = card.details.files as { path: string; lines: string[] }[];
    expect(file?.path).toBe("main.mjs");
    expect(file?.lines.join("\n")).toBe(SUM);
    expect(result.provenance).toBe("untrusted");
    expect(result.output).toMatchObject({ exitCode: 0, stdout: "5", runs: 1 });
    expect(result.output.hint).toBeUndefined();
    // The run is in the change log (#985) with its approval and the code that ran.
    expect(env.records).toMatchObject([
      {
        category: "command",
        tool: "run_script",
        action: "run",
        approvalId: card.id,
        after: SUM,
        outcome: "ok",
        threadId: "thr_1",
      },
    ]);
    // Run again: it suggests keeping it.
    const again = await sum(env, "approve", ctx().c);
    expect(String(again.result.output.hint)).toContain("save_script_as_tool");
  }, 60_000);

  it("a tainted turn's card is flagged and once only; a denial runs nothing", async () => {
    const env = await setup();
    const { c } = ctx({
      taint: true,
      taintSources: [{ sourceKind: "web", origin: "https://example.com" }] as never,
    });
    const { card, result } = await sum(env, "deny", c);
    expect(card.taint).toBe(true);
    expect(card.scopesOffered).toEqual(["once"]);
    expect(String(card.details.tainted)).toContain("untrusted content");
    expect(result.output).toMatchObject({ status: "denied" });
    expect(result.output.stdout).toBeUndefined();
    expect(env.records).toEqual([]);
  }, 60_000);

  it("refuses unattended runs and other requesters before any card", async () => {
    const env = await setup();
    await expect(
      env.run(
        "run_script",
        { language: "node", code: SUM, purpose: "x y z" },
        ctx({ mode: "unattended" }).c,
      ),
    ).rejects.toThrow(/owner's card/);
    await expect(
      env.run(
        "run_script",
        { language: "node", code: SUM, purpose: "x y z" },
        ctx({ requester: { role: "contact" } as never }).c,
      ),
    ).rejects.toThrow(/owner/);
  }, 60_000);

  it("save_script_as_tool keeps it as a connector of its own, loaded on approval", async () => {
    const env = await setup();
    const { result } = await sum(env, "approve", ctx().c);
    const { c, loaded } = ctx();
    const seen = cardsSeen(env.owner);
    const pending = env.run(
      "save_script_as_tool",
      {
        scriptId: result.output.scriptId,
        id: "adder",
        name: "Adder",
        toolName: "add",
        description: "Adds a and b.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
        },
      },
      c,
    );
    const card = await nextCard(env.owner, seen);
    expect(card.details).toMatchObject({
      kind: "mcp_server",
      madeBy: "psyche",
      command: "node server.mjs",
    });
    const files = (card.details.files as { path: string }[]).map((f) => f.path).sort();
    expect(files).toEqual(["manifest.json", "mcp-lite.mjs", "script.mjs", "server.mjs"]);
    await answer(env.owner, card.id, "approve");
    expect((await pending).output).toMatchObject({ status: "enabled", tool: "mcp__adder__add" });
    await env.mcp.idle();
    const registered = env.services.tools.get("mcp__adder__add");
    expect(registered).toBeDefined();
    expect(loaded).toEqual(["mcp__adder__add"]);
    const out = await registered?.execute(
      "c9",
      { a: 4, b: 5 },
      new AbortController().signal,
      () => undefined,
    );
    expect(JSON.stringify(out?.output)).toContain("9");
  }, 60_000);

  it("the wrapper quotes everything it embeds", () => {
    const src = wrapperSource({
      name: "x",
      tool: "t",
      description: 'quote " and `backtick` ${x}',
      inputSchema: { type: "object" },
      script: "script.py",
      interpreter: "/usr/bin/python3",
    });
    expect(src).toContain(JSON.stringify('quote " and `backtick` ${x}'));
    expect(src).toContain('const runner = "/usr/bin/python3"');
  });
});
