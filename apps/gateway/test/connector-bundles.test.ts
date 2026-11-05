import { generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting, listDevices, setSetting } from "@psyche/db";
import { type ConnectorBundleCard, type McpProposal, PsycheError } from "@psyche/protocol";
import {
  AuthorKeyStore,
  AuthorRing,
  type BundleSigningKey,
  buildConnectorBundle,
  buildNotice,
  type ConnectorModel,
  keyIdOf,
  normalizeRequests,
  signRotation,
  TreeBuilder,
  verifyConnectorBundle,
  verifyNotice,
} from "@psyche/skills";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp } from "../src/compose/mcp.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import type { Call } from "../src/context.ts";
import { adminClient, desktopClient, ik, type TestClient } from "./helpers.ts";

/**
 * Shared connectors (docs/design/shared-bundles-2026.md section 8): export through the owner's
 * gates, import through the sandboxed probe and the trust card, updates, and revocation.
 */

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));
const ECHO_SOURCE = readFileSync(SERVER, "utf8");
const NOW = new Date("2026-11-04T12:00:00Z");
// Built at run time: the repo secret scan flags literal key shapes.
const TOKEN_VALUE = ["tok", "9f8e7d6c5b4a3210"].join("-");
const PLAIN_VALUE = ["/Users", "someone", "notes"].join("/");

/** Stands in for srt: runs the fixture unwrapped, in its cwd, but reports srt isolation. */
/** The network each launch was given, so a test can see what the probe and the real run got. */
const launches: { server: string; domains: string[] }[] = [];
const fakeSrt = {
  isolation: "srt" as const,
  prepare: async (spec: {
    serverId: string;
    command: string[];
    cwd?: string;
    sandbox: { allowedDomains: string[] };
  }) => {
    launches.push({ server: spec.serverId, domains: [...spec.sandbox.allowedDomains] });
    return {
      command: spec.command[0] as string,
      args: spec.command.slice(1),
      env: { PATH: process.env.PATH ?? "" },
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    };
  },
};

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  launches.length = 0;
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(withLauncher = true) {
  home = mkdtempSync(join(tmpdir(), "psyche-conn-bundles-"));
  const keyFile = join(home, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  let mcp: ComposedMcp | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    parts: [
      (s) => {
        services = s;
        mcp = composeMcp(s, withLauncher ? { hostOptions: { launcher: fakeSrt } } : {});
        return mcp;
      },
    ],
  });
  await composed.vault.setup();
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  const svc = services as ComposeServices;
  const deviceId = listDevices(svc.db).find((d) => d.scopes.includes("operator.admin"))
    ?.id as string;
  const call = (over: { shell?: boolean } = {}) =>
    ({
      identity: { desktopShell: over.shell ?? true, deviceId },
      conn: { peer: { remoteLoopback: true, origin: null } },
      ctx: {
        presenceState: () => "off",
        bus: { publish: (e: never, p: never) => svc.publish(e, p) },
        broker: svc.broker,
      },
    }) as unknown as Call;
  const handler = (name: string) =>
    (mcp as ComposedMcp).handlers?.[name] as unknown as {
      run: (call: Call, params: unknown) => Promise<unknown>;
    };
  return { owner, mcp: mcp as ComposedMcp, services: svc, call, handler, deviceId };
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

type Setup = Awaited<ReturnType<typeof setup>>;

/** An owner-set-up server: the echo fixture with a token and a plain variable set. */
async function addEcho(s: Setup, id = "echo") {
  const { proposal, approval } = await s.owner.call<{
    proposal: McpProposal;
    approval: { id: string };
  }>(
    "mcp.probe",
    {
      server: {
        id,
        name: "Echo",
        transport: {
          kind: "stdio",
          command: [process.execPath, SERVER, "--write-tool"],
          env: { NOTES_DIR: PLAIN_VALUE, NOTES_TOKEN: TOKEN_VALUE },
        },
        allowedDomains: ["api.example.com"],
      },
    },
    ik(),
  );
  await approve(s.owner, approval.id);
  await s.owner.call("mcp.add", { proposalId: proposal.id, approvalId: approval.id }, ik());
}

function authorKey(name: string): BundleSigningKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = privateKey.export({ format: "jwk" }).x as string;
  return {
    author: { name, keyId: keyIdOf(x), publicKey: x },
    sign: (data) => sign(null, data, privateKey).toString("base64url"),
  };
}

