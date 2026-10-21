import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpProposal } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp } from "../src/compose/mcp.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** #529: adding an MCP server from Settings → MCP: sandboxed probe, trust card, add, remove. */

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

/** Stands in for srt: runs the fixture unwrapped, but reports srt isolation. */
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

async function setup(withLauncher = true) {
  home = mkdtempSync(join(tmpdir(), "psyche-mcp-add-"));
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
        mcp = composeMcp(s, withLauncher ? { hostOptions: { launcher: fakeSrt } } : {});
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

interface ProbeResult {
  proposal: McpProposal;
  approval: { id: string; kind: string; details: Record<string, unknown>; surfaces: string[] };
}

describe("Settings → MCP add flow (#529)", () => {
  it("probes in the sandbox without registering anything, then adds behind the trust card", async () => {
    const { owner, mcp, services } = await setup();
    const { proposal, approval } = await owner.call<ProbeResult>(
      "mcp.probe",
      { server: echo() },
      ik(),
    );
    expect(proposal).toMatchObject({
      server: { id: "echo" },
      isolation: "srt",
      network: { reaches: false, hosts: [] },
    });
    expect(proposal.tools.map((t) => t.name)).toContain("echo");
    expect(proposal.toolsListHash).toMatch(/^sha256:/);
    expect(approval).toMatchObject({
      kind: "skill_install",
      details: { kind: "mcp_server", id: "echo", isolation: "srt" },
    });
    expect(approval.surfaces).toEqual(["desktop"]);
    expect((approval.details.tools as string[]).some((t) => t.endsWith(" echo"))).toBe(true);
    // Nothing reached the agent or the setting during the probe.
    expect(services.tools.get("mcp__echo__echo")).toBeUndefined();
    expect(await owner.call("mcp.status", {})).toMatchObject({ servers: [] });

    // Without the answered card, adding is refused.
    await expect(
      owner.call("mcp.add", { proposalId: proposal.id, approvalId: approval.id }, ik()),
    ).rejects.toThrow(/"code":"approval_required"/);

    await approve(owner, approval.id);
    const added = await owner.call<{ server: { id: string; connected: boolean } }>(
      "mcp.add",
      { proposalId: proposal.id, approvalId: approval.id },
      ik(),
    );
    expect(added.server).toMatchObject({ id: "echo", trust: "unknown", connected: true });
    expect(services.tools.get("mcp__echo__echo")).toBeDefined();
    // The card is spent and the proposal gone.
    await expect(
      owner.call("mcp.add", { proposalId: proposal.id, approvalId: approval.id }, ik()),
    ).rejects.toThrow(/"code":"approval_expired"/);
    // The id is taken now.
    await expect(owner.call("mcp.probe", { server: echo() }, ik())).rejects.toThrow(
      /"code":"conflict"/,
    );

    await owner.call("mcp.remove", { serverId: "echo" }, ik());
    await mcp.idle();
    expect(services.tools.get("mcp__echo__echo")).toBeUndefined();
    expect(await owner.call("mcp.status", {})).toMatchObject({ servers: [] });
  });

  it("shows poisoned descriptions on the card and keeps those tools off", async () => {
    const { owner } = await setup();
    const { proposal, approval } = await owner.call<ProbeResult>(
      "mcp.probe",
      { server: echo(["--poisoned"]) },
      ik(),
    );
    const lookup = proposal.tools.find((t) => t.name === "lookup");
    expect(lookup).toMatchObject({ blocked: true });
    expect(lookup?.warnings.length).toBeGreaterThan(0);
    expect(approval.details.tools).toContainEqual(
      expect.stringMatching(/lookup \(off: suspicious description\)$/),
    );
  });

  it("refuses a command server when no sandbox exists, and an approval of another card", async () => {
    const { owner } = await setup(false);
    await expect(owner.call("mcp.probe", { server: echo() }, ik())).rejects.toThrow(
      /"code":"unavailable".*"reason":"no_launcher"/,
    );
    await expect(
      owner.call("mcp.add", { proposalId: "mcpp_nope", approvalId: "ap_nope" }, ik()),
    ).rejects.toThrow(/"code":"approval_expired"/);
  });
});
