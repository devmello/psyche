import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { getSetting } from "@psyche/db";
import { ensureOwnerOnly } from "@psyche/hostfs";
import { type PsycheMcpServerConfig, validateEnv } from "@psyche/mcp-host";
import {
  type BundleSigner,
  type ConnectorBundleCard,
  MCP_PRESETS,
  type McpProposal,
  type McpServerInput,
  PsycheError,
  type ScanFinding,
} from "@psyche/protocol";
import {
  AuthorKeyStore,
  AuthorRing,
  argvSuspectAfterFlag,
  type BundleFetchOptions,
  buildConnectorBundle,
  CONNECTOR_EXTENSION,
  ConnectorLedger,
  type ConnectorLedgerRecord,
  type ConnectorModel,
  type ConnectorRequests,
  canonicalJson,
  checkRequests,
  connectorWidenedBy,
  DEFAULT_LIMITS,
  fetchBundleText,
  normalizeRequests,
  quoteForSummary,
  type RingUndo,
  readSkillDir,
  SECRET_SHAPED_NAME,
  type SkillTree,
  scanConnector,
  type TreeLimits,
  textOf,
  treeHash,
  unifiedDiff,
  type VerifiedConnectorBundle,
  verifyConnectorBundle,
} from "@psyche/skills";
import type { Call, HandlerDef } from "../context.ts";
import { type McpAdder, serverConfig, sideEffectOf } from "./mcp-add.ts";
import type { ComposeServices } from "./services.ts";
import { signGate } from "./skills.ts";

/**
 * Shared connectors (docs/design/shared-bundles-2026.md section 8): the `.psyche-connector` file.
 *
 * - **Export** (`connectors.export`): Host shell only, a device-only card or fresh presence that
 *   names exactly what the file will say, audited. Only a command server the owner set up on this
 *   Mac can be exported (not one Psyche wrote, a bundled one, a URL server, or one that itself came
 *   from a bundle), and the file carries names only: no env or secret value, ever.
 * - **Import** (`connectors.proposeImport`, from a file or an https link): the whole card first,
 *   then the existing `mcp.probe` path (the first run is the sandboxed probe; with no sandbox the
 *   card says so and nothing is staged), then `mcp.add` with the approved card, then the owner
 *   fills in the secrets by name. An update shows the diff and is flagged when it widens.
 * - **The agent has no part in any of it**: these are admin-scope owner methods, a skill cannot
 *   declare them (`SKILL_FORBIDDEN_TOOLS`), and no agent tool calls them.
 */

export const CONNECTOR_BUNDLES_DIR = "connector-bundles";
/** Text shown on the card per file and in total; the rest is listed without its text. */
const FILE_TEXT_CAP = 100_000;
const TOTAL_TEXT_CAP = 400_000;
/** A version directory nobody installed is removed after this long. */
const STALE_DIR_MS = 60 * 60_000;

const removeTree = (dir: string) => rmSync(dir, { recursive: true, force: true });

/**
 * For a folder a server ran from: Windows keeps it locked while the process that just stopped is
 * still going away, so this waits (without blocking) for the lock to go.
 */
const removeTreeLater = (dir: string) =>
  rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

/** Names Psyche uses itself: the ready-made servers, and the old "Files on this Mac" connector. */
const RESERVED_IDS = new Set<string>(["filesystem", ...MCP_PRESETS.map((x) => x.id)]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);

export interface ConnectorBundlesDeps {
  services: ComposeServices;
  settingKey: string;
  adder: McpAdder;
  /** How command servers are isolated right now. */
  sandbox(): Promise<"srt" | "container" | "none">;
  /** The tools a running server lists; undefined while it is off or did not connect. */
  tools(serverId: string): { name: string; annotations?: unknown }[] | undefined;
  /** Tests: the pinned transport and DNS for a link. */
  fetchOptions?: BundleFetchOptions;
  limits?: TreeLimits;
}