/** A connector model that starts the echo fixture; `over` changes what it asks for. */
function model(over: Partial<ConnectorModel["requests"]> & { name?: string } = {}): ConnectorModel {
  const { name, ...rest } = over;
  return {
    name: name ?? "notes-sync",
    title: "Notes sync",
    description: "Searches and appends to a notes service.",
    version: "1.0.0",
    requests: normalizeRequests({
      command: process.execPath,
      args: [SERVER, "--write-tool"],
      env: ["NOTES_DIR"],
      secrets: [{ name: "NOTES_TOKEN", purpose: "API access" }],
      network: ["api.example.com"],
      tools: [
        { name: "echo", sideEffect: "read" },
        { name: "shout", sideEffect: "destructive" },
      ],
      ...rest,
    }),
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const treeOf = (files: Record<string, string>) => {
  const b = new TreeBuilder();
  for (const [p, t] of Object.entries(files)) b.add(p, enc(t));
  return b.tree;
};

interface Imported {
  card: ConnectorBundleCard;
  proposal?: McpProposal;
  approval?: {
    id: string;
    kind: string;
    deviceOnly?: boolean;
    surfaces: string[];
    summary: string;
    details: Record<string, unknown>;
  };
}
const propose = (s: Setup, text: string) =>
  s.owner.call<Imported>("connectors.proposeImport", { name: "x.psyche-connector", text }, ik());

async function install(s: Setup, r: Imported) {
  await approve(s.owner, (r.approval as { id: string }).id);
  return s.owner.call<{ server: { id: string; connected: boolean } }>(
    "mcp.add",
    { proposalId: (r.proposal as McpProposal).id, approvalId: (r.approval as { id: string }).id },
    ik(),
  );
}

/** The error's code and message, whether it came from a handler or over the socket. */
const rejects = async (
  p: Promise<unknown>,
): Promise<{ code: string; message: string; details?: unknown }> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PsycheError) return { code: e.code, message: e.message, details: e.details };
    const text = (e as Error).message;
    try {
      return JSON.parse(text);
    } catch {
      return { code: /"code":"([a-z_]+)"/.exec(text)?.[1] ?? "?", message: text };
    }
  }
  throw new Error("expected a rejection");
};

describe("export", () => {
  it("is names only: no env or secret value is in the file, and it verifies", async () => {
    const s = await setup();
    await addEcho(s);
    const run = s.handler("connectors.export");
    // The first export must name its author, before any card is shown for nothing.
    const noName = await rejects(run.run(s.call(), { serverId: "echo" }));
    expect(noName.code).toBe("invalid_params");
    expect(await s.services.rawBroker.list({ status: "pending" })).toEqual([]);
    const first = await rejects(run.run(s.call(), { serverId: "echo", authorName: "Ada" }));
    expect(first.code).toBe("approval_required");
    const approvalId = (first.details as { approvalId: string }).approvalId;
    const { approval: card } = await s.owner.call<{
      approval: { details: Record<string, unknown> };
    }>("approvals.get", { approvalId });
    const details = card.details;
    // The card names exactly what the file will say: names, domains, tools; no values.
    expect(details).toMatchObject({
      kind: "connector_export",
      serverId: "echo",
      env: ["NOTES_DIR"],
      secrets: ["NOTES_TOKEN"],
      network: ["api.example.com"],
    });
    expect(JSON.stringify(details)).not.toContain(TOKEN_VALUE);
    expect(JSON.stringify(details)).not.toContain(PLAIN_VALUE);
    await approve(s.owner, approvalId);
    const out = (await run.run(s.call(), {
      serverId: "echo",
      authorName: "Ada",
      approvalId,
    })) as { filename: string; bundle: string; createdKey: boolean; bundleHash: string };
    expect(out.filename).toBe("echo.psyche-connector");
    expect(out.createdKey).toBe(true);
    expect(out.bundle).not.toContain(TOKEN_VALUE);
    expect(out.bundle).not.toContain(PLAIN_VALUE);
    const v = verifyConnectorBundle(out.bundle);
    expect(v.signer?.name).toBe("Ada");
    expect(v.bundleHash).toBe(out.bundleHash);
    expect(v.manifest.requests).toMatchObject({
      command: process.execPath,
      args: [SERVER, "--write-tool"],
      env: ["NOTES_DIR"],
      secrets: [{ name: "NOTES_TOKEN" }],
      network: ["api.example.com"],
      tools: [
        { name: "echo", sideEffect: "read" },
        { name: "shout", sideEffect: "destructive" },
      ],
    });
    // The approval is spent: the same card does not sign again.
    const again = await rejects(
      run.run(s.call(), { serverId: "echo", authorName: "Ada", approvalId }),
    );
    expect(["approval_required", "forbidden", "binding_mismatch"]).toContain(again.code);
    // The author key was made with the right modes.
    expect(statSync(new AuthorKeyStore(home).path).mode & 0o077).toBe(0);
  });

  it("is for Psyche on the Host itself only, and the agent has no tool for it", async () => {
    const s = await setup();
    await addEcho(s);
    for (const call of [s.call({ shell: false })]) {
      const e = await rejects(
        s.handler("connectors.export").run(call, { serverId: "echo", authorName: "Ada" }),
      );
      expect(e.code).toBe("forbidden");
    }
    // No agent tool exports, imports, rotates, signs notices or trusts.
    const names = s.services.tools.list().map((t) => t.name);
    expect(names.filter((n) => /export|import|rotate|notice|trust|bundle/i.test(n))).toEqual([]);
    expect(names.filter((n) => n.startsWith("connectors."))).toEqual([]);
    // A paired computer without the admin scope cannot reach any of the new methods.
    const plain = await desktopClient((composed as ComposedGateway).gateway);
    clients.push(plain);
    for (const [method, params] of [
      ["connectors.export", { serverId: "echo" }],
      ["connectors.proposeImport", { text: "{}" }],
    ] as const) {
      await expect(plain.call(method, params, ik())).rejects.toThrow(/scope|forbidden/);
    }
  });

  it("only connectors the owner set up: not one Psyche wrote, a bundled or URL one, or an imported one", async () => {
    const s = await setup();
    await addEcho(s);
    const run = s.handler("connectors.export");
    const entries = [
      {
        id: "made",
        name: "Made",
        trust: "unknown",
        madeBy: "psyche",
        transport: { kind: "stdio", command: ["node", "x.mjs"] },
      },
      {
        id: "remote",
        name: "Remote",
        trust: "unknown",
        transport: { kind: "http", url: "https://mcp.example.com/" },
      },
    ];
    const current = (await s.owner.call<{ servers: unknown[] }>("mcp.status", {})).servers.length;
    expect(current).toBe(1);
    setSetting(s.services.db, "mcp.servers", [
      ...((getSetting(s.services.db, "mcp.servers")?.value ?? []) as unknown[]),
      ...entries,
    ]);
    for (const id of ["made", "remote"]) {
      const e = await rejects(run.run(s.call(), { serverId: id, authorName: "Ada" }));
      expect(e.code, id).toBe("invalid_params");
    }
    expect((await rejects(run.run(s.call(), { serverId: "nope", authorName: "Ada" }))).code).toBe(
      "not_found",
    );
    // A server that is off lists no tools, so there is nothing honest to say about them.
    await s.owner.call("mcp.setEnabled", { serverId: "echo", enabled: false }, ik());
    await s.mcp.idle();
    expect((await rejects(run.run(s.call(), { serverId: "echo", authorName: "Ada" }))).code).toBe(
      "unavailable",
    );
  });

  it("refuses a command line with something that looks like a secret in it", async () => {
    const s = await setup();
    const fake = ["gh", "p_", "a".repeat(36)].join("");
    const { proposal, approval } = await s.owner.call<{
      proposal: McpProposal;
      approval: { id: string };
    }>(
      "mcp.probe",
      {
        server: {
          id: "leaky",
          name: "Leaky",
          transport: { kind: "stdio", command: [process.execPath, SERVER, "--token", fake] },
        },
      },
      ik(),
    );
    await approve(s.owner, approval.id);
    await s.owner.call("mcp.add", { proposalId: proposal.id, approvalId: approval.id }, ik());
    const e = await rejects(
      s.handler("connectors.export").run(s.call(), { serverId: "leaky", authorName: "Ada" }),
    );
    expect(e.code).toBe("policy_denied");
    expect(e.message).not.toContain(fake);
  });
});

