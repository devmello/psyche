import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentPluginRegistry } from "@psyche/agent-core";
import type { ApprovalRequestInput, IssuedApproval } from "@psyche/protocol";
import { readSkillDir } from "@psyche/skills";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginManager, PluginProcess, parseManifest } from "../src/index.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const run = {
  threadId: "thr_1",
  runId: "run_1",
  permissionMode: "balanced",
  mode: "attended",
  taint: false,
};

let dir: string;
let hosts: PluginProcess[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-plugins-")));
});
afterEach(async () => {
  await Promise.all(hosts.map((h) => h.stop()));
  hosts = [];
  rmSync(dir, { recursive: true, force: true });
});

function host(name: string, capabilities: ("context" | "before_tool_call")[]) {
  const h = new PluginProcess({ name, dir: join(FIXTURES, name), main: "index.mjs", capabilities });
  hosts.push(h);
  return h;
}

describe("plugin manifests", () => {
  it("parses a valid manifest and refuses a main outside the folder", () => {
    const tree = readSkillDir(join(FIXTURES, "office-hours"));
    expect(parseManifest(tree)).toMatchObject({
      name: "office-hours",
      capabilities: ["before_tool_call", "context"],
    });
    const bad = new Map(tree);
    bad.set("psyche-plugin.json", {
      bytes: new TextEncoder().encode(
        JSON.stringify({
          name: "x",
          version: "1",
          description: "",
          main: "../x.js",
          capabilities: ["context"],
        }),
      ),
      executable: false,
    });
    expect(() => parseManifest(bad)).toThrow(/main must be/);
  });
});

describe("plugin processes", () => {
  it("answer declared capabilities over the host protocol", async () => {
    const h = host("office-hours", ["context", "before_tool_call"]);
    await h.start();
    expect(await h.call("context", run)).toEqual([
      { title: "Office hours", text: "The owner works 09:00-17:00 Pacific." },
    ]);
    expect(await h.call("before_tool_call", { ...run, tool: "notify" })).toEqual({
      block: "notifications wait until office hours",
    });
    expect(await h.call("before_tool_call", { ...run, tool: "notes.save" })).toBeNull();
  });

  it("stop only once the process is gone, so its folder can be removed at once", async () => {
    // A copy: on Windows a live process holds its working directory, the plugin's folder.
    const copy = join(dir, "office-hours");
    cpSync(join(FIXTURES, "office-hours"), copy, { recursive: true });
    const h = new PluginProcess({
      name: "office-hours",
      dir: copy,
      main: "index.mjs",
      capabilities: ["context", "before_tool_call"],
    });
    await h.start();
    await h.stop();
    rmSync(copy, { recursive: true });
    expect(existsSync(copy)).toBe(false);
    await expect(h.call("context", run)).rejects.toThrow(/not running/);
    await h.stop();
  });

  it("run without secrets, outside reads, writes, processes or network", async () => {
    const h = host("probe", ["context"]);
    await h.start();
    const [section] = (await h.call("context", run)) as { text: string }[];
    expect(section?.text.split(" ")).toEqual([
      "read-outside:refused",
      "read-own:allowed",
      "write:refused",
      "exec:refused",
      "connect:refused",
      "fetch:refused",
      "env:0",
    ]);
  });

  it("refuse to start a plugin that registers a capability it did not declare", async () => {
    const h = host("undeclared", ["context"]);
    await expect(h.start()).rejects.toThrow(/not declared/);
  });
});

