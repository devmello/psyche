import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting, setSetting } from "@psyche/db";
import type { McpProposal } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

// Each test starts a Gateway and sandboxed child processes; a loaded Mac needs more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp, MCP_SERVERS_SETTING } from "../src/compose/mcp.ts";
import { describeChange, redactText, redactUrl, urlHoldsMarker } from "../src/compose/mcp-edit.ts";
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

const entry = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  name: id,
  trust: "unknown",
  transport: { kind: "stdio", command: [process.execPath, SERVER] },
  sandbox: { allowedDomains: [] },
  ...more,
});
const putEntries = (services: ComposeServices, value: unknown[]) =>
  setSetting(services.db, MCP_SERVERS_SETTING, value);
const patchEcho = (services: ComposeServices, patch: Record<string, unknown>) => {
  const cur = stored(services) as Record<string, unknown>[];
  putEntries(
    services,
    cur.map((c) => ({ ...c, ...patch })),
  );
};

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

  it("starts the stored config once, through the RPC, when the server is on but not connected", async () => {
    const { owner, services } = await setup();
    // Written straight to the setting: configured and on, but never started here.
    putEntries(services, [entry("cold")]);
    const cardsBefore = cards(owner);
    const r = await owner.call<{ ok: boolean; toolCount: number; tools: string[] }>("mcp.test", {
      id: "cold",
    });
    expect(r).toMatchObject({ ok: true, toolCount: 1, tools: ["echo"] });
    expect(cards(owner)).toBe(cardsBefore);
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

describe("review r1 fixes", () => {
  it("N1: the update result carries no stored env value, only names", async () => {
    const { owner, mcp, services } = await setup();
    await addEcho(owner, mcp);
    const cur = (stored(services) as { transport: Record<string, unknown> }[])[0];
    patchEcho(services, {
      transport: { ...cur?.transport, env: { LEGACY_TOKEN: "plain-legacy-secret-value" } },
    });
    const r = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { allowedDomains: ["example.com"] } },
      ik(),
    );
    const all = JSON.stringify(r);
    expect(all).not.toContain("plain-legacy-secret-value");
    // Positive control: the name is there.
    expect(all).toContain("LEGACY_TOKEN");
    const cfg = JSON.stringify(await owner.call("mcp.config", { serverId: "echo" }));
    expect(cfg).not.toContain("plain-legacy-secret-value");
    expect(cfg).toContain("LEGACY_TOKEN");
  });

  it("N4: URL user info and query values are hidden, in both directions", async () => {
    const { owner, services } = await setup();
    putEntries(services, [
      {
        id: "web",
        name: "Web",
        trust: "unknown",
        enabled: false,
        transport: { kind: "http", url: "https://u:pw@example.com/mcp?token=SECRET123&x=1#frag" },
      },
    ]);
    const cfg = JSON.stringify(await owner.call("mcp.config", { serverId: "web" }));
    expect(cfg).not.toContain("SECRET123");
    expect(cfg).not.toContain("pw@");
    expect(cfg).toContain("example.com/mcp?token=***&x=***");
    expect(redactUrl("https://example.com/a/b")).toBe("https://example.com/a/b");
    expect(redactUrl("https://example.com/a?api_key=k")).toBe("https://example.com/a?api_key=***");
    expect(redactUrl("not a url")).toBe("");
  });

  it("N2: built-in, Psyche-made and shared servers can be renamed but not re-commanded", async () => {
    const { owner, services } = await setup();
    putEntries(services, [
      entry("builtin", { trust: "bundled", enabled: false }),
      entry("made", { madeBy: "psyche", enabled: false }),
      entry("shared", {
        bundle: { hash: "sha256:x" },
        enabled: false,
        transport: {
          kind: "stdio",
          command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
        },
      }),
    ]);
    for (const id of ["builtin", "made", "shared"]) {
      const r = await owner.call<UpdateResult>(
        "mcp.update",
        { id, changes: { name: `${id} renamed` } },
        ik(),
      );
      expect(r).toMatchObject({ applied: true, server: { name: `${id} renamed` } });
      await expect(
        owner.call("mcp.update", { id, changes: { command: ["node", "evil.js"] } }, ik()),
      ).rejects.toThrow(/"reason":"not_editable"/);
    }
    const now = stored(services) as { id: string; trust: string }[];
    expect(now.find((c) => c.id === "builtin")?.trust).toBe("bundled");
    expect(now.find((c) => c.id === "shared")?.trust).toBe("unknown");
  });

  it("N7: a rename between the check and the approval is kept", async () => {
    const { owner, mcp, services } = await setup();
    await addEcho(owner, mcp);
    const r = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { command: [process.execPath, SERVER, "--write-tool"] } },
      ik(),
    );
    await owner.call("mcp.update", { id: "echo", changes: { name: "Renamed" } }, ik());
    await mcp.idle();
    await approve(owner, r.approval?.id as string);
    await owner.call("mcp.add", { proposalId: r.proposal?.id, approvalId: r.approval?.id }, ik());
    await mcp.idle();
    const now = stored(services) as { name: string; transport: { command: string[] } }[];
    expect(now[0]?.name).toBe("Renamed");
    expect(now[0]?.transport.command).toContain("--write-tool");
  });

  it.each([
    ["never", undefined],
    ["always", true],
  ] as const)(
    "N9: handlesMoney %s across an update",
    async (mode, kept) => {
      const { owner, mcp, services } = await setup();
      await addEcho(owner, mcp);
      patchEcho(services, { handlesMoney: mode === "always" });
      const r = await owner.call<UpdateResult>(
        "mcp.update",
        { id: "echo", changes: { allowedDomains: ["example.com"] } },
        ik(),
      );
      await approve(owner, r.approval?.id as string);
      await owner.call("mcp.add", { proposalId: r.proposal?.id, approvalId: r.approval?.id }, ik());
      await mcp.idle();
      const now = stored(services) as { handlesMoney?: boolean }[];
      expect(now[0]?.handlesMoney).toBe(kept);
    },
    30_000,
  );

  it("N9: an approval is a conflict after the server was deleted and added again", async () => {
    const { owner, mcp } = await setup();
    await addEcho(owner, mcp);
    const r = await owner.call<UpdateResult>(
      "mcp.update",
      { id: "echo", changes: { allowedDomains: ["example.com"] } },
      ik(),
    );
    await owner.call("mcp.remove", { serverId: "echo" }, ik());
    await mcp.idle();
    const again = await owner.call<{ proposal: McpProposal; approval: Card }>(
      "mcp.probe",
      { server: echo(["--write-tool"]) },
      ik(),
    );
    await approve(owner, again.approval.id);
    await owner.call(
      "mcp.add",
      { proposalId: again.proposal.id, approvalId: again.approval.id },
      ik(),
    );
    await mcp.idle();
    await approve(owner, r.approval?.id as string);
    await expect(
      owner.call("mcp.add", { proposalId: r.proposal?.id, approvalId: r.approval?.id }, ik()),
    ).rejects.toThrow(/"code":"conflict"/);
  });
});