describe("import: the card and the sandboxed first run", () => {
  it("shows everything it asks for, probes in the sandbox, installs through mcp.add, then asks for the secrets", async () => {
    const s = await setup();
    const key = authorKey("Ada");
    const text = buildConnectorBundle(model(), new Map(), key, NOW);
    const r = await propose(s, text);
    const card = r.card;
    // The full card: who signed it, the command, the network, env and secret names, the tools.
    expect(card).toMatchObject({
      serverId: "notes-sync",
      title: "Notes sync",
      version: "1.0.0",
      signer: { status: "new", name: "Ada", keyId: key.author.keyId, signerChanged: false },
      command: [process.execPath, SERVER, "--write-tool"],
      env: ["NOTES_DIR"],
      secrets: [{ name: "NOTES_TOKEN", purpose: "API access" }],
      network: ["api.example.com"],
      declaredTools: [
        { name: "echo", sideEffect: "read" },
        { name: "shout", sideEffect: "destructive" },
      ],
      sandbox: "srt",
      toolCheck: { undeclared: [], missing: [] },
    });
    expect(card.bundleHash).toMatch(/^sha256:/);
    expect(card.blocker).toBeUndefined();
    expect(card.update).toBeUndefined();
    // The probe ran in the sandbox and listed the real tools; nothing is registered yet.
    expect(r.proposal?.isolation).toBe("srt");
    expect(r.proposal?.tools.map((t) => t.name).sort()).toEqual(["echo", "shout"]);
    // Before approval the probe ran with no network at all, though the card lists a domain.
    expect(launches).toHaveLength(1);
    expect(launches[0]?.server).toContain("-probe-");
    expect(launches[0]?.domains).toEqual([]);
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeUndefined();
    // The same install card as every MCP server: device-only, with the bundle facts on it.
    expect(r.approval).toMatchObject({
      kind: "skill_install",
      deviceOnly: true,
      surfaces: ["desktop"],
    });
    expect(r.approval?.summary).toContain("signed by");
    expect(r.approval?.details).toMatchObject({
      kind: "mcp_server",
      bundle: {
        signerStatus: "new",
        env: ["NOTES_DIR"],
        secrets: ["NOTES_TOKEN"],
        firstRun: "sandbox",
      },
    });

    const added = await install(s, r);
    expect(added.server).toMatchObject({ id: "notes-sync", connected: true });
    // The approved connector gets the domains it asked for.
    expect(launches.at(-1)).toEqual({ server: "notes-sync", domains: ["api.example.com"] });
    // Secrets by name, no value, to be filled in by the owner.
    const { secrets } = await s.owner.call<{ secrets: { name: string; isSet: boolean }[] }>(
      "mcp.secrets",
      { serverId: "notes-sync" },
    );
    expect(secrets.map((x) => [x.name, x.isSet]).sort()).toEqual([
      ["NOTES_DIR", false],
      ["NOTES_TOKEN", false],
    ]);
    // Turned off first, so setting the secret does not start a server that would ask to read it.
    await s.owner.call("mcp.setEnabled", { serverId: "notes-sync", enabled: false }, ik());
    await s.mcp.idle();
    await s.owner.call(
      "mcp.secrets.replace",
      { serverId: "notes-sync", name: "NOTES_TOKEN", value: TOKEN_VALUE },
      ik(),
    );
    const after = await s.owner.call<{ secrets: { name: string; isSet: boolean }[] }>(
      "mcp.secrets",
      { serverId: "notes-sync" },
    );
    expect(after.secrets.find((x) => x.name === "NOTES_TOKEN")?.isSet).toBe(true);
    // The record of what was approved, and the signer's key seen on this Mac.
    const ledger = JSON.parse(readFileSync(join(home, "connectors", "bundles.json"), "utf8"));
    expect(ledger.servers["notes-sync"]).toMatchObject({
      bundleHash: card.bundleHash,
      signerKeyId: key.author.keyId,
    });
    expect(statSync(join(home, "connectors", "bundles.json")).mode & 0o077).toBe(0);
    expect(new AuthorRing(join(home, "skills")).get(key.author.keyId)?.state).toBe("seen");
    // A connector that came from a file is someone else's: it is never signed with the owner's key.
    const e = await rejects(
      s.handler("connectors.export").run(s.call(), { serverId: "notes-sync", authorName: "Me" }),
    );
    expect(e.code).toBe("invalid_params");
    expect(e.message).toMatch(/came from a shared file/);
  });

  it("with no sandbox the card says so plainly and nothing is probed, staged or written", async () => {
    const s = await setup(false);
    const text = buildConnectorBundle(
      model(),
      treeOf({ "server.mjs": ECHO_SOURCE }),
      authorKey("Ada"),
      NOW,
    );
    const r = await propose(s, text);
    expect(r.card.sandbox).toBe("none");
    expect(r.card.blocker).toBe("no_sandbox");
    expect(r.proposal).toBeUndefined();
    expect(r.approval).toBeUndefined();
    expect(r.card.command).toEqual([process.execPath, SERVER, "--write-tool"]);
    expect(existsSync(join(home, "connector-bundles"))).toBe(false);
  });

  it("a high scan finding blocks the install but the card still shows everything", async () => {
    const s = await setup();
    const fake = ["gh", "p_", "b".repeat(36)].join("");
    const text = buildConnectorBundle(
      model({ args: [SERVER, "--token", fake] }),
      new Map(),
      authorKey("Ada"),
      NOW,
    );
    const r = await propose(s, text);
    expect(r.card.blocker).toBe("scan");
    expect(r.card.findings.some((f) => f.rule === "secret" && f.severity === "high")).toBe(true);
    expect(r.proposal).toBeUndefined();
    expect(JSON.stringify(r.card.findings)).not.toContain(fake);
  });

  it("a bundled script payload is written to its own directory, shown with its text, and run from there", async () => {
    const s = await setup();
    const text = buildConnectorBundle(
      model({ command: "node", args: ["server.mjs", "--write-tool"] }),
      treeOf({ "server.mjs": ECHO_SOURCE }),
      authorKey("Ada"),
      NOW,
    );
    const r = await propose(s, text);
    expect(r.card.files).toEqual([
      {
        path: "server.mjs",
        bytes: Buffer.byteLength(ECHO_SOURCE),
        executable: false,
        text: ECHO_SOURCE,
      },
    ]);
    await install(s, r);
    const entry = (
      (getSetting(s.services.db, "mcp.servers")?.value ?? []) as {
        id: string;
        cwd?: string;
        sandbox?: { allowRead?: string[]; allowWrite?: string[] };
      }[]
    ).find((c) => c.id === "notes-sync");
    expect(entry?.cwd?.startsWith(join(home, "connector-bundles", "notes-sync"))).toBe(true);
    expect(entry?.sandbox?.allowRead).toEqual([entry?.cwd]);
    expect(entry?.sandbox?.allowWrite ?? []).toEqual([]);
    expect(existsSync(join(entry?.cwd as string, "server.mjs"))).toBe(true);
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeDefined();
    // Removing the server removes its files and its record.
    await s.owner.call("mcp.remove", { serverId: "notes-sync" }, ik());
    expect(existsSync(join(home, "connector-bundles", "notes-sync"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(home, "connectors", "bundles.json"), "utf8")).servers,
    ).toEqual({});
  });

  it("a malformed, tampered or unsigned-author file is refused; an id that is not from a bundle is a conflict", async () => {
    const s = await setup();
    const key = authorKey("Ada");
    const text = buildConnectorBundle(model(), new Map(), key, NOW);
    const j = JSON.parse(text);
    j.manifest.requests.args.push("--extra");
    expect((await rejects(propose(s, JSON.stringify(j)))).message).toMatch(
      /signature does not verify/,
    );
    expect((await rejects(propose(s, "{}"))).code).toBe("invalid_params");
    // Env names the host would refuse never reach a card.
    const blocked = buildConnectorBundle(model({ env: ["LD_PRELOAD"] }), new Map(), key, NOW);
    expect((await rejects(propose(s, blocked))).code).toBe("policy_denied");
    // A server with that id that the owner set up themselves.
    await addEcho(s, "notes-sync");
    expect((await rejects(propose(s, text))).code).toBe("conflict");
    // Neither or both of text and link.
    await expect(
      s.owner.call("connectors.proposeImport", { text, bundleUrl: "https://example.com/x" }, ik()),
    ).rejects.toThrow(/either/);
    await expect(s.owner.call("connectors.proposeImport", {}, ik())).rejects.toThrow(/either/);
  });

  it("an https link is fetched under the bundle-link rules", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-conn-bundles-"));
    const text = buildConnectorBundle(model(), new Map(), authorKey("Ada"), NOW);
    let mcp: ComposedMcp | undefined;
    composed = await composeGateway({
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [
        (s) => {
          mcp = composeMcp(s, {
            hostOptions: { launcher: fakeSrt },
            bundleFetch: {
              fetchImpl: async () => new Response(text, { status: 200 }),
              resolveHost: async () => ["93.184.216.34"],
            },
          });
          return mcp;
        },
      ],
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const ok = await owner.call<Imported>(
      "connectors.proposeImport",
      { bundleUrl: "https://example.com/n.psyche-connector" },
      ik(),
    );
    expect(ok.card.serverId).toBe("notes-sync");
    for (const url of ["http://example.com/n", "https://localhost/n", "https://10.0.0.1/n"]) {
      await expect(
        owner.call("connectors.proposeImport", { bundleUrl: url }, ik()),
      ).rejects.toThrow(/not allowed|invalid_params/);
    }
  });
});

describe("updates", () => {
  it("show a diff, flag what widens, and a card approved for the narrower version cannot install the wider", async () => {
    const s = await setup();
    const key = authorKey("Ada");
    const r1 = await propose(s, buildConnectorBundle(model(), new Map(), key, NOW));
    await install(s, r1);
    // The owner has given NOTES_DIR a value; an update must not lose it.
    const given = getSetting(s.services.db, "mcp.servers")?.value as {
      transport: { env: Record<string, string> };
    }[];
    (given[0] as { transport: { env: Record<string, string> } }).transport.env.NOTES_DIR =
      "kept-plain";
    await s.owner.call("settings.set", { key: "mcp.servers", value: given }, ik());
    await s.mcp.idle();

    // Same request again: nothing widens, and it is a new card all the same.
    const later = new Date(NOW.getTime() + 60_000);
    const same = await propose(s, buildConnectorBundle(model(), new Map(), key, later));
    expect(same.card.update?.widened).toBeUndefined();
    // Same key, nothing wider: the value the owner gave is listed as kept.
    expect(same.card.update?.carried).toEqual(["NOTES_DIR"]);
    expect(same.card.update?.cleared).toEqual([]);
    expect(same.approval?.details).toMatchObject({ bundle: { update: true, widened: false } });

    const wide = await propose(
      s,
      buildConnectorBundle(
        model({
          args: [SERVER, "--write-tool", "--verbose"],
          env: ["NOTES_DIR", "NOTES_EXTRA"],
          secrets: [
            { name: "NOTES_TOKEN", purpose: "API access" },
            { name: "SECOND_TOKEN", purpose: "More" },
          ],
          network: ["api.example.com", "cdn.example.com"],
        }),
        new Map(),
        key,
        later,
      ),
    );
    expect(wide.card.update?.widened).toMatchObject({
      command: true,
      env: ["NOTES_EXTRA"],
      secrets: ["SECOND_TOKEN"],
      network: ["cdn.example.com"],
      tools: [],
      payload: false,
    });
    expect(wide.card.update?.diff).toContain("+--verbose");
    expect(wide.card.update?.installedCommand).toEqual([process.execPath, SERVER, "--write-tool"]);
    expect(wide.card.findings.some((f) => f.rule === "permissions-widened")).toBe(true);
    expect(wide.approval?.summary).toContain("asks for more than before");
    expect(wide.approval?.details).toMatchObject({ bundle: { update: true, widened: true } });

    // Re-approval: the narrower card is no use for the wider proposal.
    await approve(s.owner, (same.approval as { id: string }).id);
    await expect(
      s.owner.call(
        "mcp.add",
        {
          proposalId: (wide.proposal as McpProposal).id,
          approvalId: (same.approval as { id: string }).id,
        },
        ik(),
      ),
    ).rejects.toThrow(/"code":"(binding_mismatch|approval_required)"/);
    // Its own card installs it, keeps the secret the owner already gave, and records the change.
    await install(s, wide);
    const entry = (
      (getSetting(s.services.db, "mcp.servers")?.value ?? []) as {
        id: string;
        transport: { env?: Record<string, string> };
      }[]
    ).find((c) => c.id === "notes-sync");
    // A wider command and network: nothing carries over, and the card said which would have.
    expect(entry?.transport.env?.NOTES_DIR).toBe("");
    expect(wide.card.update?.carried).toEqual([]);
    expect(wide.card.update?.cleared).toEqual(["NOTES_DIR"]);
    expect(entry?.transport.env?.SECOND_TOKEN).toBe("");
    expect(
      JSON.parse(readFileSync(join(home, "connectors", "bundles.json"), "utf8")).servers[
        "notes-sync"
      ].requests.network,
    ).toEqual(["api.example.com", "cdn.example.com"]);
  });

  it("a different signer, an unsigned update and a rollback are flagged", async () => {
    const s = await setup();
    const ada = authorKey("Ada");
    await install(s, await propose(s, buildConnectorBundle(model(), new Map(), ada, NOW)));
    const later = new Date(NOW.getTime() + 60_000);
    const other = await propose(
      s,
      buildConnectorBundle(model(), new Map(), authorKey("Not Ada"), later),
    );
    expect(other.card.signer).toMatchObject({ status: "changed", signerChanged: true });
    expect(other.card.update?.signerChanged).toBe(true);
    expect(other.card.findings.some((f) => f.rule === "signer-changed")).toBe(true);
    // A signed install is not replaced by an unsigned file at all.
    const unsigned = await rejects(
      propose(s, buildConnectorBundle(model(), new Map(), undefined, later)),
    );
    expect(unsigned.code).toBe("policy_denied");
    const older = await propose(
      s,
      buildConnectorBundle(model(), new Map(), ada, new Date(NOW.getTime() - 86_400_000)),
    );
    expect(older.card.findings.some((f) => f.rule === "older-than-installed")).toBe(true);
  });

  it("a new key named by the old one is 'same author, new key', and still not trusted", async () => {
    const s = await setup();
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    await install(s, await propose(s, buildConnectorBundle(model(), new Map(), a, NOW)));
    new AuthorRing(join(home, "skills")).setState(a.author.keyId, "trusted");
    const statement = signRotation(a, b.author, NOW.toISOString());
    const later = new Date(NOW.getTime() + 60_000);
    const r = await propose(s, buildConnectorBundle(model(), new Map(), b, later, [statement]));
    expect(r.card.signer).toMatchObject({
      status: "rotated",
      previousKeyId: a.author.keyId,
      rotatedFrom: { keyId: a.author.keyId, state: "trusted" },
      signerChanged: false,
    });
    expect(r.card.findings.some((f) => f.rule === "signer-rotated")).toBe(true);
    expect(new AuthorRing(join(home, "skills")).get(b.author.keyId)).toBeUndefined();
    // A forged statement refuses the whole file.
    const m = authorKey("Mallory");
    const forged = { ...signRotation(m, m.author, NOW.toISOString()), from: statement.from };
    const e = await rejects(
      propose(s, buildConnectorBundle(model(), new Map(), m, later, [forged])),
    );
    expect(e.code).toBe("invalid_params");
  });
});

describe("revocation", () => {
  it("a card staged before the key was revoked cannot install", async () => {
    const s = await setup();
    const key = authorKey("Ada");
    const r = await propose(s, buildConnectorBundle(model(), new Map(), key, NOW));
    await approve(s.owner, (r.approval as { id: string }).id);
    new AuthorRing(join(home, "skills")).setState(key.author.keyId, "revoked");
    const e = await rejects(
      s.owner.call(
        "mcp.add",
        {
          proposalId: (r.proposal as McpProposal).id,
          approvalId: (r.approval as { id: string }).id,
        },
        ik(),
      ),
    );
    expect(e.code).toBe("policy_denied");
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeUndefined();
    expect(existsSync(join(home, "connectors", "bundles.json"))).toBe(false);
  });

  it("a revoked key refuses its bundles and stops the connectors it signed", async () => {
    const s = await setup();
    const key = authorKey("Ada");
    const text = buildConnectorBundle(model(), new Map(), key, NOW);
    await install(s, await propose(s, text));
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeDefined();
    new AuthorRing(join(home, "skills")).setState(key.author.keyId, "revoked");
    s.services.publish("skills.changed", { type: "reloaded", added: [], removed: [], changed: [] });
    await new Promise((r) => setTimeout(r, 50));
    await s.mcp.idle();
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeUndefined();
    expect((await rejects(propose(s, text))).code).toBe("policy_denied");
  });

  it("a signed notice naming the bundle blocks that bundle and its installed server, and nothing else", async () => {
    const s = await setup();
    const key = authorKey("Ada");
    const text = buildConnectorBundle(model(), new Map(), key, NOW);
    const v = verifyConnectorBundle(text);
    await install(s, await propose(s, text));
    const ring = new AuthorRing(join(home, "skills"));
    const notice = buildNotice(
      key,
      { kind: "bundle", keyId: key.author.keyId, bundleHash: v.bundleHash, reason: "phones home" },
      NOW,
    );
    ring.applyNotice(verifyNotice(notice));
    s.services.publish("skills.changed", { type: "reloaded", added: [], removed: [], changed: [] });
    await new Promise((r) => setTimeout(r, 50));
    await s.mcp.idle();
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeUndefined();
    expect((await rejects(propose(s, text))).code).toBe("policy_denied");
    // Another bundle by the same, still unrevoked, key is fine.
    const fixed = buildConnectorBundle(model({ args: [SERVER] }), new Map(), key, NOW);
    expect((await propose(s, fixed)).card.serverId).toBe("notes-sync");
    // A notice from a key the owner has not met is refused and changes nothing.
    const stranger = authorKey("Stranger");
    expect(() =>
      ring.applyNotice(
        verifyNotice(
          buildNotice(stranger, { kind: "key", keyId: stranger.author.keyId, reason: "boo" }, NOW),
        ),
      ),
    ).toThrow(/have not met/);
  });

  it("files changed on disk since the owner approved them keep the server off", async () => {
    const s = await setup();
    const text = buildConnectorBundle(
      model({ command: "node", args: ["server.mjs", "--write-tool"] }),
      treeOf({ "server.mjs": ECHO_SOURCE }),
      authorKey("Ada"),
      NOW,
    );
    await install(s, await propose(s, text));
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeDefined();
    const dir = readdirOnly(join(home, "connector-bundles", "notes-sync"));
    writeFileSync(join(dir, "server.mjs"), `${ECHO_SOURCE}\n// changed\n`);
    s.services.publish("skills.changed", { type: "reloaded", added: [], removed: [], changed: [] });
    await new Promise((r) => setTimeout(r, 50));
    await s.mcp.idle();
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeUndefined();
  });
});

function readdirOnly(dir: string): string {
  const [only] = readdirSync(dir);
  return join(dir, only as string);
}

describe("review fixes", () => {
  const entryOf = (s: Setup, id: string) =>
    (
      (getSetting(s.services.db, "mcp.servers")?.value ?? []) as {
        id: string;
        trust: string;
        bundle?: { hash: string };
        sandbox?: { denyRead?: string[]; allowRead?: string[] };
        transport: { env?: Record<string, string>; command: string[] };
      }[]
    ).find((c) => c.id === id);

  const give = async (s: Setup, id: string, name: string, value: string) => {
    const all = (getSetting(s.services.db, "mcp.servers")?.value ?? []) as {
      id: string;
      transport: { env: Record<string, string> };
    }[];
    for (const e of all) if (e.id === id) e.transport.env[name] = value;
    await s.owner.call("settings.set", { key: "mcp.servers", value: all }, ik());
    await s.mcp.idle();
  };

  const poke = async (s: Setup) => {
    s.services.publish("skills.changed", { type: "reloaded", added: [], removed: [], changed: [] });
    await new Promise((r) => setTimeout(r, 50));
    await s.mcp.idle();
  };

  it("M3: values carry to the same key's update, not to a new signer", async () => {
    const s = await setup();
    const ada = authorKey("Ada");
    await install(s, await propose(s, buildConnectorBundle(model(), new Map(), ada, NOW)));
    await give(s, "notes-sync", "NOTES_DIR", "kept");
    const later = new Date(NOW.getTime() + 60_000);
    // A different signer: nothing carries, and the card says which value was dropped.
    const other = await propose(
      s,
      buildConnectorBundle(model(), new Map(), authorKey("Mallory"), later),
    );
    expect(other.card.update?.carried).toEqual([]);
    expect(other.card.update?.cleared).toEqual(["NOTES_DIR"]);
    await install(s, other);
    expect(entryOf(s, "notes-sync")?.transport.env?.NOTES_DIR).toBe("");
    expect(entryOf(s, "notes-sync")?.trust).toBe("unknown");
  });

  it("M3: a rotation carries values only to a successor the owner trusts", async () => {
    const run = async (trusted: boolean) => {
      const s = await setup();
      const a = authorKey("Ada");
      const b = authorKey("Ada");
      await install(s, await propose(s, buildConnectorBundle(model(), new Map(), a, NOW)));
      await give(s, "notes-sync", "NOTES_DIR", "kept");
      const ring = new AuthorRing(join(home, "skills"));
      ring.observe(b.author);
      if (trusted) ring.setState(b.author.keyId, "trusted");
      const statement = signRotation(a, b.author, NOW.toISOString());
      const r = await propose(
        s,
        buildConnectorBundle(model(), new Map(), b, new Date(NOW.getTime() + 60_000), [statement]),
      );
      return r.card.update;
    };
    expect((await run(true))?.carried).toEqual(["NOTES_DIR"]);
    for (const c of clients.splice(0)) c.close();
    await composed?.stop("test");
    composed = null;
    expect((await run(false))?.carried).toEqual([]);
  });

  it("M5: a shared connector is never 'verified', whatever its command looks like", async () => {
    const s = await setup();
    const official = ["npx", "-y", "@modelcontextprotocol/server-everything"];
    const mk = (id: string, extra: object) => ({
      id,
      name: id,
      trust: "verified",
      enabled: false,
      transport: { kind: "stdio", command: official },
      ...extra,
    });
    await s.owner.call(
      "settings.set",
      {
        key: "mcp.servers",
        value: [mk("plain", {}), mk("shared", { bundle: { hash: `sha256:${"a".repeat(64)}` } })],
      },
      ik(),
    );
    await s.mcp.idle();
    const { servers } = await s.owner.call<{ servers: { id: string; trust: string }[] }>(
      "mcp.status",
      {},
    );
    expect(servers.find((x) => x.id === "plain")?.trust).toBe("verified");
    expect(servers.find((x) => x.id === "shared")?.trust).toBe("unknown");
  });

  it("M5/L8: an imported connector is marked, unknown, and denied the places people keep their files", async () => {
    const s = await setup();
    await install(
      s,
      await propose(s, buildConnectorBundle(model(), new Map(), authorKey("Ada"), NOW)),
    );
    const e = entryOf(s, "notes-sync");
    expect(e?.trust).toBe("unknown");
    expect(e?.bundle?.hash).toMatch(/^sha256:/);
    expect(e?.sandbox?.denyRead?.some((p) => p.endsWith("/Documents"))).toBe(true);
    expect(e?.sandbox?.denyRead?.some((p) => p.endsWith("/Library/Mail"))).toBe(true);
  });

  it("M4/L10: the export card shows the whole command and who signs; a credential in it stops the export", async () => {
    const s = await setup();
    const longArg = `--note=${"x".repeat(700)}`;
    const tail = "--last-argument";
    const { proposal, approval } = await s.owner.call<{
      proposal: McpProposal;
      approval: { id: string };
    }>(
      "mcp.probe",
      {
        server: {
          id: "longcmd",
          name: "Long",
          transport: { kind: "stdio", command: [process.execPath, SERVER, longArg, tail] },
        },
      },
      ik(),
    );
    // The add card lists the command one argument per item.
    const card = await s.owner.call<{ approval: { details: { argv?: string[] } } }>(
      "approvals.get",
      { approvalId: approval.id },
    );
    expect(card.approval.details.argv).toEqual([process.execPath, SERVER, longArg, tail]);
    await approve(s.owner, approval.id);
    await s.owner.call("mcp.add", { proposalId: proposal.id, approvalId: approval.id }, ik());
    const first = await rejects(
      s.handler("connectors.export").run(s.call(), { serverId: "longcmd", authorName: "Ada" }),
    );
    const detail = await s.owner.call<{ approval: { details: Record<string, unknown> } }>(
      "approvals.get",
      { approvalId: (first.details as { approvalId: string }).approvalId },
    );
    const d = detail.approval.details;
    // Nothing cut off at 600 characters: the last argument is on the card, and who signs is named.
    expect(String(d.command).endsWith(tail)).toBe(true);
    expect((d.argv as string[]).at(-1)).toBe(tail);
    expect(d).toMatchObject({ signAs: "Ada", newKey: true });
    expect(String(d.note)).toMatch(/Names only/);

    const secretish = ["--api", "key=", "Zk39xQ7vLm2PaR8sTu4WnY"].join("");
    const leaky = await s.owner.call<{ proposal: McpProposal; approval: { id: string } }>(
      "mcp.probe",
      {
        server: {
          id: "leaky2",
          name: "Leaky",
          transport: { kind: "stdio", command: [process.execPath, SERVER, secretish] },
        },
      },
      ik(),
    );
    await approve(s.owner, leaky.approval.id);
    await s.owner.call(
      "mcp.add",
      { proposalId: leaky.proposal.id, approvalId: leaky.approval.id },
      ik(),
    );
    const e = await rejects(
      s.handler("connectors.export").run(s.call(), { serverId: "leaky2", authorName: "Ada" }),
    );
    expect(e.code).toBe("policy_denied");
    expect(e.message).not.toContain("Zk39xQ7vLm2PaR8sTu4WnY");
  });

  it("L2: a tool that appears in the probe counts as wider even when the file's claims did not change", async () => {
    const s = await setup();
    const key = authorKey("Ada");
    const claims = { tools: [{ name: "echo", sideEffect: "read" as const }] };
    const v1 = buildConnectorBundle(
      model({ command: "node", args: ["server.mjs"], ...claims }),
      treeOf({ "server.mjs": ECHO_SOURCE }),
      key,
      NOW,
    );
    await install(s, await propose(s, v1));
    const v2 = buildConnectorBundle(
      model({ command: "node", args: ["server.mjs"], ...claims }),
      treeOf({ "server.mjs": `process.argv.push("--write-tool");\n${ECHO_SOURCE}` }),
      key,
      new Date(NOW.getTime() + 60_000),
    );
    const r = await propose(s, v2);
    expect(r.card.update?.widened?.tools).toEqual(["shout"]);
    expect(r.card.update?.widened?.payload).toBe(true);
    expect(r.card.toolCheck?.undeclared).toEqual(["shout"]);
  });

  it("L1: an update keeps the earlier keys an older file named", async () => {
    const s = await setup();
    const a = authorKey("Ada");
    const b = authorKey("Ada");
    const st = signRotation(a, b.author, NOW.toISOString());
    await install(s, await propose(s, buildConnectorBundle(model(), new Map(), b, NOW, [st])));
    await install(
      s,
      await propose(
        s,
        buildConnectorBundle(model(), new Map(), b, new Date(NOW.getTime() + 60_000)),
      ),
    );
    const ledger = JSON.parse(readFileSync(join(home, "connectors", "bundles.json"), "utf8"));
    expect(ledger.servers["notes-sync"].signerAncestors).toEqual([a.author.keyId]);
  });

  it("L3: a notice that lands while the card is open blocks the install", async () => {
    const s = await setup();
    const key = authorKey("Ada");
    const text = buildConnectorBundle(model(), new Map(), key, NOW);
    const r = await propose(s, text);
    await approve(s.owner, (r.approval as { id: string }).id);
    const ring = new AuthorRing(join(home, "skills"));
    ring.observe(key.author);
    ring.applyNotice(
      verifyNotice(
        buildNotice(
          key,
          {
            kind: "bundle",
            keyId: key.author.keyId,
            bundleHash: verifyConnectorBundle(text).bundleHash,
            reason: "bad",
          },
          NOW,
        ),
      ),
    );
    const e = await rejects(
      s.owner.call(
        "mcp.add",
        {
          proposalId: (r.proposal as McpProposal).id,
          approvalId: (r.approval as { id: string }).id,
        },
        ik(),
      ),
    );
    expect(e.code).toBe("policy_denied");
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeUndefined();
  });

  it("L6: an unreadable record stops only the servers marked as from a file, and can be reset", async () => {
    const s = await setup();
    await addEcho(s);
    await install(
      s,
      await propose(s, buildConnectorBundle(model(), new Map(), authorKey("Ada"), NOW)),
    );
    writeFileSync(join(home, "connectors", "bundles.json"), "{broken");
    await poke(s);
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeUndefined();
    expect(s.services.tools.get("mcp__echo__echo")).toBeDefined();
    // Resetting sets the broken file aside; the marked server stays off until removed or imported again.
    const r = await s.owner.call<{ restored: boolean }>("connectors.resetRecords", {}, ik());
    expect(r.restored).toBe(false);
    await poke(s);
    expect(s.services.tools.get("mcp__notes-sync__echo")).toBeUndefined();
    expect(s.services.tools.get("mcp__echo__echo")).toBeDefined();
    await s.owner.call("mcp.remove", { serverId: "notes-sync" }, ik());
  });

  it("L9: a connector the first run cannot start says so on the card, in plain words", async () => {
    const s = await setup();
    const text = buildConnectorBundle(
      model({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
      new Map(),
      authorKey("Ada"),
      NOW,
    );
    const r = await propose(s, text);
    expect(r.card.blocker).toBe("probe_failed");
    expect(r.proposal).toBeUndefined();
    expect(
      r.card.findings.some(
        (f) => f.rule === "probe-failed" && /no network and no secrets/.test(f.message),
      ),
    ).toBe(true);
  });
});
