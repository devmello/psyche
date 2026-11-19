import { lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";
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
 * Nothing `op` prints is returned or logged except the account address and email from
 * `op whoami` and a vault count. The `op` file is found by Psyche (never taken from a caller),
 * checked before every run, and the only saved state is an on/off flag (a sealed internal
 * setting). Admin only (the method scope); no presence step of Psyche's own.
 */

export const ONEPASSWORD_APP_SETTING = `${INTERNAL_SETTING_PREFIX}credentials.onePasswordApp`;

/** Where `op` usually lives when the Gateway's PATH is short (a LaunchAgent, Electron). */
const USUAL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const OP_TIMEOUT_MS = 30_000;

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

/** A real file owned by the user or root, that no one else can write, in a folder no one else can write. */
export function checkOpPath(
  path: string,
  deps: { uid?: number | undefined; psycheHome?: string | undefined } = {},
): string | undefined {
  try {
    if (!isAbsolute(path)) return undefined;
    const real = realpathSync(path);
    const st = statSync(real);
    if (!st.isFile() || (st.mode & 0o111) === 0 || (st.mode & 0o022) !== 0) return undefined;
    const uid = deps.uid ?? process.getuid?.();
    if (uid !== undefined && st.uid !== uid && st.uid !== 0) return undefined;
    const dir = real.slice(0, real.lastIndexOf(sep)) || sep;
    const dst = lstatSync(dir);
    if ((dst.mode & 0o022) !== 0 && (dst.mode & 0o1000) === 0) return undefined;
    if (deps.psycheHome !== undefined) {
      const home = realpathSync(deps.psycheHome);
      if (real === home || real.startsWith(home + sep)) return undefined;
    }
    return real;
  } catch {
    return undefined;
  }
}

function findOp(o: OnePasswordSetupOptions): string | undefined {
  const dirs = [...(o.path ?? process.env.PATH ?? "").split(delimiter), ...(o.dirs ?? USUAL_DIRS)];
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const real = checkOpPath(join(dir, "op"), o);
    if (real !== undefined) return real;
  }
  return undefined;
}

// --- Reading op's answers -------------------------------------------------------------------

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

interface Detected {
  state: OnePasswordSetupState;
  op?: string;
  account?: { url: string; email: string };
}

class OpFailure extends Error {
  constructor(
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super("op failed");
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

async function detect(o: OnePasswordSetupOptions): Promise<Detected> {
  const op = findOp(o);
  if (op === undefined) return { state: "not_installed" };
  const run = o.run ?? defaultRun;
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

// --- The vault's source ---------------------------------------------------------------------

/**
 * The vault's 1Password source while the app integration is on. It finds and checks `op` again
 * for every call, so a file swapped after the owner connected is not run.
 */
class AppIntegrationSource implements OnePasswordSource {
  readonly kind = "cli" as const;
  constructor(private readonly o: OnePasswordSetupOptions) {}

  #source(): OpCliSource | undefined {
    const op = findOp(this.o);
    return op === undefined
      ? undefined
      : new OpCliSource({
          op,
          timeoutMs: OP_TIMEOUT_MS,
          ...(this.o.run === undefined ? {} : { run: this.o.run }),
        });
  }

  async unavailableReason(): Promise<string | null> {
    const s = this.#source();
    return s === undefined ? "op is not installed" : s.unavailableReason();
  }

  async readField(ref: OnePasswordRef, field: OnePasswordField): Promise<string> {
    const s = this.#source();
    if (s === undefined) {
      throw new PsycheError("unavailable", "the 1Password CLI is not installed", {
        details: { reason: "op_not_installed" },
      });
    }
    return s.readField(ref, field);
  }
}

// --- The controller -------------------------------------------------------------------------

class OnePasswordSetup {
  readonly #s: ComposeServices;
  readonly #o: OnePasswordSetupOptions;

  constructor(services: ComposeServices, options: OnePasswordSetupOptions) {
    this.#s = services;
    this.#o = { psycheHome: services.home, ...options };
    if (this.#connected() && !this.#byConfig()) this.#s.vault.setOnePassword(this.#source());
  }

  #byConfig(): boolean {
    return this.#o.externalConfigured === true;
  }

  #connected(): boolean {
    return (
      (getSetting(this.#s.db, ONEPASSWORD_APP_SETTING)?.value as { on?: unknown } | undefined)
        ?.on === true
    );
  }

  #source(): OnePasswordSource {
    return new AppIntegrationSource(this.#o);
  }

  #status(d: Detected): OnePasswordSetupStatus {
    return {
      state: d.state,
      connected: this.#connected() && !this.#byConfig(),
      ...(this.#byConfig() ? { managedBy: "config" as const } : {}),
      ...(d.op === undefined ? {} : { op: { path: d.op } }),
      ...(d.account === undefined ? {} : { account: d.account }),
    };
  }

  async status(): Promise<OnePasswordSetupStatus> {
    return this.#status(await detect(this.#o));
  }

  async test(): Promise<OnePasswordTestResult> {
    const d = await detect(this.#o);
    if (d.state !== "signed_in" || d.op === undefined) {
      throw new PsycheError("unavailable", "1Password is not ready", {
        details: { reason: d.state },
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
    const d = await detect(this.#o);
    if (d.state !== "signed_in") {
      throw new PsycheError("conflict", "1Password is not signed in to the CLI yet", {
        details: { reason: d.state },
      });
    }
    setSetting(this.#s.db, ONEPASSWORD_APP_SETTING, { on: true });
    this.#s.vault.setOnePassword(this.#source());
    this.#audit("vault.onepassword_connected", call, true);
    return this.#status(d);
  }

  async disconnect(call: Call): Promise<OnePasswordSetupStatus> {
    if (this.#byConfig()) throw managedByConfig();
    deleteSettings(this.#s.db, [ONEPASSWORD_APP_SETTING]);
    this.#s.vault.setOnePassword(undefined);
    this.#audit("vault.onepassword_disconnected", call, false);
    return this.status();
  }
}

const managedByConfig = (): PsycheError =>
  new PsycheError("conflict", "credentials.onePassword in config.json supplies 1Password", {
    details: { reason: "managed_by_config" },
  });

export function composeOnePasswordSetup(
  options: OnePasswordSetupOptions = {},
): (services: ComposeServices) => ComposedPart {
  return (services) => {
    const setup = new OnePasswordSetup(services, options);
    const handlers: Record<string, HandlerDef> = {
      "vault.onePassword.status": { run: () => setup.status() },
      "vault.onePassword.test": { run: () => setup.test() },
      "vault.onePassword.connect": { run: (c: Call) => setup.connect(c) },
      "vault.onePassword.disconnect": { run: (c: Call) => setup.disconnect(c) },
    };
    return { handlers };
  };
}