export interface ConnectorBundles {
  handlers: Record<string, HandlerDef>;
  /** Why an installed server from a bundle must not run (revoked, files changed), if so. */
  stale(entry: PsycheMcpServerConfig): Promise<string | undefined>;
  /** A server was added by hand or by Psyche: forget any record left under its id. */
  added(entry: PsycheMcpServerConfig): Promise<void>;
  /** A server was removed: forget its bundle record and its files. */
  removed(entry: PsycheMcpServerConfig): Promise<void>;
  /** The export, for direct calls (tests). */
  exportConnector(
    call: Call,
    p: { serverId: string; authorName?: string; approvalId?: string },
    payload?: SkillTree,
  ): Promise<{
    filename: string;
    bundle: string;
    signer: { keyId: string; name: string };
    createdKey: boolean;
    bundleHash: string;
  }>;
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const bad = (msg: string): never => {
  throw new PsycheError("invalid_params", msg);
};

function readEntries(services: ComposeServices, key: string): PsycheMcpServerConfig[] {
  const v = getSetting(services.db, key)?.value;
  return Array.isArray(v) ? (v as PsycheMcpServerConfig[]) : [];
}

export function connectorBundles(deps: ConnectorBundlesDeps): ConnectorBundles {
  const { services } = deps;
  const home = services.home;
  const now = () => new Date(services.clock.now());
  const ring = new AuthorRing(join(home, "skills"), () => services.clock.now());
  const keys = new AuthorKeyStore(home);
  const ledger = new ConnectorLedger(home, () => services.clock.now());
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const root = join(home, CONNECTOR_BUNDLES_DIR);

  const audit = (kind: string, subject: Record<string, string>, data: Record<string, string>) =>
    services.audit.append({ kind, actor: { type: "user" }, subject, data });

  // --- export ---------------------------------------------------------------------------------

  /** Names and domains of an owner's command server. Values never leave this function. */
  const modelOf = (
    entry: PsycheMcpServerConfig,
    tools: { name: string; annotations?: unknown }[],
  ): ConnectorModel => {
    const t = entry.transport;
    if (t.kind !== "stdio")
      return bad("only a command server can be shared; a URL server is just its link");
    const env: string[] = [];
    const secrets: { name: string; purpose: string }[] = [];
    for (const [name, value] of Object.entries(t.env ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name))
        return bad(
          `the variable ${name.slice(0, 40)} cannot be shared (use capital letters and _)`,
        );
      // A vault reference, or anything named like a secret, is a secret; its value stays here.
      if (value.includes("{{cred:") || SECRET_SHAPED_NAME.test(name))
        secrets.push({ name, purpose: "" });
      else env.push(name);
    }
    const [command, ...args] = t.command;
    if (command === undefined) return bad("the connector has no command");
    return {
      name: entry.id,
      title: entry.name,
      ...(entry.version === undefined ? {} : { version: entry.version }),
      description: "",
      requests: normalizeRequests({
        command,
        args,
        env,
        secrets,
        network: entry.sandbox?.allowedDomains ?? [],
        tools: tools.map((x) => ({ name: x.name, sideEffect: sideEffectOf(x.annotations) })),
      }),
    };
  };

