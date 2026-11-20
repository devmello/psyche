import { execFile } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { deleteSettings, getSetting, setSetting } from "@psyche/db";
import {
  type OnePasswordSetupState,
  type OnePasswordSetupStatus,
  type OnePasswordTestResult,
  PsycheError,
} from "@psyche/protocol";
import {
  cliBaseEnv,
  execCli,
  type OnePasswordField,
  type OnePasswordRef,
  type OnePasswordSource,
  OpCliSource,
} from "@psyche/vault";
import type { Call, HandlerDef } from "../context.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Guided 1Password setup (Settings → Credentials). Psyche reads linked 1Password items through the
 * `op` CLI, signed in by the 1Password app's own "Integrate with 1Password CLI" setting: no token
 * is stored or sent, and the app shows its own unlock prompt when it needs one. The owner installs
 * `op` and flips that setting; this module only looks (`op account list`, `op whoami`), reads a
 * vault count for "Test connection", and switches the vault's source on and off.
 *
 * Which file runs: Psyche finds `op` itself (never from a caller), checks it is a real file that
 * others cannot write, in folders others cannot write, outside `$PSYCHE_HOME`, and (on macOS) that
 * it is signed by 1Password's team. Connecting pins the file by path and (dev, ino) in a sealed
 * setting; from then on only that file runs, and a different one is refused (`op_changed`). The
 * signature is checked before connecting and again whenever the file's mtime changes.
 *
 * Opening the panel runs no `op` at all unless the owner already connected; the account commands
 * run on Check again, Connect and Test connection, with a 60 s cache. Nothing `op` prints is
 * returned or logged except the account address and email from `op whoami` and a vault count.
 * Admin only (the method scope); no presence step of Psyche's own.
 */

export const ONEPASSWORD_APP_SETTING = `${INTERNAL_SETTING_PREFIX}credentials.onePasswordApp`;

/** Where `op` usually lives when the Gateway's PATH is short (a LaunchAgent, Electron). */
const USUAL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const OP_TIMEOUT_MS = 30_000;
const CACHE_MS = 60_000;
/** 1Password's Apple developer team: `op` is signed by it. */
const OP_TEAM = "2BUA8C4S2C";
/**
 * The code-signing identifier of the `op` binary: `com.1password.op`, read from the signatures of
 * the official releases 2.24.0, 2.30.0 and 2.42.0 (cache.agilebits.com; `codesign -dv`, never run).
 */
export const OP_IDENTIFIER = "com.1password.op";
/**
 * `op`'s own designated requirement, verbatim (verified with `codesign --verify --strict -R=` on
 * 2.42.0): the identifier, Apple's anchor, the Developer ID markers and 1Password's team.
 */
export const OP_REQUIREMENT = `identifier "${OP_IDENTIFIER}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${OP_TEAM}"`;

export type RunOp = (
  file: string,
  args: string[],
  env: Record<string, string>,
) => Promise<{ stdout: string; stderr: string }>;

