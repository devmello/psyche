import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RollbackHooks } from "./linux-apply.ts";

/**
 * The data half of Linux "Go back" (docs/design/linux-desktop-2026.md §"Rollback"): the
 * `RollbackHooks` that `rollbackLinux` (linux-apply.ts) calls.
 *
 * The snapshot restore and its undo are not done here. They are `psyched pre-update go-back`,
 * `go-back-undo` and `go-back-commit` (apps/gateway/src/go-back.ts), run through the psyched this
 * app launches: the running app's own code, which knows the snapshot format of the data it just
 * wrote (after a deb/rpm downgrade the files under /usr/lib/psyche are the old version's, which
 * may not have these commands; see `undoRestore` below). The Gateway stays the only code that
 * reads or writes its data, and a crash between the restore and the undo is settled by the
 * Gateway itself at its next start, before it opens anything.
 */

/** Runs `psyched <args>` as the CLI; resolves with its exit code and what it printed. */
export type RunPsyched = (args: string[]) => Promise<{ code: number; output: string }>;

/** A restore copies databases and hashes them twice; give it room on a big data folder. */
const PSYCHED_TIMEOUT_MS = 10 * 60_000;

export function psychedRunner(
  launch: { program: string; args: readonly string[] },
  env: NodeJS.ProcessEnv,
  home: string,
): RunPsyched {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        launch.program,
        [...launch.args, ...args],
        {
          encoding: "utf8",
          maxBuffer: 1 << 20,
          timeout: PSYCHED_TIMEOUT_MS,
          env: { ...env, PSYCHE_HOME: home },
        },
        (err, stdout, stderr) => {
          const output = `${stdout}${stderr}`;
          if (!err) return resolve({ code: 0, output });
          const code = (err as { code?: unknown }).code;
          if (typeof code === "number") return resolve({ code, output });
          reject(err);
        },
      );
    });
}

export const SKIP_BUILDS_FILE = join("run", "skip-builds.json");

interface SkipBuilds {
  skipped: { release: string; build?: string; at: string }[];
}

function readSkipBuilds(home: string): SkipBuilds {
  try {
    const v = JSON.parse(readFileSync(join(home, SKIP_BUILDS_FILE), "utf8")) as {
      skipped?: unknown;
    };
    if (!Array.isArray(v.skipped)) return { skipped: [] };
    return {
      skipped: v.skipped.filter(
        (s): s is SkipBuilds["skipped"][number] =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as { release?: unknown }).release === "string",
      ),
    };
  } catch {
    // Missing, or damaged: nothing is skipped (the owner can still say no to an offer).
    return { skipped: [] };
  }
}

/** The releases "Go back" left, which the updater must not offer again. */
export function skippedReleases(home: string): string[] {
  return readSkipBuilds(home).skipped.map((s) => s.release);
}

function writeSkipBuilds(home: string, value: SkipBuilds): void {
  const file = join(home, SKIP_BUILDS_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  try {
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

function failure(what: string, res: { code: number; output: string }): Error {
  const text = res.output.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  return new Error(`${what} (exit ${res.code})${text ? `: ${text}` : ""}`);
}

export interface LinuxRollbackOptions {
  /** `$PSYCHE_HOME`. */
  home: string;
  run: RunPsyched;
  now?: () => Date;
}

/** The hooks for `rollbackLinux`, plus the skip list the updater reads. */
export function linuxRollbackHooks(
  o: LinuxRollbackOptions,
): RollbackHooks & { isSkipped(release: string): boolean } {
  return {
    async restoreSnapshot(toVersion) {
      // Journals what it changes, then restores; if it stops halfway it puts everything back
      // before it reports failure, so a thrown error here leaves the data as it was.
      const res = await o.run(["pre-update", "go-back", toVersion]);
      if (res.code !== 0) throw failure("the data could not be put back", res);
    },
    async undoRestore(toVersion) {
      // Needs a psyched that has `go-back-undo`: the running app's. After a package downgrade that
      // failed halfway the files may be the old version's and refuse the command; this then
      // throws, rollbackLinux says so, and the Gateway's own start settles the journal.
      const res = await o.run(["pre-update", "go-back-undo", toVersion]);
      if (res.code !== 0) throw failure("the newer data could not be put back", res);
    },
    async recordSkipBuild(build) {
      const errors: string[] = [];
      // The data side first: the go-back happened, so the journal must not be undone later.
      try {
        const res = await o.run(["pre-update", "go-back-commit"]);
        if (res.code !== 0) errors.push(failure("could not record the go back", res).message);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      try {
        const rest = readSkipBuilds(o.home).skipped.filter((s) => s.release !== build.release);
        writeSkipBuilds(o.home, {
          skipped: [
            ...rest,
            {
              release: build.release,
              ...(build.build === undefined ? {} : { build: build.build }),
              at: (o.now ?? (() => new Date()))().toISOString(),
            },
          ],
        });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      if (errors.length > 0) throw new Error(errors.join("; "));
    },
    isSkipped: (release) => skippedReleases(o.home).includes(release),
  };
}
