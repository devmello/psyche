import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { deleteSettings, getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { hostLaunch } from "@psyche/hostfs";
import {
  type EventName,
  type EventPayload,
  type LinkSetupReason,
  type LinkSetupStatus,
  PsycheError,
} from "@psyche/protocol";
import {
  LinkCliWallet,
  type LinkWallet,
  type PaymentMethod,
  type ReportOutcome,
  type SpendLimits,
  type SpendRequest,
  type SpendRequestInput,
} from "@psyche/vault";
import type { Call, HandlerDef } from "../context.ts";
import { requireFreshPresence } from "../presence-gate.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";
import { type ComposedPayments, composePayments, type PaymentsSetup } from "./payments.ts";
import type { ComposeServices } from "./services.ts";

/**
 * Guided Stripe Link setup (Settings → Credentials → Payments), replacing `PSYCHE_LINK_CLI` as
 * the only switch. The owner installs the Link CLI themselves; Psyche finds it in the usual npm
 * places, checks that it is safe to run, saves the path (a sealed internal setting, so no raw
 * `settings.set` can point it at another program), and starts Link's own sign-in. The password
 * is typed on Link's page and never reaches Psyche; the CLI keeps the token in
 * `$PSYCHE_HOME/vault/link-auth.json` (0600). No CLI output is ever logged or returned: only
 * the sign-in page and phrase, which Link shows the owner anyway.
 */

export const LINK_CLI_SETTING = `${INTERNAL_SETTING_PREFIX}payments.linkCli`;
const LOGIN_MS = 5 * 60_000;
const POLL_MS = 3_000;
const CLI_TIMEOUT_MS = 35 * 60_000;

// --- Path safety --------------------------------------------------------------------------

export interface PathDeps {
  /** The Gateway's user (default `process.getuid()`); files owned by it or root may run. */
  uid?: number | undefined;
  platform?: NodeJS.Platform;
  /** Test seam: `lstat` for a path. */
  lstat?: (path: string) => {
    uid: number;
    mode: number;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
  };
}

export type PathCheck = { ok: true; real: string } | { ok: false; reason: LinkSetupReason };

function ancestors(real: string): string[] {
  const out: string[] = [];
  for (let d = dirname(real); ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

/**
 * Accepts a CLI path only when it resolves (every symlink followed once, here) to a real file
 * owned by the user or root, neither group- nor world-writable, and the same holds for every
 * folder above it. The returned path is the resolved one: later swaps of a symlink change nothing.
 */
export function checkLinkCliPath(path: string, deps: PathDeps = {}): PathCheck {
  if (!isAbsolute(path)) return { ok: false, reason: "not_absolute" };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  const platform = deps.platform ?? process.platform;
  const lstat = deps.lstat ?? ((p: string) => lstatSync(p));
  let st: ReturnType<NonNullable<PathDeps["lstat"]>>;
  try {
    st = lstat(real);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: "not_a_file" };
  // Windows has no owner or mode bits to read: the path must still be a real file.
  if (platform === "win32") return { ok: true, real };
  const uid = "uid" in deps ? deps.uid : process.getuid?.();
  const trusted = (owner: number) => owner === 0 || owner === uid;
  if (!/\.(c|m)?js$/.test(real) && (st.mode & 0o111) === 0)
    return { ok: false, reason: "not_executable" };
  if (!trusted(st.uid)) return { ok: false, reason: "wrong_owner" };
  if ((st.mode & 0o022) !== 0) return { ok: false, reason: "writable" };
  for (const dir of ancestors(real)) {
    let ds: ReturnType<NonNullable<PathDeps["lstat"]>>;
    try {
      ds = lstat(dir);
    } catch {
      return { ok: false, reason: "missing" };
    }
    if (!trusted(ds.uid)) return { ok: false, reason: "parent_wrong_owner" };
    if ((ds.mode & 0o022) !== 0) return { ok: false, reason: "parent_writable" };
  }
  return { ok: true, real };
}

export interface DetectOptions extends PathDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Where `npm install -g @stripe/link-cli` usually puts `link-cli`. */
export function detectLinkClis(opts: DetectOptions = {}): {
  found: string[];
  rejected: { path: string; reason: LinkSetupReason }[];
} {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const dirs = new Set<string>(
    (opts.env?.PATH ?? process.env.PATH ?? "").split(platform === "win32" ? ";" : ":"),
  );
  for (const d of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".local", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".yarn", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
  ])
    dirs.add(d);
  for (const [root, sub] of [
    [join(home, ".nvm", "versions", "node"), "bin"],
    [join(home, ".local", "share", "fnm", "node-versions"), join("installation", "bin")],
  ] as const) {
    try {
      for (const v of readdirSync(root)) dirs.add(join(root, v, sub));
    } catch {
      // No such version manager.
    }
  }
  const name = platform === "win32" ? "link-cli.cmd" : "link-cli";
  const found: string[] = [];
  const rejected: { path: string; reason: LinkSetupReason }[] = [];
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    const r = checkLinkCliPath(candidate, opts);
    if (r.ok) {
      if (!found.includes(r.real)) found.push(r.real);
    } else rejected.push({ path: candidate, reason: r.reason });
  }
  return { found, rejected };
}

// --- Running the CLI ----------------------------------------------------------------------

export type RunLink = (
  file: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<string>;

const runFile: RunLink = (file, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const launch = hostLaunch(file, env);
    if (launch === undefined) return reject(new Error("link-cli cannot be started"));
    execFile(
      launch.command,
      [...launch.args, ...args],
      { env: { ...env, ...launch.env }, shell: false, timeout: timeoutMs, maxBuffer: 1 << 20 },
      // Never carry the CLI's output into an error: it can echo account details.
      (err, stdout) =>
        err === null
          ? resolve(stdout)
          : reject(
              Object.assign(new Error("link-cli failed"), {
                exitCode: (err as { code?: unknown }).code,
              }),
            ),
    );
  });

/** Link's own hosts: the sign-in page is only ever shown when it is on one of them. */
export function isLinkUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.username === "" &&
      (u.hostname === "link.com" || u.hostname.endsWith(".link.com"))
    );
  } catch {
    return false;
  }
}