export interface OnePasswordSetupOptions {
  /** `credentials.onePassword` (or a test's source) already supplies the vault's source. */
  externalConfigured?: boolean;
  /** Test seam: runs `op`. Tests always inject a fake; the default is `execFile`, no shell. */
  run?: RunOp;
  /** Test seam: whether the file at `path` is signed by 1Password. Default: `codesign` (macOS). */
  codesign?: (path: string, requirement: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  /** Test seam: PATH to search (default `process.env.PATH`). */
  path?: string;
  /** Test seam: extra folders searched after PATH (default the usual Homebrew ones). */
  dirs?: readonly string[];
  /** The Gateway's user; files owned by it or root may run (default `process.getuid()`). */
  uid?: number | undefined;
  /** `$PSYCHE_HOME`: nothing inside it may run, the agent can write there. */
  psycheHome?: string | undefined;
}

// --- Finding a safe op ----------------------------------------------------------------------

const idOf = (path: string): string => {
  const st = statSync(path, { bigint: true });
  return `${st.dev}:${st.ino}`;
};

/**
 * The real path of `path` when it is a plain executable owned by the user or root that no one else
 * can write, and every folder above it (both along the path as given, where a symlink may live,
 * and along the real path) is owned by the user or root and not writable by group or others (a
 * sticky root-owned one like /tmp aside), and it is not inside `$PSYCHE_HOME` under any spelling
 * (compared by (dev, ino), not by text).
 */
export type OpPathCheck = { real: string } | { bad: "file" | "folder" };

export function inspectOpPath(
  path: string,
  deps: { uid?: number | undefined; psycheHome?: string | undefined } = {},
): OpPathCheck {
  try {
    if (!isAbsolute(path)) return { bad: "file" };
    const real = realpathSync(path);
    const st = statSync(real);
    if (!st.isFile() || (st.mode & 0o111) === 0 || (st.mode & 0o022) !== 0) return { bad: "file" };
    const uid = deps.uid ?? process.getuid?.();
    if (uid !== undefined && st.uid !== uid && st.uid !== 0) return { bad: "file" };
    const home = deps.psycheHome === undefined ? undefined : idOf(realpathSync(deps.psycheHome));
    for (const start of new Set([dirname(path), dirname(real)])) {
      for (let d = start; ; d = dirname(d)) {
        const dst = lstatSync(d);
        const sticky = (dst.mode & 0o1000) !== 0 && dst.uid === 0;
        if ((dst.mode & 0o022) !== 0 && !sticky) return { bad: "folder" };
        if (uid !== undefined && dst.uid !== uid && dst.uid !== 0) return { bad: "folder" };
        if (home !== undefined && idOf(d) === home) return { bad: "file" };
        if (dirname(d) === d) break;
      }
    }
    return { real };
  } catch {
    return { bad: "file" };
  }
}

export function checkOpPath(
  path: string,
  deps: { uid?: number | undefined; psycheHome?: string | undefined } = {},
): string | undefined {
  const r = inspectOpPath(path, deps);
  return "real" in r ? r.real : undefined;
}

interface Candidates {
  /** Each good file with the PATH entry it was found through. */
  good: { via: string; real: string }[];
  /** An `op` exists whose file is fine but a folder above it is not (or is someone else's). */
  unsafeFolder: boolean;
}

/** Every `op` the PATH and the usual folders offer that passes the file checks, in order. */
function opCandidates(o: OnePasswordSetupOptions): Candidates {
  const dirs = [...(o.path ?? process.env.PATH ?? "").split(delimiter), ...(o.dirs ?? USUAL_DIRS)];
  const out: Candidates = { good: [], unsafeFolder: false };
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const r = inspectOpPath(join(dir, "op"), o);
    if ("real" in r) {
      if (!out.good.some((g) => g.real === r.real)) out.good.push({ via: dir, real: r.real });
    } else if (r.bad === "folder") {
      out.unsafeFolder = true;
    }
  }
  return out;
}

const defaultCodesign = (path: string, requirement: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      "/usr/bin/codesign",
      ["--verify", "--strict", `-R=${requirement}`, path],
      { timeout: 10_000, shell: false },
      (err) => resolve(err === null),
    );
  });

// --- Reading op's answers -------------------------------------------------------------------

/** `OpCliSource` wants the output text only. */
const wrapRun =
  (run: RunOp) =>
  async (file: string, args: string[], env: Record<string, string>): Promise<string> =>
    (await run(file, args, env)).stdout;

const defaultRun: RunOp = (file, args, env) => execCli(file, args, env, OP_TIMEOUT_MS);

/** What 1Password says when it is locked, signed out, or waiting for the owner. */
const LOCKED =
  /not signed in|sign in|session|locked|unlock|authori[sz]|biometric|cancel|denied|timed? ?out/i;
const NO_ACCOUNT = /no accounts?|not (been )?configured|add an account/i;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

type Problem = "op_changed" | "op_unsigned" | "op_unsafe_folder";

interface Detected {
  state: OnePasswordSetupState;
  op?: string;
  /** The PATH entry `op` was found through (what Connect saves). */
  via?: string;
  problem?: Problem;
  account?: { url: string; email: string };
}

