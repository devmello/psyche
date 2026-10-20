import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentPluginRegistry } from "@psyche/agent-core";
import type {
  ApprovalRequest,
  PermissionBroker,
  PluginCapability,
  PluginProposalSchema,
  PluginStatus,
  PluginSummarySchema,
  Surface,
  Unsubscribe,
} from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import {
  readSkillDir,
  type SkillScanFinding,
  type SkillTree,
  scanText,
  skillInstallBinding,
  summarizeFindings,
  textOf,
  treeHash,
} from "@psyche/skills";
import { agentPlugin, type PluginHost, PluginProcess } from "./host.ts";
import { MANIFEST_FILE, type PluginManifest, parseManifest } from "./manifest.ts";

/**
 * Installed code plugins (feature T4) under `$PSYCHE_HOME/plugins/<name>`, pinned by tree hash in
 * `plugins.lock.json`. Installing works like a skill (T2): the folder is read and scanned, a
 * device-only `skill_install` card (details `kind: "plugin"`) shows the manifest, capabilities,
 * files and findings, and `install` needs that exact approval. A plugin installs switched off.
 * It runs only while the admin setting `plugins.enabled` is on, its own switch is on, and its
 * files still hash to the pinned value; each runs in its own restricted process (`host.ts`).
 */

export const LOCK_FILE = "plugins.lock.json";
const PROPOSAL_TTL_MS = 30 * 60_000;

interface LockEntry {
  version: string;
  description: string;
  main: string;
  capabilities: PluginCapability[];
  source: string;
  hash: string;
  enabled: boolean;
  installedAt: string;
  approvalId: string;
  /** High-severity scan findings at install: the plugin cannot be switched on. */
  blocked: boolean;
}

interface Lock {
  version: 1;
  plugins: Record<string, LockEntry>;
}

export interface PluginManagerOptions {
  /** `$PSYCHE_HOME/plugins`. */
  dir: string;
  broker: PermissionBroker;
  /** The loop's plugin registry. */
  registry: AgentPluginRegistry;
  /** The admin setting `plugins.enabled`, read on every sync. */
  enabled: () => boolean;
  surfaces?: Surface[];
  now?: () => number;
  /** Test seam: how a plugin's process is made. */
  host?: (o: {
    name: string;
    dir: string;
    main: string;
    capabilities: PluginCapability[];
    onExit: (r: string) => void;
  }) => PluginHost;
  log?: (message: string, data?: Record<string, string>) => void;
}

interface Running {
  host: PluginHost;
  unregister: Unsubscribe;
  hash: string;
}

export class PluginManager {
  readonly #o: PluginManagerOptions;
  readonly #proposals = new Map<
    string,
    { proposal: PluginProposalSchema; tree: SkillTree; expiresAt: number }
  >();
  readonly #running = new Map<string, Running>();
  readonly #failed = new Map<string, string>();
  #sync: Promise<void> = Promise.resolve();

  constructor(options: PluginManagerOptions) {
    this.#o = options;
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  }

  // --- install ---------------------------------------------------------------------------------