  const exportConnector: ConnectorBundles["exportConnector"] = async (call, p, payload) => {
    const entry = readEntries(services, deps.settingKey).find((c) => c.id === p.serverId);
    if (entry === undefined) throw new PsycheError("not_found", `no MCP server ${p.serverId}`);
    if (entry.madeBy === "psyche")
      return bad("Psyche wrote that connector; only connectors you set up can be shared");
    if (entry.trust === "bundled") return bad("a bundled connector cannot be shared");
    if (entry.bundle !== undefined || ledger.get(entry.id) !== undefined)
      return bad(
        "that connector came from a shared file; only connectors you set up can be shared",
      );
    if (entry.transport.kind !== "stdio")
      return bad("only a command server can be shared; a URL server is just its link");
    const tools = deps.tools(entry.id);
    if (tools === undefined)
      throw new PsycheError(
        "unavailable",
        "the connector is off or did not start, so its tools cannot be listed; turn it on first",
      );
    if (keys.peek() === undefined && (p.authorName === undefined || p.authorName.trim() === ""))
      return bad("Choose the name to sign your connectors with; everyone who imports them sees it");
    const model = modelOf(entry, tools);
    // Caps first (62 arguments, 1,000 characters each), so a huge argument is refused before it is scanned.
    checkRequests(model.requests);
    const tree = payload ?? new Map();
    // Anything that looks like a secret on the command line or in a script stays out of the file.
    const high = scanConnector(model.requests, tree).filter((f) => f.severity === "high");
    if (high.length > 0)
      throw new PsycheError(
        "policy_denied",
        `the connector cannot be shared: ${high[0]?.message ?? "a scan finding"}`,
        { details: { rules: high.map((f) => f.rule) } },
      );
    const r = model.requests;
    // A random-looking value right after a flag is a credential, on export.
    const afterFlag = argvSuspectAfterFlag(r.args);
    if (afterFlag.length > 0)
      throw new PsycheError(
        "policy_denied",
        `the connector cannot be shared: ${afterFlag[0]}; a command line is visible to every process`,
        { details: { rules: ["credential-in-argv"] } },
      );
    const requestsHash = sha(canonicalJson({ model, tree: treeHash(tree) }));
    const summary = `Sign connector "${entry.id}" with your author key`;
    await signGate(
      services,
      call,
      {
        method: "connectors.export",
        tag: `export-connector:${entry.id}`,
        summary,
        subject: { serverId: entry.id, requestsHash },
        treeHash: requestsHash,
        details: {
          kind: "connector_export",
          serverId: entry.id,
          // The whole command line, one item per argument, nothing cut off: what is signed is
          // exactly what is shown.
          command: [r.command, ...r.args].join(" "),
          argv: [r.command, ...r.args],
          // Who signs, and whether this export makes the key.
          signAs: keys.peek()?.name ?? (p.authorName ?? "").trim(),
          newKey: keys.peek() === undefined,
          env: r.env,
          secrets: r.secrets.map((s) => s.name),
          network: r.network,
          tools: r.tools.map((x) => `${x.sideEffect} ${x.name}`),
          files: [...tree.keys()],
          note: "Names only. No env or secret value is included, and the command line was checked for anything that looks like a credential.",
        },
      },
      p.approvalId,
    );
    // Same bytes as the card named: a server edited since is not signed.
    const again = readEntries(services, deps.settingKey).find((c) => c.id === entry.id);
    const liveTools = deps.tools(entry.id);
    if (again === undefined || liveTools === undefined)
      throw new PsycheError("conflict", "the connector changed after you approved the export");
    const model2 = modelOf(again, liveTools);
    if (sha(canonicalJson({ model: model2, tree: treeHash(tree) })) !== requestsHash)
      throw new PsycheError("conflict", "the connector changed after you approved the export");
    const { signer, created } = keys.loadOrCreate(p.authorName);
    const bundle = buildConnectorBundle(model2, tree, signer, now(), keys.chain());
    const verified = verifyConnectorBundle(bundle, limits);
    // Audit first and awaited: a signature that left no record is never returned.
    if (created)
      await services.audit.append({
        kind: "skill.author_key_created",
        actor: { type: "user" },
        subject: { keyId: signer.author.keyId },
        data: { name: signer.author.name },
      });
    await audit(
      "connector.exported",
      { serverId: entry.id },
      { keyId: signer.author.keyId, bundleHash: verified.bundleHash },
    );
    return {
      filename: `${entry.id}${CONNECTOR_EXTENSION}`,
      bundle,
      signer: { keyId: signer.author.keyId, name: signer.author.name },
      createdKey: created,
      bundleHash: verified.bundleHash,
    };
  };

  // --- import ---------------------------------------------------------------------------------

  const versionDir = (id: string, tree: SkillTree) =>
    join(
      root,
      id,
      treeHash(tree)
        .replace(/^sha256:/, "")
        .slice(0, 16),
    );