class OpFailure extends Error {
  readonly stderr: string;
  readonly timedOut: boolean;
  constructor(stderr: string, timedOut: boolean) {
    super("op failed");
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

async function runOp(run: RunOp, op: string, args: string[]): Promise<string> {
  try {
    return (await run(op, args, cliBaseEnv())).stdout;
  } catch (err) {
    const e = err as { stderr?: unknown; killed?: unknown };
    throw new OpFailure(typeof e.stderr === "string" ? e.stderr : "", e.killed === true);
  }
}

/** Asks `op` where things stand. The only place that runs the account commands. */
async function probe(run: RunOp, op: string): Promise<Detected> {
  try {
    const out = (await runOp(run, op, ["account", "list", "--format", "json"])).trim();
    const accounts = out === "" ? [] : parseJson(out);
    if (!Array.isArray(accounts)) return { state: "error", op };
    if (accounts.length === 0) return { state: "not_integrated", op };
  } catch (err) {
    const f = err as OpFailure;
    return { state: NO_ACCOUNT.test(f.stderr ?? "") ? "not_integrated" : "error", op };
  }
  try {
    const who = parseJson(await runOp(run, op, ["whoami", "--format", "json"])) as
      | { url?: unknown; email?: unknown }
      | undefined;
    const url = str(who?.url);
    const email = str(who?.email);
    if (url === undefined || email === undefined) return { state: "error", op };
    return { state: "signed_in", op, account: { url, email } };
  } catch (err) {
    const f = err as OpFailure;
    return { state: f.timedOut || LOCKED.test(f.stderr) ? "locked" : "error", op };
  }
}

// --- The pinned file ------------------------------------------------------------------------

/** What Connect saves: the file that may run, and the account `op` should use. */
interface Pin {
  path: string;
  dev: string;
  ino: string;
  /** The PATH entry the file was found through; a re-pin stays within it. */
  via?: string;
  account?: string;
  /** When the pin last moved to a new file by itself (an upgrade). */
  repinnedAt?: number;
}

type Resolved = { ok: true; path: string; via?: string } | { ok: false; problem?: Problem };

const changed = (): PsycheError =>
  new PsycheError("unavailable", "the 1Password CLI changed: check the setup again", {
    details: { reason: "op_changed" },
  });

const managedByConfig = (): PsycheError =>
  new PsycheError("conflict", "credentials.onePassword in config.json supplies 1Password", {
    details: { reason: "managed_by_config" },
  });

/**
 * The vault's 1Password source while the app integration is on. `resolve` hands it the pinned
 * file after checking it again for every call, so a swapped file is never run.
 */
class AppIntegrationSource implements OnePasswordSource {
  readonly kind = "cli" as const;
  readonly #resolve: () => Promise<{ path: string; account?: string }>;
  readonly #run: RunOp | undefined;

  constructor(resolve: () => Promise<{ path: string; account?: string }>, run?: RunOp) {
    this.#resolve = resolve;
    this.#run = run;
  }

  async #source(): Promise<OpCliSource> {
    const { path, account } = await this.#resolve();
    return new OpCliSource({
      op: path,
      timeoutMs: OP_TIMEOUT_MS,
      ...(account === undefined ? {} : { account }),
      ...(this.#run === undefined ? {} : { run: wrapRun(this.#run) }),
    });
  }

  async unavailableReason(): Promise<string | null> {
    try {
      return await (await this.#source()).unavailableReason();
    } catch {
      return "the 1Password CLI changed or is not installed";
    }
  }

  async readField(ref: OnePasswordRef, field: OnePasswordField): Promise<string> {
    return (await this.#source()).readField(ref, field);
  }
}

// --- The controller -------------------------------------------------------------------------

class OnePasswordSetup {
  readonly #s: ComposeServices;
  readonly #o: OnePasswordSetupOptions;
  readonly #signed = new Map<string, boolean>();
  #cache: { at: number; key: string; status: OnePasswordSetupStatus } | undefined;
  #gen = 0;

  constructor(services: ComposeServices, options: OnePasswordSetupOptions) {
    this.#s = services;
    this.#o = { psycheHome: services.home, ...options };
    const pin = this.#pin();
    if (pin !== undefined && !this.#byConfig()) {
      this.#s.vault.setOnePassword(this.#source());
      // The same entry the vault writes for a configured source, so a reconnect is on the record.
      this.#s.audit
        .append({
          kind: "vault.external_source",
          actor: { type: "system" },
          data: { source: "1password", kind: "app", available: this.#pinnedFileOk(pin) },
        })
        .catch(() => undefined);
    }
  }

  /** Whether the pinned file is still the same safe file (no signature check: sync, at start). */
  #pinnedFileOk(pin: Pin): boolean {
    try {
      const real = checkOpPath(pin.path, this.#o);
      return real === pin.path && idOf(real) === `${pin.dev}:${pin.ino}`;
    } catch {
      return false;
    }
  }

  #byConfig(): boolean {
    return this.#o.externalConfigured === true;
  }

  #pin(): Pin | undefined {
    const v = getSetting(this.#s.db, ONEPASSWORD_APP_SETTING)?.value as Partial<Pin> | undefined;
    if (typeof v?.path !== "string" || typeof v.dev !== "string" || typeof v.ino !== "string")
      return undefined;
    return {
      path: v.path,
      dev: v.dev,
      ino: v.ino,
      ...(typeof v.via === "string" ? { via: v.via } : {}),
      ...(typeof v.account === "string" ? { account: v.account } : {}),
      ...(typeof v.repinnedAt === "number" ? { repinnedAt: v.repinnedAt } : {}),
    };
  }

  #os(): "macos" | "other" {
    return (this.#o.platform ?? process.platform) === "darwin" ? "macos" : "other";
  }

  /** Signed by 1Password (macOS only), cached by the file's (dev, ino, mtime). */
  async #signedByVendor(real: string): Promise<boolean> {
    if (this.#os() !== "macos") return true;
    // ctime is set by the kernel on every write and cannot be put back by touch -r.
    const st = statSync(real, { bigint: true });
    const key = `${st.dev}:${st.ino}:${st.size}:${st.ctimeNs}:${st.mtimeNs}`;
    const known = this.#signed.get(key);
    if (known !== undefined) return known;
    const ok = await (this.#o.codesign ?? defaultCodesign)(real, OP_REQUIREMENT);
    this.#signed.set(key, ok);
    return ok;
  }

  /** The file that may run: the pinned one when connected, else the first good candidate. */
  async #resolve(pin: Pin | undefined): Promise<Resolved> {
    if (pin !== undefined) {
      const r = inspectOpPath(pin.path, this.#o);
      if (!("real" in r) && r.bad === "folder") return { ok: false, problem: "op_unsafe_folder" };
      if (!("real" in r) || r.real !== pin.path || idOf(r.real) !== `${pin.dev}:${pin.ino}`)
        return this.#repin(pin);
      return (await this.#signedByVendor(r.real))
        ? { ok: true, path: r.real }
        : { ok: false, problem: "op_unsigned" };
    }
    const found = opCandidates(this.#o);
    for (const g of found.good) {
      if (await this.#signedByVendor(g.real)) return { ok: true, path: g.real, via: g.via };
    }
    if (found.good.length > 0) return { ok: false, problem: "op_unsigned" };
    return found.unsafeFolder ? { ok: false, problem: "op_unsafe_folder" } : { ok: false };
  }

  /**
   * The pinned file is gone or different (an upgrade moves the version folder). On macOS, where
   * the signature is checked, the one candidate found through the same PATH entry that passes
   * every check takes over the pin, but only if nothing else changed the setting while the
   * signature was checked (a Disconnect, a Connect, another re-pin). Anything else stays
   * `op_changed` until the owner checks again.
   */
  async #repin(pin: Pin): Promise<Resolved> {
    const gen = this.#gen;
    const no: Resolved = { ok: false, problem: "op_changed" };
    if (this.#os() !== "macos" || this.#byConfig() || pin.via === undefined) return no;
    const good: string[] = [];
    for (const g of opCandidates(this.#o).good) {
      if (g.via === pin.via && (await this.#signedByVendor(g.real))) good.push(g.real);
    }
    const [path] = good;
    if (good.length !== 1 || path === undefined) return no;
    const now = this.#pin();
    if (gen !== this.#gen || now === undefined) return no;
    // Another call already moved the pin to this very file: nothing to write.
    if (now.path === path && now.path !== pin.path) return { ok: true, path };
    if (JSON.stringify(now) !== JSON.stringify(pin)) return no;
    const [dev = "", ino = ""] = idOf(path).split(":");
    setSetting(this.#s.db, ONEPASSWORD_APP_SETTING, {
      path,
      dev,
      ino,
      via: pin.via,
      ...(pin.account === undefined ? {} : { account: pin.account }),
      repinnedAt: this.#now(),
    } satisfies Pin);
    this.#cache = undefined;
    this.#s.audit
      .append({
        kind: "vault.external_source",
        actor: { type: "system" },
        data: { source: "1password", kind: "app", available: true, repinned: true },
      })
      .catch(() => undefined);
    return { ok: true, path };
  }

  #source(): OnePasswordSource {
    return new AppIntegrationSource(async () => {
      const pin = this.#pin();
      if (pin === undefined) throw changed();
      const r = await this.#resolve(pin);
      if (!r.ok) throw changed();
      return { path: r.path, ...(pin.account === undefined ? {} : { account: pin.account }) };
    }, this.#o.run);
  }

  #status(d: Detected): OnePasswordSetupStatus {
    return {
      state: d.state,
      connected: this.#pin() !== undefined && !this.#byConfig(),
      os: this.#os(),
      ...(this.#byConfig() ? { managedBy: "config" as const } : {}),
      ...(d.problem === undefined ? {} : { problem: d.problem }),
      ...(this.#pin()?.repinnedAt === undefined || this.#byConfig()
        ? {}
        : { repinnedAt: this.#pin()?.repinnedAt as number }),
      ...(d.op === undefined ? {} : { op: { path: d.op } }),
      ...(d.account === undefined ? {} : { account: d.account }),
    };
  }

  /** Finds the file; runs `op` only when asked to (or when already connected). */
  async #detect(pin: Pin | undefined, runOpCommands: boolean): Promise<Detected> {
    const r = await this.#resolve(pin);
    if (!r.ok) {
      if (r.problem === undefined) return { state: "not_installed" };
      return { state: "error", problem: r.problem };
    }
    if (!runOpCommands) return { state: "found", op: r.path };
    return {
      ...(await probe(this.#o.run ?? defaultRun, r.path)),
      ...(r.via === undefined ? {} : { via: r.via }),
    };
  }

  async status(fresh: boolean): Promise<OnePasswordSetupStatus> {
    const pin = this.#pin();
    const connected = pin !== undefined && !this.#byConfig();
    const key = `${pin?.path ?? ""}:${this.#byConfig()}`;
    const hit = this.#cache;
    if (!fresh && hit !== undefined && hit.key === key && this.#now() - hit.at < CACHE_MS)
      return hit.status;
    const status = this.#status(await this.#detect(pin, fresh || connected));
    // Only an answer from `op` is worth keeping; looking for the file is cheap.
    if (fresh || connected) this.#cache = { at: this.#now(), key, status };
    return status;
  }

  #now(): number {
    return this.#s.clock.now();
  }

  async test(): Promise<OnePasswordTestResult> {
    const pin = this.#pin();
    const d = await this.#detect(pin, true);
    if (d.state !== "signed_in" || d.op === undefined) {
      throw new PsycheError("unavailable", "1Password is not ready", {
        details: { reason: d.problem ?? d.state },
      });
    }
    let vaultCount: number;
    try {
      const list = parseJson(
        await runOp(this.#o.run ?? defaultRun, d.op, ["vault", "list", "--format", "json"]),
      );
      if (!Array.isArray(list)) throw new Error("not a list");
      vaultCount = list.length;
    } catch {
      throw new PsycheError("unavailable", "1Password could not list vaults", {
        details: { reason: "op_failed" },
      });
    }
    return { status: this.#status(d), vaultCount };
  }

  #audit(kind: string, call: Call, available: boolean): void {
    this.#s.audit
      .append({
        kind,
        actor: { type: "device", deviceId: call.identity.deviceId },
        subject: { setting: "credentials.onePassword" },
        data: { source: "1password", kind: "app", available: String(available) },
      })
      .catch(() => undefined);
  }

  async connect(call: Call): Promise<OnePasswordSetupStatus> {
    if (this.#byConfig()) throw managedByConfig();
    const gen = ++this.#gen;
    // A fresh look at the file (a re-connect re-pins), then what `op` says.
    const d = await this.#detect(undefined, true);
    if (gen !== this.#gen) {
      throw new PsycheError("conflict", "the 1Password setup changed meanwhile", {
        details: { reason: "changed" },
      });
    }
    if (d.state !== "signed_in" || d.op === undefined) {
      throw new PsycheError("conflict", "1Password is not signed in to the CLI yet", {
        details: { reason: d.problem ?? d.state },
      });
    }
    const [dev = "", ino = ""] = idOf(d.op).split(":");
    const pin: Pin = {
      path: d.op,
      dev,
      ino,
      ...(d.via === undefined ? {} : { via: d.via }),
      ...(d.account === undefined ? {} : { account: d.account.url }),
    };
    setSetting(this.#s.db, ONEPASSWORD_APP_SETTING, pin);
    this.#cache = undefined;
    this.#s.vault.setOnePassword(this.#source());
    this.#audit("vault.onepassword_connected", call, true);
    return this.#status(d);
  }

  async disconnect(call: Call): Promise<OnePasswordSetupStatus> {
    if (this.#byConfig()) throw managedByConfig();
    this.#gen += 1;
    deleteSettings(this.#s.db, [ONEPASSWORD_APP_SETTING]);
    this.#cache = undefined;
    this.#s.vault.setOnePassword(undefined);
    this.#audit("vault.onepassword_disconnected", call, false);
    return this.status(false);
  }
}

export function composeOnePasswordSetup(
  options: OnePasswordSetupOptions = {},
): (services: ComposeServices) => ComposedPart {
  return (services) => {
    const setup = new OnePasswordSetup(services, options);
    const handlers: Record<string, HandlerDef> = {
      "vault.onePassword.status": {
        run: (_c: Call, p: { probe?: boolean }) => setup.status(p.probe === true),
      } as HandlerDef,
      "vault.onePassword.test": { run: () => setup.test() },
      "vault.onePassword.connect": { run: (c: Call) => setup.connect(c) },
      "vault.onePassword.disconnect": { run: (c: Call) => setup.disconnect(c) },
    };
    return { handlers };
  };
}
