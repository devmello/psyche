import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import {
  type AgentToolRegistration,
  CodingSandboxes,
  type CodingToolsDeps,
  codingTools,
  type GitRunner,
  keepQuarantined,
} from "@psyche/agent-core";
import { PsycheError, type SandboxRunner } from "@psyche/protocol";
import { codingNotices, KEEP_ACTION } from "./coding-notices.ts";
import { protectedRoots, writeProtectedRoots } from "./protected-paths.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * The coding helper (V10): `code.open`, `code.search`, `code.read`, `code.edit`, `code.run`,
 * `code.git` from `@psyche/agent-core`, over what the Gateway already composes:
 *
 * - the P9 file tools registered in the composition root (`read_file` / `write_file`): the
 *   coding tools reuse their executors, so limits, symlink refusal and provenance are shared;
 * - the sandbox part's runner for `code.run` (absent without a container backend: no `code.run`
 *   at all, never the host shell) and its egress proxy's decision context for networked runs;
 * - the broker for receipts and the owner's granted folders for the executors' re-checks;
 * - `hostGit` for `code.git`: the `git` binary with an argument array built by agent-core
 *   (hooks off, no prompts), never a shell.
 *
 * `PSYCHE_CODING=off` leaves it out (`partsFromEnv`).
 */

export interface CodingSetup {
  /** The sandbox part's runner; without one `code.run` is not offered. */
  runner?: SandboxRunner;
  /** The sandbox part's egress context tracker (networked `code.run`). */
  track?: CodingToolsDeps["track"];
  /** Host git; `null` turns `code.git` off. Default `hostGit()`. */
  git?: GitRunner | null;
}

/** Bytes of git output kept per stream before the call fails (larger diffs are capped later). */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

/**
 * The only variables a caller may set per command (`GitRunner` `options.env`). Anything else,
 * `PATH`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, `GIT_EXEC_PATH`,
 * `DYLD_*`, `LD_*` or one of the fixed keys below, is refused: they would change which program
 * runs or undo the hardening.
 */
export const HOST_GIT_COMMAND_ENV: ReadonlySet<string> = new Set(["GIT_PROXY_COMMAND"]);

/**
 * `git` on the host as a child process with an argv (no shell). Prompts are off, so a push that
 * needs credentials the owner's helpers cannot supply fails instead of waiting on a terminal;
 * `GIT_DIR` / `GIT_WORK_TREE` from the Gateway's own environment never redirect it.
 */
export function hostGit(binary = "git"): GitRunner {
  return {
    run(cwd, args, options = {}) {
      const extra = Object.keys(options.env ?? {}).filter((k) => !HOST_GIT_COMMAND_ENV.has(k));
      if (extra.length > 0) {
        return Promise.reject(
          new PsycheError(
            "internal",
            `git may not be given ${extra.join(", ")}; only ${[...HOST_GIT_COMMAND_ENV].join(", ")} can be set per command`,
          ),
        );
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        // Discovery never climbs above the workspace into a repository around it.
        GIT_CEILING_DIRECTORIES: dirname(cwd),
        // What agent-core asks for this command, allowlisted above (a push: GIT_PROXY_COMMAND="").
        ...options.env,
      };
      for (const k of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_EXTERNAL_DIFF",
        // Programs git would run for a password: prompts are off, nothing may ask.
        "GIT_ASKPASS",
        "SSH_ASKPASS",
      ]) {
        delete env[k];
      }
      return new Promise((resolve) => {
        execFile(
          binary,
          [...args],
          {
            cwd,
            env,
            maxBuffer: GIT_MAX_BUFFER,
            timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
          (err, stdout, stderr) => {
            const code = (err as { code?: unknown } | null)?.code;
            resolve({
              exitCode: err === null ? 0 : typeof code === "number" ? code : 1,
              stdout: String(stdout),
              stderr: err !== null && stderr === "" ? err.message : String(stderr),
            });
          },
        );
      });
    },
  };
}

export function composeCoding(services: ComposeServices, setup: CodingSetup = {}): ComposedPart {
  const read = services.tools.get("read_file") as AgentToolRegistration | undefined;
  const write = services.tools.get("write_file") as AgentToolRegistration | undefined;
  if (read?.run === undefined || write?.run === undefined) {
    services.logger?.log("info", "coding: the P9 file tools are not registered; code.* is off");
    return {};
  }
  const git = setup.git === undefined ? hostGit() : setup.git;
  // What a `code.run` creates in a repository's launch config is held here (#1434 review r2):
  // inside Psyche's home, which no workspace or file tool reaches.
  const quarantineDir = join(services.home, "quarantine", "code-run");
  const notices = codingNotices((input) => services.notifier.notify(input), {
    resolve: (id) => services.notifier.resolve(id),
    quarantineDir,
  });
  // Kept across restarts: a container the runner adopts later is still stopped by Keep it.
  const sandboxes = new CodingSandboxes(join(services.home, "coding", "sandboxes.json"));
  const runner = setup.runner;
  const unregisterKeep = services.notificationActions?.register(KEEP_ACTION, async (_n, id) => {
    const kept = await keepQuarantined(quarantineDir, id, {
      // Keep it is the owner's own tap: the repository's sandbox stops first, so nothing still
      // running in it can swap a folder while entries go back (dev servers in it end too).
      beforeKeep: async (root) => {
        for (const sb of sandboxes.take(root)) {
          if (runner?.destroyScope !== undefined) await runner.destroyScope(sb.scope);
          else await runner?.destroy(sb.sandboxId);
        }
      },
    });
    services.logger?.log("info", "coding: the owner kept launch config a run made", {
      root: kept.root,
      entries: kept.kept.join(", "),
    });
  });
  const tools = codingTools({
    files: { read, write },
    // The coding tools follow the root themselves (search, git): a look within the fresh window.
    folders: () => services.rawBroker.freshGrantedFolders(),
    // A workspace is read and written (`code.edit`, `code.run` mounts it read-write): never one
    // in or around a persistence location either.
    protectedRoots: () => [...protectedRoots(services.home), ...writeProtectedRoots()],
    broker: services.broker,
    ...(setup.runner === undefined ? {} : { runner: setup.runner }),
    ...(setup.track === undefined ? {} : { track: setup.track }),
    ...(git === null ? {} : { git }),
    launchConfig: {
      quarantineDir,
      sandboxes,
      report: (report, { root }) => void notices.report(report, root),
      recreated: ({ root }) => notices.recreated(root),
    },
  });
  const unregister = tools.map((t) => services.tools.register(t));
  services.logger?.log("info", "coding: code.* tools enabled", {
    run: setup.runner !== undefined,
    git: git !== null,
  });
  return {
    stop: () => {
      for (const u of unregister) u();
      unregisterKeep?.();
    },
  };
}