  /** Writes the payload tree to its own version directory, never over an installed one. */
  const writePayload = (id: string, tree: SkillTree): string => {
    const dir = versionDir(id, tree);
    const existing = (() => {
      try {
        return treeHash(readSkillDir(dir, limits)) === treeHash(tree);
      } catch {
        return false;
      }
    })();
    if (existing) return dir;
    removeTree(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") ensureOwnerOnly(dir);
    else chmodSync(dir, 0o700);
    for (const [path, file] of tree) {
      const target = join(dir, path);
      // Paths were verified normal; this keeps a bug from ever writing outside the directory.
      if (!target.startsWith(`${dir}${sep}`)) bad(`unsafe path ${path.slice(0, 80)}`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    }
    return dir;
  };

  /** Removes version directories of this id nobody installed and no card is waiting on. */
  const pruneDirs = (id: string, keep: ReadonlySet<string>) => {
    const base = join(root, id);
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      return;
    }
    for (const n of names) {
      const dir = join(base, n);
      if (keep.has(dir)) continue;
      try {
        if (Date.now() - statSync(dir).mtimeMs > STALE_DIR_MS) removeTree(dir);
      } catch {
        // Gone already.
      }
    }
  };

  const textFiles = (tree: SkillTree) => {
    let total = 0;
    return [...tree.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, f]) => {
        const body = textOf(f);
        let text: string | undefined;
        if (
          body !== undefined &&
          body.length <= FILE_TEXT_CAP &&
          total + body.length <= TOTAL_TEXT_CAP
        ) {
          total += body.length;
          text = body;
        }
        return {
          path,
          bytes: f.bytes.byteLength,
          executable: f.executable,
          ...(text === undefined ? {} : { text }),
        };
      });
  };

  const argv = (r: ConnectorRequests) => [r.command, ...r.args];

  const proposeImport = async (p: {
    name?: string;
    text?: string;
    bundleUrl?: string;
  }): Promise<{ card: ConnectorBundleCard; proposal?: McpProposal; approval?: unknown }> => {
    if ((p.text === undefined) === (p.bundleUrl === undefined))
      return bad("give either the file's text or a link, not both");
    const text = p.text ?? (await fetchBundleText(p.bundleUrl as string, deps.fetchOptions));
    const v: VerifiedConnectorBundle = verifyConnectorBundle(text, limits);
    const m = v.manifest;
    const r = m.requests;
    // The names the host would refuse anyway, refused before a card exists.
    try {
      validateEnv(
        Object.fromEntries([...r.env, ...r.secrets.map((s) => s.name)].map((n) => [n, ""])),
      );
    } catch (err) {
      throw new PsycheError("policy_denied", PsycheError.from(err).message);
    }
    if (ring.isBundleRevoked(v.bundleHash, v.signer?.keyId))
      throw new PsycheError(
        "policy_denied",
        "an author's signed notice marked this exact bundle as bad; it is not installed",
        { details: { bundleHash: v.bundleHash } },
      );
    // Two keys claiming to replace one earlier key: refused until one of them is revoked.
    if (v.signer !== undefined) ring.assertNoFork(v.signer.keyId, v.ancestors);
    // A name Psyche already uses (a ready-made server, or the old "Files on this Mac" one) is not
    // something a file may take.
    if (RESERVED_IDS.has(m.name))
      throw new PsycheError(
        "conflict",
        `${m.name} is a name Psyche uses itself; ask the author to name the connector something else`,
      );
    const entries = readEntries(services, deps.settingKey);
    const installedEntry = entries.find((c) => c.id === m.name);
    const rec = ledger.get(m.name);
    // It is an update only when the server in the list is the very one the record describes. A
    // hand-added server, or one whose record is for another file, is never treated as one (its
    // values must not be carried to a file's command).
    if (installedEntry !== undefined && installedEntry.bundle === undefined)
      throw new PsycheError(
        "conflict",
        `an MCP server named ${m.name} is already set up here and did not come from a shared file; remove it first`,
      );
    if (installedEntry !== undefined && rec === undefined)
      throw new PsycheError(
        "conflict",
        `${m.name} came from a shared file but its record is missing; remove it, or reset the records in Settings`,
      );
    if (installedEntry !== undefined && installedEntry.bundle?.hash !== rec?.bundleHash)
      throw new PsycheError(
        "conflict",
        `${m.name}'s record is for a different file than the one installed; remove it, or reset the records in Settings`,
      );
    const update = installedEntry !== undefined && rec !== undefined ? rec : undefined;
    // A record with no server in the list is an orphan: it describes nothing that runs.
    if (installedEntry === undefined && rec !== undefined) ledger.remove(m.name);
    // A file that drops its signature over a signed install is refused, not just flagged.
    if (update?.signerKeyId !== undefined && v.signer === undefined)
      throw new PsycheError(
        "policy_denied",
        "the installed version is signed and this file is not; a signed connector is not replaced by an unsigned one",
      );
    const installedSigner =
      update === undefined
        ? undefined
        : update.signerKeyId === undefined
          ? null
          : { keyId: update.signerKeyId };
    const own = keys.peek();
    const signer: BundleSigner =
      v.signer === undefined
        ? { status: "unsigned", signerChanged: installedSigner != null }
        : ring.statusOf(v.signer, own, installedSigner, {
            ancestors: v.ancestors,
            ownRetired: keys.retiredKeyIds(),
          });
    if (signer.status === "revoked")
      throw new PsycheError("policy_denied", "this bundle is signed by a key you revoked", {
        details: { keyId: signer.keyId ?? "" },
      });
    const previousEnv = (): Record<string, string> => {
      const e = installedEntry?.transport;
      return e?.kind === "stdio" ? (e.env ?? {}) : {};
    };

    const widened = connectorWidenedBy(
      update === undefined ? undefined : { requests: update.requests, treeHash: update.treeHash },
      { requests: r, treeHash: v.manifest.payload.treeHash },
    );
    const findings: ScanFinding[] = scanConnector(r, v.tree);
    if (SHELLS.has((r.command.split("/").pop() ?? "").toLowerCase()))
      findings.push({
        rule: "runs-through-a-shell",
        severity: "warn",
        message: "the command is a shell, so what it does is in its arguments",
      });
    if (signer.retired === true)
      findings.push({
        rule: "retired-key",
        severity: "warn",
        message:
          signer.status === "own"
            ? "signed with a key of yours that you replaced; it is not treated as yours any more"
            : "this key was replaced by a rotation you have seen; a new file from it is suspect",
      });
    if (signer.status === "rotated")
      findings.push({
        rule: "signer-rotated",
        severity: "warn",
        message:
          "same author, new key (signed by the old key); the new key is not trusted until you trust it",
      });
    if (signer.status === "changed" || signer.signerChanged)
      findings.push({
        rule: "signer-changed",
        severity: "warn",
        message:
          v.signer === undefined
            ? "the installed version was signed; this one is not"
            : "the author's key is not the one seen before; check it is the same person",
      });
    if (signer.nameChanged === true)
      findings.push({
        rule: "signer-name-changed",
        severity: "warn",
        message: "a key you trust is signing under a name it has not used before",
      });
    if (update !== undefined && Date.parse(m.createdAt) < Date.parse(update.createdAt))
      findings.push({
        rule: "older-than-installed",
        severity: "warn",
        message: "this bundle was made before the installed version; it may be a rollback",
      });

    // Which of the owner's values an update may keep: only from the same key (or a rotation from
    // it to a key the owner trusts), and only when the command, scripts and network did not widen.
    const sameKey = update?.signerKeyId !== undefined && v.signer?.keyId === update.signerKeyId;
    const rotatedToTrusted =
      update?.signerKeyId !== undefined &&
      v.signer !== undefined &&
      ring.vouching(v.ancestors).includes(update.signerKeyId) &&
      ring.get(v.signer.keyId)?.state === "trusted";
    const mayCarry =
      update !== undefined &&
      (sameKey || rotatedToTrusted) &&
      widened?.command !== true &&
      widened?.payload !== true &&
      (widened?.network.length ?? 0) === 0;
    const names = [...r.env, ...r.secrets.map((x) => x.name)];
    const prevEnv = previousEnv();
    const had = names.filter((n) => (prevEnv[n] ?? "") !== "");
    const carried = mayCarry ? had : [];
    const cleared = mayCarry ? [] : had;

    // What an update asks for beyond the installed version. Tools are judged by what the
    // sandboxed probe really listed, against what was listed when the installed one was approved,
    // not by the file's own claims.
    const RANK = ["read", "write", "destructive"];
    const widenedFor = (found: Pick<McpProposal, "tools">) => {
      if (update === undefined) return undefined;
      const before = update.probedTools ?? update.requests.tools;
      const tools = found.tools
        .filter((t) => {
          const was = before.find((x) => x.name === t.name);
          return was === undefined || RANK.indexOf(t.sideEffect) > RANK.indexOf(was.sideEffect);
        })
        .map((t) => t.name);
      const w = {
        command: widened?.command ?? false,
        env: widened?.env ?? [],
        secrets: widened?.secrets ?? [],
        network: widened?.network ?? [],
        tools,
        payload: widened?.payload ?? false,
      };
      return w.command ||
        w.payload ||
        w.env.length + w.secrets.length + w.network.length + tools.length > 0
        ? w
        : undefined;
    };
    let probed: McpProposal["tools"] = [];
    const undo: RingUndo = { pairs: [] };

    // The update view: the command, then each bundled file, against what was approved before.
    let diff = "";
    if (update !== undefined) {
      diff += unifiedDiff("command", argv(update.requests).join("\n"), argv(r).join("\n"));
      let before: SkillTree = new Map();
      try {
        if (update.dir !== undefined) before = readSkillDir(update.dir, limits);
      } catch {
        before = new Map();
      }
      for (const path of [...new Set([...before.keys(), ...v.tree.keys()])].sort()) {
        const a = before.get(path);
        const b = v.tree.get(path);
        diff += unifiedDiff(
          path,
          a === undefined ? undefined : textOf(a),
          b === undefined ? undefined : textOf(b),
        );
      }
    }

    const sandbox = await deps.sandbox();
    const card: ConnectorBundleCard = {
      serverId: m.name,
      title: m.title,
      description: m.description,
      ...(m.version === undefined ? {} : { version: m.version }),
      createdAt: m.createdAt,
      bytes: v.bytes,
      bundleHash: v.bundleHash,
      signer,
      command: argv(r),
      env: r.env,
      secrets: r.secrets,
      network: r.network,
      declaredTools: r.tools,
      files: textFiles(v.tree),
      findings,
      sandbox,
      ...(update === undefined
        ? {}
        : {
            update: {
              ...(update.version === undefined ? {} : { installedVersion: update.version }),
              installedBundleHash: update.bundleHash,
              ...(widened === undefined ? {} : { widened }),
              diff,
              installedCommand: argv(update.requests),
              signerChanged: signer.signerChanged,
              carried,
              cleared,
            },
          }),
    };
    if (findings.some((f) => f.severity === "high")) return { card: { ...card, blocker: "scan" } };
    if (sandbox === "none") return { card: { ...card, blocker: "no_sandbox" } };
    if (v.tree.size > 0 && sandbox !== "srt")
      throw new PsycheError(
        "unavailable",
        "scripts bundled in a connector run under srt only, and this Gateway uses containers",
        { details: { reason: "no_launcher" } },
      );

    // The payload goes to its own version directory before the probe (the probe runs it).
    const dir = v.tree.size > 0 ? writePayload(m.name, v.tree) : undefined;
    // Only the values listed on the card as carried over are kept; every other name starts empty.
    const env: Record<string, string> = {};
    for (const n of names) env[n] = carried.includes(n) ? (prevEnv[n] as string) : "";
    const input: McpServerInput = {
      id: m.name,
      name: m.title.slice(0, 100),
      transport: { kind: "stdio", command: argv(r), env },
      allowedDomains: r.network,
    };
    const base = serverConfig(input);
    // A shared connector gets nobody's documents: the places people keep theirs, and the data of
    // the Apple apps, are off limits to it besides what every connector is already denied. Its own
    // scripts are readable (read-only), and its scratch folder is the only place it writes.
    const home = homedir();
    const denyRead = [
      "Documents",
      "Desktop",
      "Downloads",
      "Pictures",
      "Movies",
      "Videos",
      "Music",
      join("Library", "Mail"),
      join("Library", "Messages"),
      join("Library", "Calendars"),
      join("Library", "Group Containers"),
      // Windows: the Mail/Calendar/People data and the packaged apps' own folders.
      join("AppData", "Local", "Comms"),
      join("AppData", "Local", "Packages"),
    ].map((d) => join(home, d));
    const config: PsycheMcpServerConfig = {
      ...base,
      // Someone else's command: never vouched for, whatever it looks like.
      trust: "unknown",
      bundle: { hash: v.bundleHash },
      sandbox: {
        ...base.sandbox,
        denyRead,
        ...(dir === undefined ? {} : { allowRead: [dir] }),
      },
      ...(dir === undefined ? {} : { cwd: dir }),
      ...(m.version === undefined ? {} : { version: m.version }),
    };
    const signerLabel =
      v.signer === undefined
        ? "unsigned file"
        : `signed by ${quoteForSummary(v.signer.name)}: ${signer.status}`;
    try {
      const staged = await deps.adder.propose(input, {
        config,
        // The probe only lists tools, before anyone approved this code: every variable blank,
        // whatever the owner set, and no network at all (the card lists the domains it asks for,
        // but only an approved connector gets them).
        probeConfig: {
          ...config,
          sandbox: { ...config.sandbox, allowedDomains: [] },
          transport: {
            kind: "stdio",
            command: argv(r),
            env: Object.fromEntries(Object.keys(env).map((n) => [n, ""])),
          },
        },
        replace: update !== undefined,
        summary: (found) =>
          `${update === undefined ? "Install" : "Update"} shared connector "${m.name}" (${signerLabel}${widenedFor(found) !== undefined ? ", asks for more than before" : ""})`,
        bind: (found) => {
          probed = found.tools;
          return {
            bundleHash: v.bundleHash,
            signer: v.signer?.keyId ?? null,
            widened: widenedFor(found) ?? null,
            carried,
          };
        },
        details: (found) => ({
          bundle: {
            bundleHash: v.bundleHash,
            signerStatus: signer.status,
            signerKey: v.signer?.keyId ?? null,
            signerName: v.signer?.name.slice(0, 64) ?? null,
            env: r.env,
            secrets: r.secrets.map((x) => x.name),
            declaredTools: r.tools.map((t) => `${t.sideEffect} ${t.name}`),
            update: update !== undefined,
            widened: widenedFor(found) !== undefined,
            carried,
            cleared,
            firstRun: "sandbox",
          },
        }),
        precommit: async () => {
          // The pairing between the list and the record is checked again at the last moment: an
          // update needs the very server and record it was staged against, a fresh install needs
          // neither to exist.
          const nowEntry = readEntries(services, deps.settingKey).find((c) => c.id === m.name);
          const nowRec = ledger.get(m.name);
          if (update !== undefined) {
            if (
              nowEntry?.bundle?.hash !== update.bundleHash ||
              nowRec?.bundleHash !== update.bundleHash
            )
              throw new PsycheError(
                "conflict",
                `${m.name} changed since you reviewed this card; import the file again`,
              );
          } else if (nowEntry !== undefined || nowRec !== undefined) {
            throw new PsycheError(
              "conflict",
              `${m.name} appeared since you reviewed this card; import the file again`,
            );
          }
          // A notice or a revocation that arrived while the card was open still blocks it.
          if (
            v.signer !== undefined &&
            ring.statusOf(v.signer, keys.peek(), undefined, { ancestors: v.ancestors }).status ===
              "revoked"
          )
            throw new PsycheError("policy_denied", "this bundle is signed by a key you revoked");
          if (ring.isBundleRevoked(v.bundleHash, v.signer?.keyId))
            throw new PsycheError("policy_denied", "a signed notice marked this bundle as bad");
          if (v.signer !== undefined) ring.assertNoFork(v.signer.keyId, v.ancestors);
          if (dir !== undefined && treeHash(readSkillDir(dir, limits)) !== treeHash(v.tree))
            throw new PsycheError(
              "conflict",
              "the connector's files changed since you reviewed them",
            );
          // The record goes down before the server does: a server that came from a file is never
          // running without it (every start checks it). If the add is undone, so is this.
          try {
            if (v.signer !== undefined) ring.observe(v.signer, v.ancestors, undo);
            ledger.put({
              serverId: m.name,
              bundleHash: v.bundleHash,
              ...(v.signer === undefined
                ? {}
                : { signerKeyId: v.signer.keyId, signerName: v.signer.name }),
              // The union, so an update does not forget keys an earlier file named.
              signerAncestors: [
                ...new Set([...(sameKey ? (update?.signerAncestors ?? []) : []), ...v.ancestors]),
              ],
              probedTools: probed.map((t) => ({ name: t.name, sideEffect: t.sideEffect })),
              title: m.title,
              ...(m.version === undefined ? {} : { version: m.version }),
              createdAt: m.createdAt,
              requests: r,
              treeHash: m.payload.treeHash,
              ...(dir === undefined ? {} : { dir }),
            });
          } catch (err) {
            ring.rollback(undo);
            throw err;
          }
        },
        rolledBack: async () => {
          // Each step is tried on its own: a failing one must not leave the others undone.
          const steps: (() => void)[] = [
            () => {
              if (update === undefined) ledger.remove(m.name);
              else {
                const { installedAt: _at, ...old } = update;
                ledger.put(old);
              }
            },
            // The key and rotations this install recorded, where that is still what they are.
            () => {
              ring.rollback(undo);
            },
            // The payload directory this import wrote (never the one an installed version uses).
            () => {
              if (dir !== undefined && update?.dir !== dir) removeTree(dir);
            },
          ];
          for (const step of steps) {
            try {
              step();
            } catch {
              // Best effort; the start-time check still holds the line.
            }
          }
        },
        committed: async () => {
          // The version it replaced is no longer in use.
          if (update?.dir !== undefined && update.dir !== dir) await removeTreeLater(update.dir);
          pruneDirs(m.name, new Set(dir === undefined ? [] : [dir]));
          if (dir === undefined) await removeTreeLater(join(root, m.name));
          await audit(
            "connector.installed",
            { serverId: m.name },
            {
              bundleHash: v.bundleHash,
              ...(v.signer === undefined ? {} : { keyId: v.signer.keyId }),
            },
          );
        },
      });
      const finalWidened = widenedFor(staged.proposal);
      if (card.update !== undefined) {
        if (finalWidened === undefined) delete card.update.widened;
        else card.update.widened = finalWidened;
      }
      if (finalWidened !== undefined)
        card.findings.push({
          rule: "permissions-widened",
          severity: "warn",
          message: "this version asks for more than the installed one",
        });
      const declared = new Set(r.tools.map((t) => t.name));
      const found = new Set(staged.proposal.tools.map((t) => t.name));
      const undeclared = [...found].filter((x) => !declared.has(x)).sort();
      const missing = [...declared].filter((x) => !found.has(x)).sort();
      if (undeclared.length > 0 || missing.length > 0)
        card.findings.push({
          rule: "tools-differ",
          severity: "warn",
          message: "the tools the server listed are not the ones the file says it lists",
        });
      return {
        card: {
          ...card,
          sandbox: staged.proposal.isolation === "container" ? "container" : "srt",
          toolCheck: { undeclared, missing },
        },
        proposal: staged.proposal,
        approval: staged.approval,
      };
    } catch (err) {
      if (dir !== undefined && update?.dir !== dir) removeTree(dir);
      const e = PsycheError.from(err);
      if (
        e.code === "unavailable" &&
        (e.details as { reason?: string } | undefined)?.reason === "no_launcher"
      )
        return { card: { ...card, sandbox: "none", blocker: "no_sandbox" } };
      if (
        e.code === "unavailable" &&
        (e.details as { reason?: string } | undefined)?.reason === "probe_failed"
      ) {
        // The first run, with no network and no secrets, could not start it: say so on the card.
        card.findings.push({
          rule: "probe-failed",
          severity: "high",
          message: `${e.message}. The first run has no network and no secrets, so a connector that needs them to start cannot be checked here`,
        });
        return { card: { ...card, blocker: "probe_failed" } };
      }
      throw err;
    }
  };

  const stale = async (entry: PsycheMcpServerConfig): Promise<string | undefined> => {
    // Psyche's own bundled servers never came from a file (and a claimed `bundled` tier on an
    // entry that carries a bundle marker changes nothing).
    if (entry.trust === "bundled" && entry.bundle === undefined) return undefined;
    // The entry itself says whether it came from a file: a record that cannot be read stops
    // those servers and no others.
    const marked = entry.bundle !== undefined;
    let rec: ConnectorLedgerRecord | undefined;
    try {
      rec = ledger.get(entry.id);
    } catch {
      return marked ? "its bundle record cannot be read" : undefined;
    }
    if (rec === undefined) return marked ? "its bundle record is missing" : undefined;
    try {
      // The record must be the one for the file this entry was approved from.
      if (marked && entry.bundle?.hash !== rec.bundleHash)
        return "its bundle record is for another file";
      // What runs is what was approved: a command line and variables the record knows about.
      if (marked) {
        const t = entry.transport;
        if (t.kind !== "stdio") return "it is not a command server any more";
        if (JSON.stringify(t.command) !== JSON.stringify(argv(rec.requests)))
          return "its command is not the one you approved";
        const allowed = new Set([...rec.requests.env, ...rec.requests.secrets.map((x) => x.name)]);
        if (Object.keys(t.env ?? {}).some((n) => !allowed.has(n)))
          return "it has a variable the file did not declare";
      }
      if (rec.signerKeyId !== undefined && ring.isRevoked(rec.signerKeyId))
        return "its author's key was revoked";
      if (ring.isBundleRevoked(rec.bundleHash, rec.signerKeyId))
        return "a signed notice marked its bundle as bad";
      if (rec.dir !== undefined && treeHash(readSkillDir(rec.dir, limits)) !== rec.treeHash)
        return "its files changed since you approved them";
    } catch {
      return "its files or the author list cannot be read";
    }
    return undefined;
  };

  /** A server added by hand (or by Psyche) never inherits a record an earlier shared one left. */
  const added = async (entry: PsycheMcpServerConfig) => {
    if (entry.bundle !== undefined) return;
    try {
      ledger.remove(entry.id);
    } catch {
      // An unreadable record is the owner's to reset; this server is not marked, so it runs.
    }
    await removeTreeLater(join(root, entry.id));
  };

  const removed = async (entry: PsycheMcpServerConfig) => {
    try {
      ledger.remove(entry.id);
    } catch {
      // A corrupt record is left for the owner; the files still go.
    }
    await removeTreeLater(join(root, entry.id));
  };

  return {
    handlers: {
      "connectors.export": { run: (call, params) => exportConnector(call, params) },
      "connectors.proposeImport": { run: (_call, params) => proposeImport(params) },
      "connectors.resetRecords": {
        // Host shell, then the owner's card or presence, like anything else that touches the
        // checks on shared connectors.
        run: async (call: Call, params: { approvalId?: string }) => {
          await signGate(
            services,
            call,
            {
              method: "connectors.resetRecords",
              tag: "reset-connector-records",
              summary: "Reset the record of shared connectors",
              subject: { reset: "connector-bundles" },
              treeHash: sha("reset-connector-records"),
              details: {
                kind: "connector_records_reset",
                note: "Sets an unreadable record aside, restores the last good copy, and forgets records of servers that did not come from a shared file. Connectors from a file without a record stay off.",
              },
            },
            params.approvalId,
          );
          const keep = new Set(
            readEntries(services, deps.settingKey)
              .filter((e) => e.bundle !== undefined)
              .map((e) => e.id),
          );
          const r = ledger.reset(keep);
          await audit(
            "connector.records_reset",
            { scope: "connectors" },
            { restored: String(r.restored), dropped: String(r.dropped) },
          );
          return r;
        },
      },
    },
    stale,
    added,
    removed,
    exportConnector,
  };
}
