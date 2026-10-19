import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/context.ts";
import type { ExecResult } from "../src/exec.ts";
import { scriptedPrompter } from "../src/prompt.ts";

export const FIXED_NOW = new Date("2026-10-19T12:00:00.000Z");

export interface ExecCall {
  cmd: string;
  args: string[];
}

/** Answers a fake `exec` call; `undefined` → the default `{ code: 0, stdout: "", stderr: "" }`. */
export type ExecScript = (cmd: string, args: readonly string[]) => Partial<ExecResult> | undefined;

export interface TestDeps extends Deps {
  stdout: string[];
  stderr: string[];
  execCalls: ExecCall[];
  /** `$HOME` (a fresh temp dir). */
  userHome: string;
  /** `$PSYCHE_HOME` (`$HOME/.psyche`, mode 0700). */
  home: string;
}

export interface DepsOverrides extends Partial<Omit<Deps, "io">> {
  answers?: string[];
  interactive?: boolean;
  execScript?: ExecScript;
  stdin?: NodeJS.ReadableStream;
  extraEnv?: NodeJS.ProcessEnv;
}

const tempDirs: string[] = [];

export function tempDir(prefix = "psyche-cli-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Removes every temp dir made by `tempDir` / `makeDeps`; call in `afterEach`. */
export function cleanupTempDirs(): void {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function makeDeps(overrides: DepsOverrides = {}): TestDeps {
  const userHome = tempDir();
  const home = join(userHome, ".psyche");
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const execCalls: ExecCall[] = [];
  const { answers, interactive, execScript, stdin, extraEnv, ...rest } = overrides;
  return {
    env: { HOME: userHome, PSYCHE_HOME: home, ...extraEnv },
    io: {
      out: (t) => stdout.push(t),
      err: (t) => stderr.push(t),
      stdin: stdin ?? Readable.from([]),
    },
    exec: async (cmd, args) => {
      execCalls.push({ cmd, args: [...args] });
      const r = execScript?.(cmd, args) ?? {};
      return { code: 0, stdout: "", stderr: "", ...r };
    },
    fetch: globalThis.fetch,
    prompter: scriptedPrompter(answers ?? [], interactive ?? false),
    platform: "linux",
    uid: 501,
    now: () => FIXED_NOW,
    ...rest,
    stdout,
    stderr,
    execCalls,
    userHome,
    home,
  };
}

export function out(deps: TestDeps): string {
  return deps.stdout.join("\n");
}

export function err(deps: TestDeps): string {
  return deps.stderr.join("\n");
}

/** Runs with `--json` and parses what this run printed to stdout. */
export async function runJson(
  argv: readonly string[],
  deps: TestDeps,
): Promise<{ code: number; json: Record<string, unknown> }> {
  const before = deps.stdout.length;
  const code = await run([...argv, "--json"], deps);
  const text = deps.stdout.slice(before).join("\n");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`stdout is not JSON (exit ${code}):\n${text}\nstderr:\n${err(deps)}`);
  }
  return { code, json };
}

/** A 127.0.0.1 port nothing listens on (bound, then released). */
export async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}
