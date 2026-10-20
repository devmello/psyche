import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { assertProfileName, psycheHome } from "../profiles.ts";

/**
 * Real-Chrome mode (feature I13; ADR-007; security §6 "CDP exposure"): a separate branded
 * Google Chrome with its own user data dir under `$PSYCHE_HOME/browser/real-chrome/<profile>/`,
 * where the owner signs in and installs store extensions such as 1Password (Agentic Mode). It
 * is never the owner's everyday Chrome profile (Chrome 136+ also refuses remote debugging on
 * the default data dir), so the model can never reach that profile's cookies or history.
 *
 * DevTools has no authentication, so the endpoint exists only while Psyche is attached: the
 * launcher binds it to 127.0.0.1 on a random port (`--remote-debugging-port=0`, read back from
 * `DevToolsActivePort`), and `close()` ends the process. The composition registers the port as
 * one of Psyche's own (`ownPorts`) and `psyche security audit` flags it while it runs. A
 * pipe-based attachment (security §16 open question 3) would remove the port; Playwright's
 * `connectOverCDP` needs a WebSocket, so it is not used yet.
 */
export interface RealChrome {
  /** `ws://127.0.0.1:<port>/devtools/browser/<id>`. */
  readonly endpoint: string;
  readonly port: number;
  readonly pid: number;
  readonly userDataDir: string;
  readonly startedAt: number;
  /** True until `close()` or the process exits. */
  readonly running: boolean;
  /** Ends Chrome (TERM, then KILL after 5 s) and removes the port file. */
  close(): Promise<void>;
  /** Called once when the process exits, for whatever reason. */
  onExit(listener: () => void): void;
}

export interface RealChromeOptions {
  profile?: string;
  psycheHome?: string;
  /** Branded Chrome; default from `findBrandedChrome`. */
  executablePath?: string;
  /** Extra switches (tests pass `--headless=new`). Never debugging or data-dir switches. */
  extraArgs?: string[];
  /** How long to wait for `DevToolsActivePort` (default 15 s). */
  startTimeoutMs?: number;
  spawn?: typeof spawn;
}

/** Google Chrome (branded: store extensions work), never Chromium or the embedded browser. */
export function findBrandedChrome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.PSYCHE_REAL_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
  ];
  return candidates.find((c) => c !== undefined && c !== "" && existsSync(c));
}

/** The owner's own Chrome data dirs, which real-Chrome mode must never open. */
export function ownerChromeDirs(home = homedir()): string[] {
  return [
    join(home, "Library", "Application Support", "Google", "Chrome"),
    join(home, "Library", "Application Support", "Google", "Chrome Beta"),
    join(home, "Library", "Application Support", "Google", "Chrome Canary"),
    join(home, "Library", "Application Support", "Chromium"),
    join(home, ".config", "google-chrome"),
    join(home, ".config", "google-chrome-beta"),
    join(home, ".config", "chromium"),
  ];
}

export function realChromeDir(profile = "default", home = psycheHome()): string {
  assertProfileName(profile);
  return join(home, "browser", "real-chrome", profile);
}

const FORBIDDEN_ARG =
  /^--(remote-debugging|user-data-dir|profile-directory|load-extension|disable-extensions-except|remote-allow-origins)/;

function within(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/** Parses `DevToolsActivePort`: the port, then the browser target path. */
export function parseDevToolsActivePort(text: string): { port: number; path: string } {
  const [portLine, pathLine] = text.split(/\r?\n/);
  const port = Number.parseInt(portLine ?? "", 10);
  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65_535 ||
    !pathLine?.startsWith("/devtools/browser/")
  ) {
    throw new PsycheError("unavailable", "Chrome wrote an unreadable DevToolsActivePort file");
  }
  return { port, path: pathLine.trim() };
}

export async function launchRealChrome(options: RealChromeOptions = {}): Promise<RealChrome> {
  const executable = options.executablePath ?? findBrandedChrome();
  if (executable === undefined) {
    throw new PsycheError(
      "unavailable",
      "Google Chrome is not installed (set PSYCHE_REAL_CHROME_PATH)",
      {
        details: { reason: "no_chrome" },
      },
    );
  }
  const userDataDir = realChromeDir(
    options.profile ?? "default",
    options.psycheHome ?? psycheHome(),
  );
  if (ownerChromeDirs().some((d) => within(userDataDir, d) || within(d, userDataDir))) {
    throw new PsycheError(
      "policy_denied",
      "real-Chrome mode never opens the owner's own Chrome profile",
      {
        details: { reason: "owner_profile" },
      },
    );
  }
  for (const a of options.extraArgs ?? []) {
    if (FORBIDDEN_ARG.test(a)) {
      throw new PsycheError("invalid_params", `real-Chrome mode sets ${a.split("=")[0]} itself`);
    }
  }
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone: sessions and cookies live here.
  await chmod(userDataDir, 0o700);
  const portFile = join(userDataDir, "DevToolsActivePort");
  // A stale file from a crashed run would point at a dead (or someone else's) port.
  await rm(portFile, { force: true });
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-name=Psyche is driving this window",
    ...(options.extraArgs ?? []),
    "about:blank",
  ];
  const child: ChildProcess = (options.spawn ?? spawn)(executable, args, {
    stdio: "ignore",
    detached: false,
  });
  let running = true;
  const exitListeners = new Set<() => void>();
  const exited = new Promise<void>((r) => {
    child.once("exit", () => {
      running = false;
      for (const l of [...exitListeners]) l();
      r();
    });
    child.once("error", () => {
      running = false;
      r();
    });
  });

  const deadline = Date.now() + (options.startTimeoutMs ?? 15_000);
  let found: { port: number; path: string } | undefined;
  while (found === undefined) {
    if (!running) throw new PsycheError("unavailable", "Chrome exited before it was ready");
    try {
      found = parseDevToolsActivePort(await readFile(portFile, "utf8"));
    } catch (err) {
      if (err instanceof PsycheError) throw err;
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new PsycheError("timeout", "Chrome did not open its DevTools endpoint in time");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const { port, path } = found;
  const pid = child.pid ?? 0;
  return {
    endpoint: `ws://127.0.0.1:${port}${path}`,
    port,
    pid,
    userDataDir,
    startedAt: Date.now(),
    get running() {
      return running;
    },
    onExit(listener) {
      if (!running) listener();
      else exitListeners.add(listener);
    },
    async close() {
      if (running) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timer);
      }
      await rm(portFile, { force: true });
    },
  };
}