describe("plugin install and switches", () => {
  async function setup(enabled = { on: false }) {
    const clock = new FakeClock();
    const broker = new RecordingBroker({ clock });
    const registry = new AgentPluginRegistry();
    const manager = new PluginManager({
      dir: join(dir, "plugins"),
      broker,
      registry,
      enabled: () => enabled.on,
      now: () => clock.now(),
    });
    const source = join(dir, "src-office-hours");
    cpSync(join(FIXTURES, "office-hours"), source, { recursive: true });
    const { proposal, approval } = await manager.proposeInstall(source);
    return { clock, broker, registry, manager, proposal, approval, source, enabled };
  }

  it("shows the skill trust card for a plugin and installs it switched off after approval", async () => {
    const s = await setup();
    expect(s.approval).toMatchObject({
      kind: "skill_install",
      scopesOffered: ["once"],
      details: {
        kind: "plugin",
        name: "office-hours",
        capabilities: ["before_tool_call", "context"],
        files: ["index.mjs", "psyche-plugin.json"],
      },
    });
    expect(s.approval.summary).toBe('Install plugin "office-hours" 1.0.0');
    // Not approved yet: refused.
    await expect(s.manager.install(s.proposal.id, s.approval.id)).rejects.toMatchObject({
      code: "approval_required",
    });
    s.clock.advance(500);
    await approve(s.broker, s.approval.id);
    const plugin = await s.manager.install(s.proposal.id, s.approval.id);
    expect(plugin).toMatchObject({ name: "office-hours", enabled: false, status: "disabled" });
    const receipts = await s.broker.listReceipts();
    expect(receipts.at(-1)).toMatchObject({
      kind: "skill_install",
      externalRefs: { plugin: "office-hours" },
    });
  });

  it("counts what the folder really adds, whatever the manifest declares", async () => {
    const s0 = await setup();
    s0.clock.advance(500);
    await approve(s0.broker, s0.approval.id);
    const first = await s0.manager.install(s0.proposal.id, s0.approval.id);
    // office-hours declares a before_tool_call hook and ships nothing else.
    expect(first.adds).toEqual({ skills: 0, commands: 0, mcpServers: 0, hooks: 1 });

    const source = join(dir, "src-with-adds");
    cpSync(join(FIXTURES, "office-hours"), source, { recursive: true });
    const manifestPath = join(source, "psyche-plugin.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.name = "adds-demo";
    // An understating manifest: it claims nothing, the folder holds more.
    m.adds = { skills: [], commands: [], mcpServers: [], hooks: [] };
    writeFileSync(manifestPath, JSON.stringify(m));
    mkdirSync(join(source, "skills/a"), { recursive: true });
    mkdirSync(join(source, "skills/b"), { recursive: true });
    mkdirSync(join(source, "commands"), { recursive: true });
    writeFileSync(join(source, "skills/a/SKILL.md"), "---\nname: a\n---\n");
    writeFileSync(join(source, "skills/b/SKILL.md"), "---\nname: b\n---\n");
    writeFileSync(join(source, "commands/c.md"), "c\n");
    writeFileSync(
      join(source, ".mcp.json"),
      JSON.stringify({ mcpServers: { m: { command: "x" }, n: { command: "y" } } }),
    );
    mkdirSync(join(source, "hooks"), { recursive: true });
    writeFileSync(join(source, "hooks/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [] } }));
    const { proposal, approval } = await s0.manager.proposeInstall(source);
    s0.clock.advance(500);
    await approve(s0.broker, approval.id);
    const plugin = await s0.manager.install(proposal.id, approval.id);
    expect(plugin.adds).toEqual({ skills: 2, commands: 1, mcpServers: 2, hooks: 2 });
    expect(s0.manager.list().find((x) => x.name === "adds-demo")?.adds).toEqual(plugin.adds);
  });

  it("runs only with the setting and its switch on, and never with changed files", async () => {
    const s = await setup();
    s.clock.advance(500);
    await approve(s.broker, s.approval.id);
    await s.manager.install(s.proposal.id, s.approval.id);
    await s.manager.setEnabled("office-hours", true);
    expect(s.manager.list()[0]?.status).toBe("off");
    expect(s.registry.list()).toEqual([]);
    s.enabled.on = true;
    await s.manager.sync();
    expect(s.manager.list()[0]?.status).toBe("active");
    const [plugin] = s.registry.list();
    expect(plugin?.capabilities).toEqual(["before_tool_call", "context"]);
    expect(
      await plugin?.beforeToolCall?.({
        ...run,
        toolCallId: "c",
        tool: "notify",
        sideEffect: "write",
        params: {},
      } as never),
    ).toEqual({
      block: "notifications wait until office hours",
    });
    // Switching off stops it; changed files are never run.
    await s.manager.setEnabled("office-hours", false);
    expect(s.registry.list()).toEqual([]);
    writeFileSync(join(dir, "plugins", "office-hours", "index.mjs"), "export default () => {};\n");
    await s.manager.setEnabled("office-hours", true);
    expect(s.registry.list()).toEqual([]);
    expect(s.manager.list()[0]?.status).toBe("hash_mismatch");
    await s.manager.remove("office-hours");
    expect(s.manager.list()).toEqual([]);
    await s.manager.stopAll();
  });
});

/** Keeps the answer tokens it issues, so the test can answer like the owner's device. */
class RecordingBroker extends FakePermissionBroker {
  readonly issued: IssuedApproval[] = [];

  override async requestApproval(input: ApprovalRequestInput): Promise<IssuedApproval> {
    const issued = await super.requestApproval(input);
    this.issued.push(issued);
    return issued;
  }
}

async function approve(broker: RecordingBroker, approvalId: string) {
  const issued = broker.issued.find((i) => i.approval.id === approvalId);
  const surface = Object.keys(issued?.answerTokens ?? {})[0] ?? "desktop";
  await broker.answer({
    approvalId,
    answerToken: issued?.answerTokens[surface] ?? "",
    decision: "approve",
    decidedBy: { deviceId: "dev_owner", surface },
  });
}