describe("review r2 fixes", () => {
  const WEB = {
    id: "web",
    name: "Web",
    trust: "unknown",
    enabled: false,
    transport: { kind: "http", url: "https://u:pw@api.example.com/mcp?token=SECRET123" },
  };

  it("R2-1: a submitted address that still holds the marker is refused, and nothing is stored", async () => {
    const { owner, services } = await setup();
    putEntries(services, [WEB]);
    const before = stored(services);
    for (const url of [
      "https://u:pw@api.example.com/mcp/v2?token=***",
      ["https://", "%2A%2A%2A", ":", "%2A%2A%2A", "@api.example.com/mcp"].join(""),
      "https://api.example.com/mcp?a=1&token=***",
      "https://api.example.com/mcp#***",
    ]) {
      await expect(owner.call("mcp.update", { id: "web", changes: { url } }, ik())).rejects.toThrow(
        /"reason":"url_redacted"/,
      );
      expect(urlHoldsMarker(url)).toBe(true);
    }
    expect(stored(services)).toEqual(before);
    // Positive controls: a full address passes the check.
    expect(urlHoldsMarker("https://api.example.com/mcp/v2?token=NEWSECRET")).toBe(false);
    expect(urlHoldsMarker("https://api.example.com/mcp?note=star*")).toBe(false);
    // A full new address is not refused as redacted: it goes on to the probe (no server here),
    // and the failure carries neither the stored token nor the new one.
    const err = await owner
      .call(
        "mcp.update",
        { id: "web", changes: { url: "https://127.0.0.1:9/mcp?token=NEW1" } },
        ik(),
      )
      .catch((e: Error) => e.message);
    expect(String(err)).not.toContain("url_redacted");
    expect(String(err)).not.toContain("SECRET123");
    expect(String(err)).not.toContain("NEW1");
  });

  it("R2-1: a name-only edit of a URL server keeps the stored address and token", async () => {
    const { owner, services } = await setup();
    putEntries(services, [WEB]);
    await owner.call("mcp.update", { id: "web", changes: { name: "Web 2" } }, ik());
    const now = stored(services) as { name: string; transport: { url: string } }[];
    expect(now[0]?.name).toBe("Web 2");
    expect(now[0]?.transport.url).toBe("https://u:pw@api.example.com/mcp?token=SECRET123");
  });

  it("R2-2: the card names changed query parameters and user info, never their values", () => {
    const mk = (url: string) =>
      ({ id: "w", name: "W", trust: "unknown", transport: { kind: "http", url } }) as never;
    const a = mk("https://u:pw@h.example.com/mcp?key=A&same=1");
    const b = mk("https://h.example.com/mcp?key=B&same=1");
    const { out } = describeChange(a, b);
    expect(out).toMatchObject({ queryChanged: ["key"], userinfoChanged: true });
    expect(out.oldUrl).toBe("https://h.example.com/mcp?key=***&same=***");
    expect(JSON.stringify(out)).not.toMatch(/pw|=A|=B/);
    // Positive control: nothing differs in the query or user info, so neither is listed.
    const c = describeChange(a, mk("https://u:pw@h.example.com/other?key=A&same=1")).out;
    expect(c).not.toHaveProperty("queryChanged");
    expect(c).not.toHaveProperty("userinfoChanged");
  });

  it("R2-3: addresses in error text are redacted", async () => {
    expect(
      redactText("failed to reach https://u:pw@api.example.com/mcp?token=SECRET123, retrying"),
    ).toBe("failed to reach https://api.example.com/mcp?token=***, retrying");
    expect(redactText("no address in this")).toBe("no address in this");
    const { owner, services } = await setup();
    putEntries(services, [
      {
        ...WEB,
        enabled: true,
        transport: { kind: "http", url: "https://127.0.0.1:9/mcp?token=SECRET123" },
      },
    ]);
    const r = await owner.call<{ ok: boolean; error?: string }>("mcp.test", { id: "web" });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").not.toContain("SECRET123");
  });
});
