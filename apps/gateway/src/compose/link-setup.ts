import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { deleteSettings, getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { hostLaunch, shimTarget } from "@psyche/hostfs";
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
  type PaymentBroker,
  type PaymentMethod,
  type ReportOutcome,
  SPEND_WAITING,
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
/** When a forced disconnect gave up the open payments: records up to then no longer block. */
export const LINK_ABANDONED_SETTING = `${INTERNAL_SETTING_PREFIX}payments.linkAbandonedBefore`;
const LOGIN_MS = 5 * 60_000;
const POLL_MS = 3_000;
const CLI_TIMEOUT_MS = 35 * 60_000;

// --- Path safety --------------------------------------------------------------------------

export interface PathDeps {
  /** The Gateway's user (default `process.getuid()`); files owned by it or root may run. */
  uid?: number | undefined;
  platform?: NodeJS.Platform;
  /**
   * `$PSYCHE_HOME`: nothing inside it may be run, because the agent can write there (a planted
   * script under `workspace/` would otherwise pass as "owned by you").
   */
  psycheHome?: string | undefined;
  /** Test seam: the identity (`dev`, `ino`) of a folder, to find `$PSYCHE_HOME` under any spelling. */
  statDir?: (path: string) => { dev: bigint | number; ino: bigint | number };
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

/** Scripts Node runs for us; anything else must be a program with its execute bit set. */
const SCRIPT = /\.(c|m)?js$/;

const isUnder = (real: string, dir: string): boolean => real === dir || real.startsWith(dir + sep);

function resolvedOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The nearest `package.json` above a script names the package it belongs to. */
function packageNameOf(script: string): string | undefined {
  let dir = dirname(script);
  for (let i = 0; i < 8; i++) {
    try {
      const text = readFileSync(join(dir, "package.json"), "utf8");
      if (text.length > 1 << 16) return undefined;
      const name = (JSON.parse(text) as { name?: unknown }).name;
      return typeof name === "string" ? name : undefined;
    } catch {
      // No package.json here (or not readable): look one folder up.
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/**
 * Whether `real` is inside `home`: by spelling, and by identity (`dev`, `ino`) of every folder above
 * it. APFS ignores case and `/System/Volumes/Data/...` is a firmlink, so `~/.PSYCHE/...` or the
 * firmlinked path is the same folder under a spelling a string comparison does not recognise.
 */
function insideHome(real: string, home: string, deps: PathDeps): boolean {
  const h = resolvedOr(home);
  if (isUnder(real, h)) return true;
  const statDir = deps.statDir ?? ((p: string) => statSync(p, { bigint: true }));
  const idOf = (p: string): string => {
    const st = statDir(p);
    return `${st.dev}:${st.ino}`;
  };
  let want: string;
  try {
    want = idOf(h);
  } catch {
    return false;
  }
  for (const dir of ancestors(real)) {
    try {
      if (idOf(dir) === want) return true;
    } catch {
      // Not readable: it cannot be the folder either.
    }
  }
  return false;
}

/**
 * The script a pnpm or npm shell shim starts (`exec node "$basedir/<script>" "$@"`), resolved from
 * the shim's own folder; undefined for anything that is not such a shim.
 */
function shimScript(shim: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  if (text.length > 4096 || !/^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?sh\b/.test(text))
    return undefined;
  const rel = /\bexec\s+node\s+"\$basedir\/([^"$`\\\n]+)"/.exec(text)?.[1];
  return rel === undefined ? undefined : join(dirname(shim), rel);
}

/**
 * Accepts a CLI path only when it resolves (every symlink followed once, here) to a real file
 * owned by the user or root, neither group- nor world-writable, and the same holds for every
 * folder above it. The returned path is the resolved one: later swaps of a symlink change nothing.
 * It must also be outside `$PSYCHE_HOME` (under any spelling), and it must be a `.js`, `.mjs` or
 * `.cjs` script inside the `@stripe/link-cli` package, or a pnpm or npm shim that starts one (the
 * script is what is returned and run). Any other program, `/bin/sh` or `env` included, would run
 * whatever the arguments say, so it is refused. Volta's shim is refused: it runs whichever tool its
 * own name says, not the file it was pointed at.
 */
export function checkLinkCliPath(path: string, deps: PathDeps = {}, viaShim = false): PathCheck {
  if (!isAbsolute(path)) return { ok: false, reason: "not_absolute" };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  const platform = deps.platform ?? process.platform;
  if (deps.psycheHome !== undefined && insideHome(real, deps.psycheHome, deps))
    return { ok: false, reason: "in_psyche_home" };
  if (/^volta-(shim|migrate)(\.exe)?$/i.test(basename(real)))
    return { ok: false, reason: "volta_shim" };
  const lstat = deps.lstat ?? ((p: string) => lstatSync(p));
  let st: ReturnType<NonNullable<PathDeps["lstat"]>>;
  try {
    st = lstat(real);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: "not_a_file" };
  const script = SCRIPT.test(real);
  const inPackage = () => packageNameOf(real) === "@stripe/link-cli";
  // Windows has no owner or mode bits to read, but the same rule holds: the Link CLI's own script,
  // or an npm or pnpm `.cmd` shim whose target is one. `powershell.exe` or `cmd.exe` is neither.
  if (platform === "win32") {
    if (script) return inPackage() ? { ok: true, real } : { ok: false, reason: "not_link_cli" };
    const target = !viaShim && /\.cmd$/i.test(real) ? shimTarget(real) : undefined;
    if (target === undefined) return { ok: false, reason: "not_link_cli" };
    const inner = checkLinkCliPath(target, deps, true);
    return inner.ok && !SCRIPT.test(inner.real) ? { ok: false, reason: "not_link_cli" } : inner;
  }
  const uid = "uid" in deps ? deps.uid : process.getuid?.();
  const trusted = (owner: number) => owner === 0 || owner === uid;
  if (!script && (st.mode & 0o111) === 0) return { ok: false, reason: "not_executable" };
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
  if (script) return inPackage() ? { ok: true, real } : { ok: false, reason: "not_link_cli" };
  // Not a script: only a shim that starts one (and that script passes every check itself).
  const target = viaShim ? undefined : shimScript(real);
  if (target === undefined) return { ok: false, reason: "not_link_cli" };
  const inner = checkLinkCliPath(target, deps, true);
  return inner.ok && !SCRIPT.test(inner.real) ? { ok: false, reason: "not_link_cli" } : inner;
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

export const runFile: RunLink = (file, args, env, timeoutMs) =>
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
                killed: (err as { killed?: unknown }).killed === true,
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

/**
 * link-cli is built on incur: with `--format json` its `auth login` and `auth status` (async
 * generators) print one buffered ARRAY of what they yielded (`[{"authenticated":true,…}]`), and a
 * wrapped result is `{ok, data}`. Both come out as the object inside.
 */
export function unwrapJson(doc: unknown): unknown {
  let v = doc;
  for (let i = 0; i < 4; i++) {
    if (Array.isArray(v)) {
      const objects = v.filter((x) => x !== null && typeof x === "object");
      if (objects.length === 0) return undefined;
      v = objects[objects.length - 1];
    } else if (v !== null && typeof v === "object" && "ok" in v && "data" in v) {
      v = (v as { data: unknown }).data;
    } else break;
  }
  return v;
}

/** The only keys a phrase is read from, in this order; never a `device_code` (a secret). */
const PHRASE_KEYS = ["phrase", "usercode"] as const;

/** Finds the sign-in page and phrase in `auth login`'s JSON (the page's field name is not fixed). */
export function parseLogin(stdout: string): { url: string; phrase: string } | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const strings: [string, string][] = [];
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 5) return;
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
  const norm = (k: string) => k.toLowerCase().replace(/[_-]/g, "");
  let phrase = "";
  for (const want of PHRASE_KEYS) {
    const hit = strings.find(
      ([k, v]) => norm(k) === want && v.length > 0 && v.length <= 80 && !v.startsWith("http"),
    );
    if (hit !== undefined) {
      phrase = hit[1];
      break;
    }
  }
  // Without a phrase the owner has nothing to compare on Link's page: do not start a sign-in.
  return phrase === "" ? undefined : { url, phrase };
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
  /** How long `auth status` is trusted (default 10 s); a test seam. */
  statusTtlMs?: number;
  /** First wait before asking `auth status` again after a failed start check (default 30 s). */
  statusRetryMs?: number;
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
  in_psyche_home: "That file is inside Psyche's own folder; install the Link CLI with npm instead",
  not_link_cli: "That script is not part of the @stripe/link-cli package",
  volta_shim:
    "That is Volta's shim, which cannot be run this way; use the Link CLI's own folder under Volta, or install it with npm",
};

/** How long `auth status` is trusted: the Settings screen asks often, the CLI is a process. */
const STATUS_TTL_MS = 10_000;
/** A failed start check is asked again after 30 s, then twice as long each time, up to 10 min. */
const STATUS_RETRY_MS = 30_000;
const STATUS_RETRY_MAX_MS = 10 * 60_000;
/** A spend that is still being approved or paid; older than this it is a stale record. */
const OPEN_SPEND_MS = 2 * 60 * 60_000;
/** A hold stays open until it is captured or released. */
const OPEN_HOLD_MS = 7 * 24 * 60 * 60_000;

/** What `vault/payments/<id>.json` holds that matters here (the broker's `SpendRecord`). */
export interface SpendRow {
  spendRequestId: string;
  merchantName: string;
  merchantHost: string;
  status: string;
  payment?: { state?: string };
  createdAt: number;
}

const DEAD_SPEND: readonly string[] = ["failed", "denied", "expired", "canceled"];

/**
 * Spends that disconnecting now would strand (no way left to cancel, capture or report them):
 * still being approved, or approved with the card out and nothing settled (2 h), or a hold that
 * is neither captured nor released (7 days). Records at or before `abandonedBefore` were given up
 * by a forced disconnect.
 */
export function openSpendsOf(
  rows: Iterable<SpendRow>,
  now: number,
  abandonedBefore = 0,
): SpendRow[] {
  const open: SpendRow[] = [];
  for (const p of rows) {
    if (p.createdAt <= abandonedBefore) continue;
    const age = now - p.createdAt;
    const state = p.payment?.state ?? "none";
    if (state === "held") {
      if (!DEAD_SPEND.includes(p.status) && age < OPEN_HOLD_MS) open.push(p);
    } else if (
      age < OPEN_SPEND_MS &&
      (SPEND_WAITING.includes(p.status as never) ||
        // Approved with the card revealed and nothing settled yet: the purchase is under way.
        ((p.status === "approved" || p.status === "submitted") && state === "none"))
    ) {
      open.push(p);
    }
  }
  return open;
}

/** Every spend record that can still be open (older files cannot be: a change rewrites the file). */
export function* readSpendRecords(dir: string, now: number): Iterable<SpendRow> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try {
      const file = join(dir, f);
      if (now - lstatSync(file).mtimeMs > OPEN_HOLD_MS) continue;
      const rec = JSON.parse(readFileSync(file, "utf8")) as SpendRow;
      if (typeof rec.spendRequestId === "string" && typeof rec.createdAt === "number") yield rec;
    } catch {
      // A damaged record is not a payment under way.
    }
  }
}

export class LinkSetup {
  readonly wallet = new SwitchableWallet();
  readonly authFile: string;
  /** Set by `composeGuidedPayments` once the broker exists: used to cancel open spends on force. */
  broker: Pick<PaymentBroker, "cancel"> | undefined;
  readonly #s: ComposeServices;
  readonly #o: LinkSetupOptions;
  #login: { url: string; phrase: string; expiresAt: number; deviceId: string } | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #db: PsycheDb;
  #authCache: { at: number; value: boolean } | undefined;
  #authInflight: { gen: number; run: Promise<boolean | undefined> } | undefined;
  #chain = 0;
  #stopped = false;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #gen = 0;

  constructor(services: ComposeServices, options: LinkSetupOptions = {}) {
    this.#s = services;
    this.#o = options;
    this.#db = services.db;
    this.authFile = join(services.home, "vault", "link-auth.json");
    this.#sync();
  }

  /** What the path and detection checks need: the options plus Psyche's own folder. */
  #deps(): PathDeps {
    return { ...this.#o, psycheHome: this.#s.home };
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

  /**
   * Whether Link can pay now: a CLI connected and, by the last `auth status` answer, signed in.
   * Before the first answer it is false, so the purchase tool waits for a real answer.
   */
  ready(): boolean {
    return this.configured() && this.#authCache?.value === true;
  }

  /**
   * The start check: asks `auth status` once a CLI is saved, so a signed-in Link offers the
   * purchase tool after a restart. When the CLI gives no answer (offline, slow, unreadable output)
   * it asks again after 30 s, then twice as long each time up to 10 min, until Link answers or the
   * CLI is disconnected.
   */
  startCheck(): void {
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
    if (this.#stopped) return;
    // One chain at a time: a newer startCheck, a disconnect or stop() ends an older chain.
    const me = ++this.#chain;
    const live = () => !this.#stopped && me === this.#chain;
    let wait = this.#o.statusRetryMs ?? STATUS_RETRY_MS;
    const attempt = async (): Promise<void> => {
      if (!live()) return;
      this.#retry = undefined;
      let answer: boolean | undefined;
      try {
        if (!this.configured()) return;
        answer = await this.#askStatus();
      } catch {
        // An error is no answer: go on to the next back-off step below.
      }
      try {
        if (!live() || answer !== undefined || !this.configured()) return;
      } catch {
        return;
      }
      this.#retry = setTimeout(() => void attempt(), wait);
      this.#retry.unref?.();
      wait = Math.min(wait * 2, STATUS_RETRY_MAX_MS);
    };
    void attempt();
  }

  readonly #changeListeners = new Set<() => void>();
  #lastReady = false;

  /** Tells the listeners when `ready()` changed since they last heard. */
  #readyChanged(): void {
    const now = this.ready();
    if (now === this.#lastReady) return;
    this.#lastReady = now;
    for (const l of this.#changeListeners) l();
  }

  /**
   * Called whenever a CLI is connected or forgotten, or Link is signed in or out (the purchase
   * tool follows this).
   */
  onConfiguredChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  #runnable(): { path: string } | { reason: LinkSetupReason; path: string } | undefined {
    const cli = this.cli();
    if (cli === undefined) return undefined;
    if (cli.source === "env") return { path: cli.path };
    const r = checkLinkCliPath(cli.path, this.#deps());
    return r.ok ? { path: r.real } : { reason: r.reason, path: cli.path };
  }

  /** Node runs a script (`.js`, `.mjs`, `.cjs`) itself; a program is started as it is. */
  #launch(path: string, args: string[]): { file: string; args: string[] } {
    return SCRIPT.test(path)
      ? { file: process.execPath, args: [path, ...args] }
      : { file: path, args };
  }

  /** Rebuilds the wallet from the saved config; called at start and on every change. */
  #sync(): void {
    const cli = this.cli();
    this.#forgetAuth();
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
              // The wallet wraps a `.js` as `node <script> …`; start again from the path just
              // checked, with the CLI's own arguments only.
              const own = file === process.execPath ? args.slice(1) : args;
              const l = this.#launch(ok.path, own);
              return (this.#o.run ?? runFile)(l.file, l.args, env, CLI_TIMEOUT_MS);
            },
          });
    this.#lastReady = this.ready();
    for (const l of this.#changeListeners) l();
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
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      LINK_AUTH_FILE: this.authFile,
    };
    const l = this.#launch(ok.path, [...args, "--format", "json"]);
    const out = await (this.#o.run ?? runFile)(l.file, l.args, env, timeoutMs);
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

  #forgetAuth(): void {
    this.#gen += 1;
    this.#authCache = undefined;
    this.#readyChanged();
  }

  /**
   * Whether `auth status` says signed in. One process at a time (a second caller joins it), and
   * the answer is kept for `STATUS_TTL_MS` unless `fresh` (the sign-in poll, the sign-in start).
   * A run that gives no answer (a timeout, unreadable output) changes nothing: the last answer
   * stands, so one slow run neither withdraws the purchase tool nor its open Pay cards.
   */
  async #signedIn(opts: { fresh?: boolean } = {}): Promise<boolean> {
    const cached = this.#authCache;
    if (
      opts.fresh !== true &&
      cached !== undefined &&
      this.#s.clock.now() - cached.at < (this.#o.statusTtlMs ?? STATUS_TTL_MS)
    )
      return cached.value;
    return (await this.#askStatus()) ?? this.#authCache?.value ?? false;
  }

  /** One `auth status` run: true or false when Link answered, undefined when it did not. */
  async #askStatus(): Promise<boolean | undefined> {
    const gen = this.#gen;
    // Never join a run that started before the last connect, sign-in or disconnect: its answer
    // belongs to an older generation and would not be kept.
    if (this.#authInflight !== undefined && this.#authInflight.gen === gen)
      return this.#authInflight.run;
    const run = (async (): Promise<boolean | undefined> => {
      // A CLI that may not run (gone, swapped, unsafe) is a definite no.
      const ok = this.#runnable();
      if (ok === undefined || "reason" in ok) return false;
      try {
        const doc = unwrapJson(JSON.parse(await this.#exec(["auth", "status"]))) as {
          authenticated?: unknown;
        } | null;
        return doc?.authenticated === true;
      } catch (e) {
        // Only a timeout or a failure to start the CLI is "no answer". A CLI that ran and exited
        // non-zero (signed out, expired token) is not signed in: fail closed, never keep "ready".
        const x = e as { exitCode?: unknown; killed?: unknown };
        return typeof x.exitCode === "number" && x.exitCode !== 0 && x.killed !== true
          ? false
          : undefined;
      }
    })();
    const mine = { gen, run };
    this.#authInflight = mine;
    try {
      const value = await run;
      if (value !== undefined && gen === this.#gen) {
        this.#authCache = { at: this.#s.clock.now(), value };
        this.#readyChanged();
      }
      return value;
    } finally {
      if (this.#authInflight === mine) this.#authInflight = undefined;
    }
  }

  async status(): Promise<LinkSetupStatus> {
    const cli = this.cli();
    const runnable = this.#runnable();
    const det = detectLinkClis({ ...this.#o.detect, ...this.#deps() });
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
    // While signing in, the poll is the only caller of the CLI: status never spawns it.
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

  /** The audit entry names the device that asked; the sign-in poll reuses the starter's. */
  #audit(kind: string, data: Record<string, string>, deviceId?: string): void {
    this.#s.audit
      .append({
        kind,
        actor: deviceId === undefined ? { type: "system" } : { type: "device", deviceId },
        subject: { setting: "payments.linkCli" },
        data,
      })
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
    const r = checkLinkCliPath(path, this.#deps());
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
    const again = checkLinkCliPath(r.real, this.#deps());
    if (!again.ok)
      throw new PsycheError("invalid_params", REASON_TEXT[again.reason], {
        details: { reason: again.reason },
      });
    setSetting(this.#db, LINK_CLI_SETTING, { path: again.real });
    this.#sync();
    // Same back-off as at start: a transient failure of the first `auth status` is asked again.
    this.startCheck();
    this.#audit(
      "payments.link_cli_connected",
      { path: again.real, deviceId: call.identity.deviceId },
      call.identity.deviceId,
    );
    const status = await this.status();
    this.#changed(status);
    return status;
  }

  async signIn(call: Call): Promise<LinkSetupStatus> {
    if (this.cli() === undefined || !this.configured()) throw NOT_SET_UP();
    if (await this.#signedIn({ fresh: true }))
      throw new PsycheError("conflict", "Already signed in to Link", {
        details: { reason: "already_signed_in" },
      });
    let parsed: ReturnType<typeof parseLogin>;
    try {
      // Psyche pays through Link and needs nothing else: no financial-insights scopes.
      parsed = parseLogin(
        await this.#exec(["auth", "login", "--client-name", "Psyche", "--no-financial-insights"]),
      );
    } catch {
      throw new PsycheError("unavailable", "The Link CLI could not start sign-in", {
        details: { reason: "link_cli_failed" },
      });
    }
    if (parsed === undefined)
      throw new PsycheError("unavailable", "Link did not return its sign-in page", {
        details: { reason: "link_signin_unreadable" },
      });
    const deviceId = call.identity.deviceId;
    this.#login = {
      ...parsed,
      expiresAt: this.#s.clock.now() + (this.#o.loginMs ?? LOGIN_MS),
      deviceId,
    };
    this.#forgetAuth();
    this.#audit("payments.link_signin_started", { deviceId }, deviceId);
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
    const done = await this.#signedIn({ fresh: true });
    if (!done && login.expiresAt > this.#s.clock.now()) return;
    if (this.#login !== login) return;
    this.#login = undefined;
    this.#stopPoll();
    if (done) this.#audit("payments.link_signed_in", { deviceId: login.deviceId }, login.deviceId);
    this.#changed(await this.status());
  }

  #stopPoll(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #openSpends(): SpendRow[] {
    const now = this.#s.clock.now();
    const given = getSetting(this.#db, LINK_ABANDONED_SETTING)?.value as
      | { before?: unknown }
      | undefined;
    const before = typeof given?.before === "number" ? given.before : 0;
    return openSpendsOf(
      readSpendRecords(join(this.#s.home, "vault", "payments"), now),
      now,
      before,
    );
  }

  /**
   * Signs out and forgets the CLI. A payment still open refuses it (`conflict`), because the CLI
   * is what cancels, captures or reports it; `force` (admin only, audited) gives those payments up
   * instead: they are cancelled where Link still allows it, and a hold at the merchant lapses on
   * its own.
   */
  async disconnect(call: Call, force = false): Promise<LinkSetupStatus> {
    const open = this.#openSpends();
    if (open.length > 0 && !force)
      throw new PsycheError("conflict", "A payment is still in progress; disconnect when it ends", {
        details: {
          reason: "payment_in_progress",
          open: open.length,
          payments: open
            .slice(0, 3)
            .map((p) => ({ merchantName: p.merchantName, merchantHost: p.merchantHost })),
        },
      });
    if (open.length > 0) {
      this.#audit(
        "payments.link_disconnect_forced",
        {
          open: String(open.length),
          spends: open.map((p) => p.spendRequestId).join(","),
          deviceId: call.identity.deviceId,
        },
        call.identity.deviceId,
      );
      for (const p of open) await this.broker?.cancel(p.spendRequestId).catch(() => undefined);
      setSetting(this.#db, LINK_ABANDONED_SETTING, { before: this.#s.clock.now() });
    }
    const deviceId = call.identity.deviceId;
    this.#login = undefined;
    this.#stopPoll();
    // Best effort at Link; the local file goes either way, and a skipped or failed logout is audited.
    let logout: string | undefined;
    const runnable = this.#runnable();
    if (runnable === undefined || "reason" in runnable) logout = "cli_unavailable";
    else await this.#exec(["auth", "logout"], 30_000).catch(() => (logout = "cli_failed"));
    try {
      unlinkSync(this.authFile);
    } catch {
      // Already gone.
    }
    if (existsSync(this.authFile))
      throw new PsycheError("internal", "The Link auth file could not be removed");
    deleteSettings(this.#db, [LINK_CLI_SETTING]);
    this.#sync();
    this.#chain += 1;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
    if (logout !== undefined)
      this.#audit("payments.link_logout_skipped", { reason: logout, deviceId }, deviceId);
    this.#audit("payments.link_disconnected", { deviceId }, deviceId);
    const status = await this.status();
    this.#changed(status);
    return status;
  }

  stop(): void {
    this.#stopped = true;
    this.#chain += 1;
    this.#stopPoll();
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#changeListeners.clear();
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
    link.broker = part.payments;
    const availability = {
      configured: () => link.configured(),
      ready: () => link.ready(),
      onChange: (l: () => void) => link.onConfiguredChange(l),
    };
    // The purchase tool waits for Link's own answer: ask at start when a CLI is saved, and again
    // with back-off while the CLI gives no answer.
    link.startCheck();
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
      "payments.link.signIn": { run: (c: Call) => link.signIn(c) },
      "payments.link.disconnect": {
        run: (c: Call, p: { force?: boolean }) => link.disconnect(c, p.force === true),
      } as HandlerDef,
    };
    return {
      ...part,
      handlers,
      availability,
      stop: async () => {
        link.stop();
        await part.stop?.();
      },
    };
  };
}