/** Finds the sign-in page and phrase in `auth login`'s JSON (field names are not fixed). */
export function parseLogin(stdout: string): { url: string; phrase: string } | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const strings: [string, string][] = [];
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 4) return;
    if (typeof v === "string") strings.push([key, v]);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
  };
  walk(doc, "", 0);
  const urls = strings.filter(([, v]) => isLinkUrl(v));
  const url = (urls.find(([k]) => /complete/i.test(k)) ??
    urls.find(([k]) => /url|uri|link/i.test(k)) ??
    urls[0])?.[1];
  if (url === undefined) return undefined;
  const phrase =
    strings.find(
      ([k, v]) =>
        /phrase|user_?code|verification_?code|code/i.test(k) &&
        v.length > 0 &&
        v.length <= 80 &&
        !v.startsWith("http"),
    )?.[1] ?? "";
  return { url, phrase };
}

// --- The wallet the broker holds ----------------------------------------------------------

const NOT_SET_UP = () =>
  new PsycheError("unavailable", "Stripe Link is not set up", {
    details: { reason: "payments_not_configured" },
  });

/** One `LinkWallet` for the broker's lifetime; the CLI behind it changes as setup changes. */
export class SwitchableWallet implements LinkWallet {
  inner: LinkWallet | undefined;
  readonly #w = (): LinkWallet => {
    if (this.inner === undefined) throw NOT_SET_UP();
    return this.inner;
  };
  spendLimits(): Promise<SpendLimits> {
    return this.#w().spendLimits();
  }
  paymentMethods(): Promise<PaymentMethod[]> {
    return this.#w().paymentMethods();
  }
  create(input: SpendRequestInput): Promise<SpendRequest> {
    return this.#w().create(input);
  }
  retrieve(id: string, o?: { wait?: boolean }): Promise<SpendRequest> {
    return this.#w().retrieve(id, o);
  }
  revealCard(id: string, outFile: string): Promise<SpendRequest> {
    return this.#w().revealCard(id, outFile);
  }
  cancel(id: string): Promise<SpendRequest> {
    return this.#w().cancel(id);
  }
  report(i: {
    domain: string;
    outcome: ReportOutcome;
    spendRequestId: string;
    tags?: string[];
  }): Promise<void> {
    return this.#w().report(i);
  }
}

