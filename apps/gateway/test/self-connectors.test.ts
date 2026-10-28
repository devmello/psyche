import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { ToolRunContext } from "@psyche/agent-core";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp } from "../src/compose/mcp.ts";
import {
  commandFor,
  configFor,
  LITE,
  LITE_SOURCE,
  MAX_FILE_BYTES,
  MAX_FILES,
  parseManifest,
  safeRel,
  selfConnectorStore,
  treeDiff,
  treeHash,
} from "../src/compose/self-connectors.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** Connectors Psyche writes for itself: files → test → card → enabled, update, taint, limits. */

/** Stands in for srt: runs the command unwrapped in its cwd, but reports srt isolation. */
const fakeSrt = {
  isolation: "srt" as const,
  prepare: async (spec: { command: string[]; cwd?: string }) => ({
    command: spec.command[0] as string,
    args: spec.command.slice(1),
    env: { PATH: process.env.PATH ?? "" },
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
  }),
};

const SERVER = `import { serve } from "./mcp-lite.mjs";
serve({ name: "notes", tools: [{
  name: "shout", description: "Upper-case text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  annotations: { readOnlyHint: true },
  handler: async ({ text }) => String(text).toUpperCase(),
}] });
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
  home = mkdtempSync(join(tmpdir(), "psyche-self-conn-"));
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
        mcp = composeMcp(s, { hostOptions: { launcher: fakeSrt } });
        return mcp;
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return { owner, mcp: mcp as ComposedMcp, services: services as ComposeServices };
}

const ctx = (extra: Partial<ToolRunContext> = {}): ToolRunContext => ({
  callId: "call_1",
  threadId: "thr_1",
  runId: "run_1",
  taint: false,
  permissionMode: "balanced",
  mode: "attended",
  signal: new AbortController().signal,
  onUpdate: () => undefined,
  ...extra,
});

async function call(
  services: ComposeServices,
  name: string,
  params: unknown,
  c: ToolRunContext = ctx(),
) {
  const tool = services.tools.get(name) as unknown as {
    run(p: unknown, c: ToolRunContext): Promise<{ output: Record<string, unknown> }>;
  };
  return (await tool.run(params, c)).output;
}

interface Card {
  id: string;
  kind: string;
  surfaces: string[];
  scopesOffered: string[];
  taint: boolean;
  details: Record<string, unknown>;
}

/** The next card the Gateway publishes, then the owner's approval of it. */
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

async function approve(owner: TestClient, approvalId: string) {
  const { answerToken } = await owner.call<{ answerToken?: string }>("approvals.get", {
    approvalId,
  });
  await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
  await owner.call("approvals.answer", {
    approvalId,
    answerToken,
    decision: "approve",
    scope: "once",
  });
}

async function made(services: ComposeServices, id = "notes", domains: string[] = []) {
  await call(services, "connector_create", {
    id,
    name: "Notes tools",
    description: "Upper-cases text",
    allowedDomains: domains,
  });
  await call(services, "connector_write_file", { id, path: "server.mjs", content: SERVER });
}

describe("agent-made connectors", () => {
  it("create → test → card with files and command → approve → running, unknown tier", async () => {
    const { owner, mcp, services } = await setup();
    await made(services, "notes", ["api.example.com"]);

    const tested = await call(services, "connector_test", { id: "notes" });
    expect(tested.tools).toMatchObject([{ name: "shout", sideEffect: "read" }]);
    expect(String(tested.toolsListHash)).toMatch(/^sha256:/);
    // The test registers nothing and reaches no network.
    expect(services.tools.get("mcp__notes__shout")).toBeUndefined();
    expect(await owner.call("mcp.status", {})).toMatchObject({ servers: [] });

    const seen = cardsSeen(owner);
    const pending = call(services, "connector_register", { id: "notes" });
    const card = await nextCard(owner, seen);
    expect(card).toMatchObject({
      kind: "skill_install",
      surfaces: ["desktop"],
      scopesOffered: ["once"],
      taint: false,
      details: {
        kind: "mcp_server",
        madeBy: "psyche",
        change: "create",
        command: "node server.mjs",
        isolation: "srt",
        network: ["api.example.com"],
        requestedNetwork: ["api.example.com"],
      },
    });
    const files = card.details.files as { path: string; lines: string[] }[];
    expect(files.map((f) => f.path).sort()).toEqual(["manifest.json", LITE, "server.mjs"]);
    expect(files.find((f) => f.path === "server.mjs")?.lines.join("\n")).toContain("toUpperCase");
    expect(card.details.tools).toContainEqual("read shout");
    // Nothing is registered or stored before the owner answers.
    expect(services.tools.get("mcp__notes__shout")).toBeUndefined();

    await approve(owner, card.id);
    expect(await pending).toMatchObject({ status: "enabled", tools: ["shout"] });
    await mcp.idle();
    expect(services.tools.get("mcp__notes__shout")).toBeDefined();
    const { servers } = await owner.call<{
      servers: {
        id: string;
        trust: string;
        madeBy?: string;
        version?: string;
        connected: boolean;
      }[];
    }>("mcp.status", {});
    expect(servers).toMatchObject([
      { id: "notes", trust: "unknown", madeBy: "psyche", version: "1", connected: true },
    ]);

    const files2 = await owner.call<{ files: { path: string }[]; modified: boolean }>(
      "mcp.files.read",
      { serverId: "notes" },
    );
    expect(files2.modified).toBe(false);
    expect(files2.files.map((f) => f.path)).toContain("server.mjs");
  }, 60_000);

  it("an update shows a diff, stops the old code, and revokes grants when replaced", async () => {
    const { owner, mcp, services } = await setup();
    await made(services);
    let seen = cardsSeen(owner);
    const first = call(services, "connector_register", { id: "notes" });
    await approve(owner, (await nextCard(owner, seen)).id);
    await first;
    await mcp.idle();
    const revoke = vi.spyOn(services.rawBroker, "revokeMcpGrants");

    // No change: nothing to approve.
    await expect(call(services, "connector_update", { id: "notes" })).rejects.toThrow(
      /nothing changed/,
    );

    await call(services, "connector_write_file", {
      id: "notes",
      path: "server.mjs",
      content: SERVER.replace("toUpperCase", "toLowerCase").replace("shout", "whisper"),
    });
    await mcp.idle();
    // Changed code never runs without a new card.
    expect(services.tools.get("mcp__notes__shout")).toBeUndefined();
    expect(
      (await owner.call<{ modified: boolean }>("mcp.files.read", { serverId: "notes" })).modified,
    ).toBe(true);

    seen = cardsSeen(owner);
    const second = call(services, "connector_update", { id: "notes" });
    const card = await nextCard(owner, seen);
    expect(card.details).toMatchObject({ change: "update", version: "2", previousVersion: "1" });
    const diff = card.details.diff as string[];
    expect(diff).toContain("--- a/server.mjs");
    expect(diff).toContain('-  name: "shout", description: "Upper-case text.",');
    expect(diff.some((l) => l.startsWith("+") && l.includes("whisper"))).toBe(true);
    await approve(owner, card.id);
    expect(await second).toMatchObject({ status: "enabled", tools: ["whisper"] });
    await mcp.idle();
    expect(services.tools.get("mcp__notes__whisper")).toBeDefined();
    expect(revoke).toHaveBeenCalledWith("notes", "removed");
  }, 60_000);

  it("a tainted turn's card offers once only and says so", async () => {
    const { owner, services } = await setup();
    await made(services);
    const seen = cardsSeen(owner);
    const controller = new AbortController();
    const pending = call(
      services,
      "connector_register",
      { id: "notes" },
      ctx({
        taint: true,
        taintSources: [{ sourceKind: "web", origin: "https://evil.example" }] as never,
        signal: controller.signal,
      }),
    ).catch(() => undefined);
    const card = await nextCard(owner, seen);
    expect(card).toMatchObject({ scopesOffered: ["once"], taint: true });
    controller.abort();
    await pending;
  }, 30_000);

  it("refuses an unattended turn and a non-owner requester", async () => {
    const { services } = await setup();
    await made(services);
    await expect(
      call(services, "connector_register", { id: "notes" }, ctx({ mode: "unattended" })),
    ).rejects.toThrow(/owner's approval card/);
    await expect(
      call(
        services,
        "connector_write_file",
        { id: "notes", path: "a.txt", content: "x" },
        ctx({ requester: { role: "guest" } as never }),
      ),
    ).rejects.toThrow(/only the owner/);
  });

  it("never upgrades the tier and does not start a tampered entry", async () => {
    const { owner, mcp, services } = await setup();
    await made(services);
    const store = selfConnectorStore(home);
    const tree = await store.settle("notes");
    const m = store.manifestOf(tree);
    const good = configFor("notes", m, store.dirOf("notes"), treeHash(tree));
    const { setSetting } = await import("@psyche/db");
    const put = async (entry: unknown) => {
      const saved = setSetting(services.db, "mcp.servers", [entry]);
      services.publish("settings.changed", { entries: [saved] });
      await mcp.idle();
      const { servers } = await owner.call<{ servers: { trust: string; connected: boolean }[] }>(
        "mcp.status",
        {},
      );
      return servers[0];
    };
    // A claimed `verified` tier with an official-looking command stays `unknown`, and a command
    // that differs from the manifest's does not start.
    expect(
      await put({
        ...good,
        trust: "verified",
        transport: { kind: "stdio", command: ["npx", "-y", "@modelcontextprotocol/server-time"] },
      }),
    ).toMatchObject({ trust: "unknown", connected: false });
    // The approved tree starts; a changed file keeps it from starting.
    expect(await put(good)).toMatchObject({ trust: "unknown", connected: true });
    await call(services, "connector_write_file", { id: "notes", path: "extra.txt", content: "x" });
    await mcp.idle();
    expect(await put(good)).toMatchObject({ connected: false });
  }, 30_000);

  it("removes the entry, the code and the snapshot", async () => {
    const { owner, mcp, services } = await setup();
    await made(services);
    const seen = cardsSeen(owner);
    const reg = call(services, "connector_register", { id: "notes" });
    await approve(owner, (await nextCard(owner, seen)).id);
    await reg;
    await mcp.idle();
    expect(await call(services, "connector_remove", { id: "notes" })).toMatchObject({ ok: true });
    await mcp.idle();
    expect(services.tools.get("mcp__notes__shout")).toBeUndefined();
    expect(await selfConnectorStore(home).exists("notes")).toBe(false);
    expect(await owner.call("mcp.status", {})).toMatchObject({ servers: [] });
  }, 60_000);

  it("the owner edits a file: the server stops and a diff card awaits approval", async () => {
    const { owner, mcp, services } = await setup();
    await made(services);
    let seen = cardsSeen(owner);
    const reg = call(services, "connector_register", { id: "notes" });
    await approve(owner, (await nextCard(owner, seen)).id);
    await reg;
    await mcp.idle();

    seen = cardsSeen(owner);
    const edited = await owner.call<{
      proposal: { id: string };
      approval: { id: string; details: { diff: string[]; change: string } };
    }>(
      "mcp.files.write",
      { serverId: "notes", path: "server.mjs", content: SERVER.replace("Upper-case", "Loud") },
      ik(),
    );
    expect(edited.approval.details.change).toBe("update");
    expect(edited.approval.details.diff.some((l) => l.includes("Loud"))).toBe(true);
    await mcp.idle();
    expect(services.tools.get("mcp__notes__shout")).toBeUndefined();
    await approve(owner, edited.approval.id);
    await owner.call(
      "mcp.add",
      { proposalId: edited.proposal.id, approvalId: edited.approval.id },
      ik(),
    );
    expect(services.tools.get("mcp__notes__shout")).toBeDefined();
  }, 60_000);

  it("only registry URLs can be suggested as remote connectors", async () => {
    const { services } = await setup();
    await expect(
      call(services, "connector_propose_remote", { url: "https://evil.example/mcp" }),
    ).rejects.toThrow(/connector registry/);
  });
});

describe("agent-made connector files", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "psyche-self-store-"));

  it("rejects traversal, hidden, odd and reserved paths", async () => {
    for (const p of [
      "../x.mjs",
      "/etc/passwd",
      "a/../b.mjs",
      ".env",
      "a\\b.mjs",
      "x.sh",
      "a//b.mjs",
      "",
    ]) {
      expect(() => safeRel(p), p).toThrow();
    }
    expect(safeRel("lib/util.mjs")).toBe("lib/util.mjs");
    const dir = tmp();
    try {
      const store = selfConnectorStore(dir);
      await store.create("demo", parseManifest(JSON.stringify(manifest())));
      await expect(store.write("demo", LITE, "x")).rejects.toThrow(/provided by Psyche/);
      await expect(store.write("demo", "manifest.json", "{}")).rejects.toThrow(/managed/);
      await expect(store.write("../demo", "a.txt", "x")).rejects.toThrow(/id must/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps files and bytes, and refuses symlinks", async () => {
    const dir = tmp();
    try {
      const store = selfConnectorStore(dir);
      await store.create("demo", parseManifest(JSON.stringify(manifest())));
      await expect(store.write("demo", "big.txt", "x".repeat(MAX_FILE_BYTES + 1))).rejects.toThrow(
        /larger than/,
      );
      for (let i = 0; i < MAX_FILES - 2; i++) await store.write("demo", `f${i}.txt`, "x");
      await expect(store.write("demo", "one-too-many.txt", "x")).rejects.toThrow(/more than/);
      writeFileSync(join(dir, "outside.txt"), "secret");
      symlinkSync(join(dir, "outside.txt"), join(dir, "agent-connectors", "demo", "link.txt"));
      await expect(store.load("demo")).rejects.toThrow(/symlink/);
      mkdirSync(join(dir, "agent-connectors", "x"), { recursive: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives the command from the manifest and diffs trees", () => {
    const m = parseManifest(JSON.stringify(manifest()));
    expect(commandFor(m)).toEqual(["node", "server.mjs"]);
    expect(commandFor({ ...m, runtime: "python", entry: "s.py" })).toEqual([
      "uv",
      "run",
      "--script",
      "s.py",
    ]);
    const a = new Map([["a.txt", "one\ntwo\nthree"]]);
    const b = new Map([
      ["a.txt", "one\n2\nthree"],
      ["b.txt", "new"],
    ]);
    expect(treeDiff(a, b)).toEqual([
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@",
      " one",
      "-two",
      "+2",
      " three",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@",
      "+new",
    ]);
  });

  it("the helper answers initialize, tools/list and tools/call", async () => {
    const dir = tmp();
    try {
      const file = join(dir, LITE);
      writeFileSync(file, LITE_SOURCE);
      const { serve } = (await import(pathToFileURL(file).href)) as {
        serve(o: unknown): unknown;
      };
      const input = new PassThrough();
      const output = new PassThrough();
      const lines: Record<string, unknown>[] = [];
      output.on("data", (d: Buffer) => {
        for (const l of d.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(l));
      });
      serve({
        name: "t",
        input,
        output,
        tools: [{ name: "up", handler: async ({ s }: { s: string }) => s.toUpperCase() }],
      });
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`,
      );
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "up", arguments: { s: "a" } } })}\n`,
      );
      await vi.waitFor(() => expect(lines.length).toBe(3));
      expect(lines[0]).toMatchObject({ id: 1, result: { protocolVersion: "2025-11-25" } });
      expect(lines[1]).toMatchObject({ id: 2, result: { tools: [{ name: "up" }] } });
      expect(lines[2]).toMatchObject({ id: 3, result: { content: [{ text: "A" }] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const manifest = () => ({
  madeBy: "psyche",
  name: "Demo",
  description: "",
  runtime: "node",
  entry: "server.mjs",
  version: "1",
  createdAt: 1,
  allowedDomains: [],
});
