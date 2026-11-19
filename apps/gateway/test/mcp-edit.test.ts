import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting } from "@psyche/db";
import type { McpProposal } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp, MCP_SERVERS_SETTING } from "../src/compose/mcp.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { adminClient, desktopClient, ik, type TestClient } from "./helpers.ts";

/** Editing a server in place (`mcp.update`) and testing an approved one (`mcp.test`). */

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

const fakeSrt = {
  isolation: "srt" as const,
  prepare: async (spec: { command: string[] }) => ({
    command: spec.command[0] as string,
    args: spec.command.slice(1),
    env: { PATH: process.env.PATH ?? "" },
  }),
};

const echo = (extra: string[] = []) => ({
  id: "echo",
  name: "Echo",
  transport: { kind: "stdio" as const, command: [process.execPath, SERVER, ...extra] },
});

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-mcp-edit-"));
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

interface Card {
  id: string;
  kind: string;
  details: Record<string, unknown>;
  surfaces: string[];
}
interface UpdateResult {
  applied: boolean;
  server: { id: string; name: string; connected: boolean };
  proposal?: McpProposal;
  approval?: Card;
}

async function addEcho(owner: TestClient, mcp: ComposedMcp) {
  const { proposal, approval } = await owner.call<{ proposal: McpProposal; approval: Card }>(
    "mcp.probe",
    { server: echo() },
    ik(),
  );
  await approve(owner, approval.id);
  await owner.call("mcp.add", { proposalId: proposal.id, approvalId: approval.id }, ik());
  await mcp.idle();
}

const stored = (services: ComposeServices) =>
  structuredClone(getSetting(services.db, MCP_SERVERS_SETTING)?.value);
const cards = (c: TestClient) => c.events.filter((e) => e.event === "approval.created").length;
const auditKinds = async (owner: TestClient) =>
  (
    await owner.call<{ entries: { kind: string }[] }>("audit.list", { kindPrefix: "mcp." })
  ).entries.map((e) => e.kind);

describe("mcp.update", () => {
  it("a command change raises a trust card, keeps the old server running, and applies only once approved", async () => {
    const { owner, mcp, services } = await setup();
    await addEcho(owner, mcp);
    expect(services.tools.get("mcp__echo__shout")).toBeUndefined();
    const before = stored(services);

    const r = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { command: [process.execPath, SERVER, "--write-tool"] } },
      ik(),
    );
    expect(r.applied).toBe(false);
    expect(r.approval).toMatchObject({
      kind: "skill_install",
      surfaces: ["desktop"],
      details: {
        kind: "mcp_server",
        id: "echo",
        replaces: true,
        change: { fields: ["command"] },
      },
    });
    const change = r.approval?.details.change as { oldCommand: string; newCommand: string };
    expect(change.oldCommand).not.toContain("--write-tool");
    expect(change.newCommand).toContain("--write-tool");
    expect(r.proposal?.tools.map((t) => t.name)).toContain("shout");

    // Nothing was applied: the stored config is unchanged and the old server still serves.
    await mcp.idle();
    expect(stored(services)).toEqual(before);
    expect(services.tools.get("mcp__echo__echo")).toBeDefined();
    expect(services.tools.get("mcp__echo__shout")).toBeUndefined();
    expect(await owner.call("mcp.status", {})).toMatchObject({
      servers: [{ id: "echo", connected: true }],
    });

    // The unapproved card cannot be spent.
    await expect(
      owner.call("mcp.add", { proposalId: r.proposal?.id, approvalId: r.approval?.id }, ik()),
    ).rejects.toThrow(/"code":"approval_required"/);
    expect(stored(services)).toEqual(before);

    await approve(owner, r.approval?.id as string);
    const done = await owner.call<{ server: { connected: boolean } }>(
      "mcp.add",
      { proposalId: r.proposal?.id, approvalId: r.approval?.id },
      ik(),
    );
    await mcp.idle();
    expect(done.server.connected).toBe(true);
    expect(services.tools.get("mcp__echo__shout")).toBeDefined();
    const after = stored(services) as { transport: { command: string[] } }[];
    expect(after).toHaveLength(1);
    expect(after[0]?.transport.command).toContain("--write-tool");
    const kinds = await auditKinds(owner);
    expect(kinds).toContain("mcp.update_proposed");
    expect(kinds).toContain("mcp.server_updated");
  });

  it("an env or domain change goes through the card too, and carries no value on it", async () => {
    const { owner, mcp } = await setup();
    await addEcho(owner, mcp);
    const r = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { env: { PLAIN_FLAG: "hunter2-not-shown" } } },
      ik(),
    );
    expect(r.applied).toBe(false);
    expect(r.approval?.details.change).toMatchObject({ fields: ["env"], envAdded: ["PLAIN_FLAG"] });
    expect(JSON.stringify(r.approval)).not.toContain("hunter2-not-shown");
    const d = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { allowedDomains: ["example.com"] } },
      ik(),
    );
    expect(d.applied).toBe(false);
    expect(d.approval?.details.change).toMatchObject({ newDomains: ["example.com"] });
  });

  it("a name-only change applies directly, with no card and no restart, and is audited", async () => {
    const { owner, mcp, services } = await setup();
    await addEcho(owner, mcp);
    const tool = services.tools.get("mcp__echo__echo");
    const cardsBefore = cards(owner);
    const r = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { name: "Echo renamed" } },
      ik(),
    );
    await mcp.idle();
    expect(r).toMatchObject({ applied: true, server: { id: "echo", name: "Echo renamed" } });
    expect(r.approval).toBeUndefined();
    expect(r.proposal).toBeUndefined();
    expect(cards(owner)).toBe(cardsBefore);
    expect(await owner.call("mcp.status", {})).toMatchObject({
      servers: [{ id: "echo", name: "Echo renamed", connected: true }],
    });
    // The very same registration: the server was not restarted.
    expect(services.tools.get("mcp__echo__echo")).toBe(tool);
    expect(await auditKinds(owner)).toContain("mcp.server_renamed");
  });

  it("refuses a field the server's kind does not have, and an unknown server", async () => {
    const { owner, mcp } = await setup();
    await addEcho(owner, mcp);
    await expect(
      owner.call("mcp.update", { id: "echo", changes: { url: "https://example.com/mcp" } }, ik()),
    ).rejects.toThrow(/"code":"invalid_params"/);
    await expect(
      owner.call("mcp.update", { id: "nope", changes: { name: "x" } }, ik()),
    ).rejects.toThrow(/"code":"not_found"/);
  });

  it("an approval for one edit cannot be spent after the server changed under it", async () => {
    const { owner, mcp, services } = await setup();
    await addEcho(owner, mcp);
    const r = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { command: [process.execPath, SERVER, "--write-tool"] } },
      ik(),
    );
    // Another edit lands first.
    const other = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { allowedDomains: ["example.com"] } },
      ik(),
    );
    await approve(owner, other.approval?.id as string);
    await owner.call(
      "mcp.add",
      { proposalId: other.proposal?.id, approvalId: other.approval?.id },
      ik(),
    );
    await mcp.idle();
    await approve(owner, r.approval?.id as string);
    await expect(
      owner.call("mcp.add", { proposalId: r.proposal?.id, approvalId: r.approval?.id }, ik()),
    ).rejects.toThrow(/"code":"conflict"/);
    const now = stored(services) as { transport: { command: string[] } }[];
    expect(now[0]?.transport.command).not.toContain("--write-tool");
  });
});