// --- The controller -----------------------------------------------------------------------

export interface LinkSetupOptions extends PathDeps {
  /** `PSYCHE_LINK_CLI`: a dev override that skips the safety check, as before. */
  envCli?: string | undefined;
  detect?: DetectOptions;
  run?: RunLink;
  pollMs?: number;
  loginMs?: number;
}

const REASON_TEXT: Record<LinkSetupReason, string> = {
  not_absolute: "Use the full path to link-cli",
  missing: "That file does not exist",
  not_a_file: "That is not a plain file",
  not_executable: "That file cannot be run",
  wrong_owner: "That file belongs to another user; Psyche only runs files owned by you or root",
  writable: "That file can be changed by other users; remove group and other write access",
  parent_wrong_owner: "A folder above that file belongs to another user",
  parent_writable:
    "A folder above that file can be changed by other users; remove group and other write access",
};

export class LinkSetup {
  readonly wallet = new SwitchableWallet();
  readonly authFile: string;
  readonly #s: ComposeServices;
  readonly #o: LinkSetupOptions;
  #login: { url: string; phrase: string; expiresAt: number } | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #db: PsycheDb;

  constructor(services: ComposeServices, options: LinkSetupOptions = {}) {
    this.#s = services;
    this.#o = options;
    this.#db = services.db;
    this.authFile = join(services.home, "vault", "link-auth.json");
    this.#sync();
  }