  /** Reads and scans a local folder and opens the device-only trust card. */
  async proposeInstall(
    path: string,
  ): Promise<{ proposal: PluginProposalSchema; approval: ApprovalRequest }> {
    if (!isAbsolute(path)) throw new PsycheError("invalid_params", "path must be absolute");
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new PsycheError("not_found", `${path} does not exist`);
    }
    if (!statSync(real).isDirectory())
      throw new PsycheError("invalid_params", `${path} is not a folder`);
    const tree = readSkillDir(real);
    const manifest = parseManifest(tree);
    const findings = scanTree(tree);
    const hash = treeHash(tree);
    const lock = this.#readLock();
    const current = lock.plugins[manifest.name];
    const binding = pluginBinding(manifest, real, hash);
    const proposal: PluginProposalSchema = {
      id: `plg_${randomUUID()}`,
      manifest,
      source: real,
      hash,
      files: [...tree.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([p, f]) => ({ path: p, bytes: f.bytes.byteLength })),
      findings,
      ...(current === undefined ? {} : { fromHash: current.hash }),
      bindingHash: binding.bindingHash,
    };
    this.#proposals.set(proposal.id, { proposal, tree, expiresAt: this.#now() + PROPOSAL_TTL_MS });
    const counts = summarizeFindings(findings);
    const issued = await this.#o.broker.requestApproval({
      kind: "skill_install",
      summary: `${current === undefined ? "Install" : "Update"} plugin "${manifest.name}" ${manifest.version}${counts.high > 0 ? ` (${counts.high} high-severity findings: it cannot be switched on)` : ""}`,
      details: {
        kind: "plugin",
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        source: { kind: "path", path: real },
        hash,
        // What it can do, first on the card: these capabilities and nothing else.
        capabilities: manifest.capabilities,
        permissions: [],
        tools: [],
        runsIn:
          "its own process: reads only its folder; no file writes, processes, secrets or network",
        sees: describeAccess(manifest.capabilities),
        findings: counts,
        files: proposal.files.map((f) => f.path),
        ...(current === undefined ? {} : { fromHash: current.hash }),
      },
      bindingHash: binding.bindingHash,
      grantKey: binding.grantKey,
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "destructive",
      surfaces: (this.#o.surfaces ?? ["desktop"]).filter((x) => !x.includes(":")),
      scopesOffered: ["once"],
      taint: false,
    });
    return { proposal: structuredClone(proposal), approval: issued.approval };
  }

  getProposal(id: string): PluginProposalSchema {
    const staged = this.#proposals.get(id);
    if (staged === undefined) throw new PsycheError("not_found", "no such plugin proposal");
    return structuredClone(staged.proposal);
  }

  /** Installs exactly the scanned files, switched off, after the approved card. */
  async install(proposalId: string, approvalId: string): Promise<PluginSummarySchema> {
    const staged = this.#proposals.get(proposalId);
    if (staged === undefined) throw new PsycheError("not_found", "no such plugin proposal");
    if (this.#now() > staged.expiresAt) {
      this.#proposals.delete(proposalId);
      throw new PsycheError("approval_expired", "the proposal expired; propose it again");
    }
    const { proposal: p, tree } = staged;
    const approval = await this.#o.broker.get(approvalId);
    if (
      approval === undefined ||
      approval.kind !== "skill_install" ||
      approval.details.kind !== "plugin"
    ) {
      throw new PsycheError("approval_required", "installing a plugin needs its approved card");
    }
    const v = await this.#o.broker.verifyBinding(approvalId, p.bindingHash);
    if (!v.ok) {
      throw new PsycheError(
        v.reason === "binding_mismatch" ? "binding_mismatch" : "approval_required",
        `the plugin's approval is not usable: ${v.reason}`,
      );
    }
    this.#proposals.delete(proposalId);
    const name = p.manifest.name;
    await this.#stop(name);
    writeTree(join(this.#o.dir, name), tree);
    const blocked = summarizeFindings(p.findings).high > 0;
    const lock = this.#readLock();
    lock.plugins[name] = {
      version: p.manifest.version,
      description: p.manifest.description,
      main: p.manifest.main,
      capabilities: [...p.manifest.capabilities],
      source: p.source,
      hash: p.hash,
      enabled: false,
      installedAt: new Date(this.#now()).toISOString(),
      approvalId,
      blocked,
    };
    this.#writeLock(lock);
    this.#failed.delete(name);
    await this.#o.broker.recordReceipt({
      kind: "skill_install",
      outcome: "ok",
      summary: `Installed plugin ${name} ${p.manifest.version} (switched off)`,
      approvalId,
      externalRefs: { plugin: name, hash: p.hash },
    });
    return this.#summary(name, lock.plugins[name] as LockEntry);
  }

  // --- switches --------------------------------------------------------------------------------

  async setEnabled(name: string, enabled: boolean): Promise<PluginSummarySchema> {
    const lock = this.#readLock();
    const entry = lock.plugins[name];
    if (entry === undefined) throw new PsycheError("not_found", `no plugin named ${name}`);
    if (enabled && entry.blocked) {
      throw new PsycheError("policy_denied", `plugin ${name} had high-severity scan findings`);
    }
    entry.enabled = enabled;
    this.#writeLock(lock);
    this.#failed.delete(name);
    await this.sync();
    return this.#summary(name, entry);
  }

  async remove(name: string): Promise<void> {
    const lock = this.#readLock();
    if (lock.plugins[name] === undefined)
      throw new PsycheError("not_found", `no plugin named ${name}`);
    await this.#stop(name);
    delete lock.plugins[name];
    this.#writeLock(lock);
    rmSync(join(this.#o.dir, name), { recursive: true, force: true });
    this.#failed.delete(name);
  }

  list(): PluginSummarySchema[] {
    const lock = this.#readLock();
    return Object.entries(lock.plugins)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, e]) => this.#summary(name, e));
  }

  // --- running ---------------------------------------------------------------------------------

  /**
   * Starts what should run and stops what should not: the admin setting, each switch, and the
   * pinned hash decide. Serialized, so overlapping setting changes never double-start.
   */
  sync(): Promise<void> {
    this.#sync = this.#sync.then(() => this.#doSync()).catch(() => undefined);
    return this.#sync;
  }

  async stopAll(): Promise<void> {
    for (const name of [...this.#running.keys()]) await this.#stop(name);
  }

  async #doSync(): Promise<void> {
    const lock = this.#readLock();
    const on = this.#o.enabled();
    for (const name of [...this.#running.keys()]) {
      const e = lock.plugins[name];
      if (!on || e === undefined || !e.enabled || this.#running.get(name)?.hash !== e.hash) {
        await this.#stop(name);
      }
    }
    if (!on) return;
    for (const [name, e] of Object.entries(lock.plugins)) {
      if (!e.enabled || e.blocked || this.#running.has(name) || this.#failed.has(name)) continue;
      const dir = join(this.#o.dir, name);
      let hash: string;
      try {
        hash = treeHash(readSkillDir(dir));
      } catch {
        this.#failed.set(name, "its files cannot be read");
        continue;
      }
      if (hash !== e.hash) continue; // `hash_mismatch`: never run changed files.
      const host = (this.#o.host ?? ((o) => new PluginProcess(o)))({
        name,
        dir: realpathSync(dir),
        main: e.main,
        capabilities: e.capabilities,
        onExit: (reason) => {
          this.#failed.set(name, reason);
          void this.#stop(name);
          this.#o.log?.("plugin stopped", { name, reason });
        },
      });
      try {
        await host.start();
      } catch (err) {
        this.#failed.set(name, (err as Error).message);
        this.#o.log?.("plugin failed to start", { name, error: (err as Error).message });
        continue;
      }
      const unregister = this.#o.registry.register(agentPlugin(host, e.capabilities));
      this.#running.set(name, { host, unregister, hash });
    }
  }

  async #stop(name: string): Promise<void> {
    const r = this.#running.get(name);
    if (r === undefined) return;
    this.#running.delete(name);
    r.unregister();
    r.host.stop();
  }

  #status(name: string, e: LockEntry): PluginStatus {
    if (this.#failed.has(name)) return "failed";
    if (!e.enabled) return "disabled";
    if (!this.#o.enabled()) return "off";
    if (this.#running.has(name)) return "active";
    try {
      if (treeHash(readSkillDir(join(this.#o.dir, name))) !== e.hash) return "hash_mismatch";
    } catch {
      return "invalid";
    }
    return "disabled";
  }

  #summary(name: string, e: LockEntry): PluginSummarySchema {
    const error = this.#failed.get(name);
    return {
      name,
      version: e.version,
      description: e.description,
      capabilities: [...e.capabilities],
      source: e.source,
      hash: e.hash,
      enabled: e.enabled,
      status: this.#status(name, e),
      installedAt: e.installedAt,
      ...(error === undefined ? {} : { error }),
    };
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  #readLock(): Lock {
    const path = join(this.#o.dir, LOCK_FILE);
    if (!existsSync(path)) return { version: 1, plugins: {} };
    try {
      const lock = JSON.parse(readFileSync(path, "utf8")) as Lock;
      return lock.version === 1 && typeof lock.plugins === "object"
        ? lock
        : { version: 1, plugins: {} };
    } catch {
      return { version: 1, plugins: {} };
    }
  }

  #writeLock(lock: Lock): void {
    const path = join(this.#o.dir, LOCK_FILE);
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
}

/**
 * The `skill_install` binding over the plugin: name, source, tree hash (which covers the manifest
 * and code), and the capabilities as `plugin:<capability>` tools, so a skill's card can never
 * install a plugin of the same folder and a plugin's card says what it can do.
 */
export function pluginBinding(manifest: PluginManifest, source: string, hash: string) {
  return skillInstallBinding({
    name: manifest.name,
    scope: "home",
    source: { kind: "path", path: source },
    treeHash: hash,
    tools: manifest.capabilities.map((c) => `plugin:${c}`),
    permissions: [],
    prompts: [],
  });
}

/** What the plugin will see, in plain words for the trust card. */
function describeAccess(capabilities: readonly PluginCapability[]): string[] {
  const words: Record<PluginCapability, string> = {
    context: "adds text to the agent's prompt (marked untrusted)",
    before_tool_call: "sees each tool call's name and arguments and may block it",
    after_tool_call: "sees each finished call's tool name and status (not its output)",
    agent_end: "sees how each run ended",
    evaluate: "sees a task's goal and receipts and may ask for more work",
  };
  return capabilities.map((c) => words[c]);
}

function scanTree(tree: SkillTree): SkillScanFinding[] {
  const out: SkillScanFinding[] = [];
  for (const [path, file] of tree) {
    if (path === MANIFEST_FILE) continue;
    const text = textOf(file);
    if (text !== undefined) out.push(...scanText(path, text));
  }
  return out;
}

function writeTree(target: string, tree: SkillTree): void {
  const staging = `${target}.${randomUUID().slice(0, 8)}.installing`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const [path, file] of tree) {
    const full = join(staging, path);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    writeFileSync(full, file.bytes, { mode: 0o600 });
    // Plugins never execute files directly; nothing is installed executable.
    chmodSync(full, 0o600);
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
}