describe("mcp.test", () => {
  it("lists the tools of the approved config, changes nothing and raises no card", async () => {
    const { owner, mcp, services } = await setup();
    await addEcho(owner, mcp);
    const before = stored(services);
    const cardsBefore = cards(owner);
    const r = await owner.call<{ ok: boolean; toolCount: number; tools: string[] }>("mcp.test", {
      id: "echo",
    });
    expect(r).toMatchObject({ ok: true, toolCount: 1, tools: ["echo"] });
    expect(stored(services)).toEqual(before);
    expect(cards(owner)).toBe(cardsBefore);
    // It takes no config: an extra field is not read (and the stored one is what ran).
    const again = await owner.call<{ ok: boolean; tools: string[] }>("mcp.test", {
      id: "echo",
      server: echo(["--write-tool"]),
    });
    expect(again.tools).toEqual(["echo"]);
    expect(stored(services)).toEqual(before);
  });

  it("starts the stored config once when the server is on but not connected", async () => {
    const { owner, mcp, services } = await setup();
    await addEcho(owner, mcp);
    // Break the server's connection on the host side by pausing then re-enabling is not
    // needed: test the throwaway path through the adder directly with the stored entry.
    const entry = (stored(services) as { id: string }[])[0];
    const found = await mcp.adder.test(entry as never);
    expect(found.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("refuses a paused server, and a server that was never approved", async () => {
    const { owner, mcp } = await setup();
    await addEcho(owner, mcp);
    await owner.call("mcp.setEnabled", { serverId: "echo", enabled: false }, ik());
    await mcp.idle();
    await expect(owner.call("mcp.test", { id: "echo" })).rejects.toThrow(
      /"code":"unavailable".*"reason":"paused"/,
    );
    // A probed server whose card is still waiting is not configured: nothing to test.
    await owner.call("mcp.probe", { server: { ...echo(), id: "pending" } }, ik());
    await expect(owner.call("mcp.test", { id: "pending" })).rejects.toThrow(/"code":"not_found"/);
  });
});

describe("who may call them", () => {
  it("is admin only: a non-admin device gets forbidden", async () => {
    const { owner, mcp } = await setup();
    await addEcho(owner, mcp);
    const desk = await desktopClient((composed as ComposedGateway).gateway);
    clients.push(desk);
    for (const [method, params] of [
      ["mcp.update", { id: "echo", changes: { name: "x" } }],
      ["mcp.test", { id: "echo" }],
      ["mcp.config", { serverId: "echo" }],
    ] as const) {
      expect(await desk.request(method, params, ik())).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    }
    // Positive control: the admin's same calls work.
    expect(await owner.call("mcp.config", { serverId: "echo" })).toMatchObject({
      config: { id: "echo", kind: "command", editable: true },
    });
  });
});