  /** The CLI in use: the dev override, else the saved path if it still passes the check. */
  cli(): { path: string; source: "saved" | "env" } | undefined {
    const env = this.#o.envCli?.trim();
    if (env) return { path: env, source: "env" };
    const saved = getSetting(this.#db, LINK_CLI_SETTING)?.value as { path?: unknown } | undefined;
    return typeof saved?.path === "string" ? { path: saved.path, source: "saved" } : undefined;
  }

  configured(): boolean {
    return this.wallet.inner !== undefined;
  }

  #runnable(): { path: string } | { reason: LinkSetupReason; path: string } | undefined {
    const cli = this.cli();
    if (cli === undefined) return undefined;
    if (cli.source === "env") return { path: cli.path };
    const r = checkLinkCliPath(cli.path, this.#o);
    return r.ok ? { path: r.real } : { reason: r.reason, path: cli.path };
  }

  /** Rebuilds the wallet from the saved config; called at start and on every change. */
  #sync(): void {
    const cli = this.cli();
    this.wallet.inner =
      cli === undefined
        ? undefined
        : new LinkCliWallet({
            cli: cli.path,
            env: { LINK_AUTH_FILE: this.authFile },
            // Checked again before every run: a file swapped after connect is not run.
            run: async (file, args, env) => {
              const ok = this.#runnable();
              if (ok === undefined || "reason" in ok)
                throw Object.assign(new Error("link-cli not allowed"), { exitCode: null });
              return (this.#o.run ?? runFile)(file, args, env, CLI_TIMEOUT_MS);
            },
          });
  }

  async #exec(args: string[], timeoutMs = 60_000): Promise<string> {
    const ok = this.#runnable();
    if (ok === undefined || "reason" in ok) throw NOT_SET_UP();
    mkdirSync(dirname(this.authFile), { recursive: true, mode: 0o700 });
    try {
      if (lstatSync(this.authFile).isSymbolicLink()) unlinkSync(this.authFile);
    } catch {
      // No auth file yet.
    }
    const js = ok.path.endsWith(".js");
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      LINK_AUTH_FILE: this.authFile,
    };
    const out = await (this.#o.run ?? runFile)(
      js ? process.execPath : ok.path,
      js ? [ok.path, ...args, "--format", "json"] : [...args, "--format", "json"],
      env,
      timeoutMs,
    );
    this.#tighten();
    return out;
  }

  /** The CLI writes the token file 0600; make sure of it. */
  #tighten(): void {
    try {
      const st = lstatSync(this.authFile);
      if (st.isFile() && (st.mode & 0o077) !== 0) chmodSync(this.authFile, 0o600);
    } catch {
      // Not signed in.
    }
  }

  async #signedIn(): Promise<boolean> {
    try {
      const r = JSON.parse(await this.#exec(["auth", "status"])) as { authenticated?: unknown };
      return r.authenticated === true;
    } catch {
      return false;
    }
  }

  async status(): Promise<LinkSetupStatus> {
    const cli = this.cli();
    const runnable = this.#runnable();
    const det = detectLinkClis({ ...this.#o.detect, ...this.#o });
    const candidates = det.found.filter((p) => p !== cli?.path).map((path) => ({ path }));
    const bad = runnable !== undefined && "reason" in runnable ? runnable : undefined;
    const problem = bad ?? (cli === undefined ? det.rejected[0] : undefined);
    const base = {
      candidates,
      ...(problem === undefined ? {} : { problem: { path: problem.path, reason: problem.reason } }),
    };
    if (cli === undefined || bad !== undefined)
      return { state: candidates.length > 0 ? "cli_found" : "cli_missing", ...base };
    const withCli = { ...base, cli };
    if (this.#login !== undefined && this.#login.expiresAt > this.#s.clock.now()) {
      return {
        state: "signing_in",
        ...withCli,
        signIn: {
          verificationUrl: this.#login.url,
          phrase: this.#login.phrase,
          expiresAt: this.#login.expiresAt,
        },
      };
    }
    return { state: (await this.#signedIn()) ? "connected" : "signed_out", ...withCli };
  }

  #changed(status: LinkSetupStatus): void {
    this.#s.publish("payments.link.changed" as EventName, { status } as EventPayload<EventName>);
  }

  #audit(kind: string, data: Record<string, string>): void {
    this.#s.audit
      .append({ kind, actor: { type: "system" }, subject: { setting: "payments.linkCli" }, data })
      .catch(() => undefined);
  }

  async connect(
    call: Call,
    path: string,
    approvalId: string | undefined,
  ): Promise<LinkSetupStatus> {
    if (this.#o.envCli?.trim())
      throw new PsycheError("conflict", "PSYCHE_LINK_CLI is set on the Gateway and wins", {
        details: { reason: "env_override" },
      });
    const r = checkLinkCliPath(path, this.#o);
    if (!r.ok)
      throw new PsycheError("invalid_params", REASON_TEXT[r.reason], {
        details: { reason: r.reason },
      });
    await requireFreshPresence(
      call,
      {
        name: "method:payments.link.connect",
        summary: `Let Psyche run the Link CLI at ${r.real}`,
        subject: { path: r.real },
        details: { method: "payments.link.connect", path: r.real },
      },
      approvalId,
    );
    // Re-checked after the card: the file is what runs, not what was approved a minute ago.
    const again = checkLinkCliPath(r.real, this.#o);
    if (!again.ok)
      throw new PsycheError("invalid_params", REASON_TEXT[again.reason], {
        details: { reason: again.reason },
      });
    setSetting(this.#db, LINK_CLI_SETTING, { path: again.real });
    this.#sync();
    this.#audit("payments.link_cli_connected", {
      path: again.real,
      deviceId: call.identity.deviceId,
    });
    const status = await this.status();
    this.#changed(status);
    return status;
  }

  async signIn(): Promise<LinkSetupStatus> {
    if (this.cli() === undefined || !this.configured()) throw NOT_SET_UP();
    if (await this.#signedIn())
      throw new PsycheError("conflict", "Already signed in to Link", {
        details: { reason: "already_signed_in" },
      });
    let parsed: ReturnType<typeof parseLogin>;
    try {
      parsed = parseLogin(await this.#exec(["auth", "login", "--client-name", "Psyche"]));
    } catch {
      throw new PsycheError("unavailable", "The Link CLI could not start sign-in", {
        details: { reason: "link_cli_failed" },
      });
    }
    if (parsed === undefined)
      throw new PsycheError("unavailable", "Link did not return its sign-in page", {
        details: { reason: "link_signin_unreadable" },
      });
    this.#login = { ...parsed, expiresAt: this.#s.clock.now() + (this.#o.loginMs ?? LOGIN_MS) };
    this.#poll();
    return this.status();
  }

  #poll(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = setInterval(() => {
      if (this.#polling) return;
      this.#polling = true;
      void this.#tick().finally(() => {
        this.#polling = false;
      });
    }, this.#o.pollMs ?? POLL_MS);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    const login = this.#login;
    if (login === undefined) return this.#stopPoll();
    const done = await this.#signedIn();
    if (!done && login.expiresAt > this.#s.clock.now()) return;
    this.#login = undefined;
    this.#stopPoll();
    if (done) this.#audit("payments.link_signed_in", {});
    this.#changed(await this.status());
  }

  #stopPoll(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async disconnect(call: Call): Promise<LinkSetupStatus> {
    this.#login = undefined;
    this.#stopPoll();
    // Best effort at Link; the local file goes either way.
    if (this.#runnable() !== undefined)
      await this.#exec(["auth", "logout"], 30_000).catch(() => undefined);
    try {
      unlinkSync(this.authFile);
    } catch {
      // Already gone.
    }
    if (existsSync(this.authFile))
      throw new PsycheError("internal", "The Link auth file could not be removed");
    deleteSettings(this.#db, [LINK_CLI_SETTING]);
    this.#sync();
    this.#audit("payments.link_disconnected", { deviceId: call.identity.deviceId });
    const status = await this.status();
    this.#changed(status);
    return status;
  }

  stop(): void {
    this.#stopPoll();
  }
}

/**
 * Wraps `composePayments` with the guided setup: the broker always exists and uses a wallet that
 * follows the saved config, `vault.payments.*` answer `payments_not_configured` until a CLI is
 * connected, and `payments.link.*` drive the setup. A caller-supplied wallet (tests, the
 * scenario runner) skips all of this.
 */
export function composeGuidedPayments(
  setup: PaymentsSetup,
  options: LinkSetupOptions = {},
): (services: ComposeServices) => ComposedPayments {
  if (setup.wallet !== undefined) return composePayments(setup);
  const { linkCli, ...rest } = setup;
  return (services) => {
    const link = new LinkSetup(services, {
      ...options,
      ...(linkCli === undefined ? {} : { envCli: linkCli }),
    });
    const part = composePayments({ ...rest, wallet: link.wallet })(services);
    const guard = (name: string): Record<string, HandlerDef> => {
      const h = part.handlers?.[name];
      return h === undefined
        ? {}
        : {
            [name]: {
              run: (c: Call, p: never) => {
                if (!link.configured()) throw NOT_SET_UP();
                return h.run(c, p);
              },
            },
          };
    };
    const handlers: Record<string, HandlerDef> = {
      ...part.handlers,
      ...guard("vault.payments.list"),
      ...guard("vault.payments.methods"),
      "payments.link.status": { run: () => link.status() },
      "payments.link.connect": {
        run: (c: Call, p: { path: string; approvalId?: string }) =>
          link.connect(c, p.path, p.approvalId),
      } as HandlerDef,
      "payments.link.signIn": { run: () => link.signIn() },
      "payments.link.disconnect": { run: (c: Call) => link.disconnect(c) },
    };
    return {
      ...part,
      handlers,
      stop: async () => {
        link.stop();
        await part.stop?.();
      },
    };
  };
}
