import { execFile } from "node:child_process";
import {
  type AgentToolRegistration,
  type CodingToolsDeps,
  codingTools,
  type GitRunner,
} from "@psyche/agent-core";
import type { SandboxRunner } from "@psyche/protocol";
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
 * `git` on the host as a child process with an argv (no shell). Prompts are off, so a push that
 * needs credentials the owner's helpers cannot supply fails instead of waiting on a terminal;
 * `GIT_DIR` / `GIT_WORK_TREE` from the Gateway's own environment never redirect it.
 */
export function hostGit(binary = "git"): GitRunner {
  return {
    run(cwd, args, options = {}) {
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
      for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF"]) {
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
  const tools = codingTools({
    files: { read, write },
    folders: () => services.rawBroker.policy.folders,
    broker: services.broker,
    ...(setup.runner === undefined ? {} : { runner: setup.runner }),
    ...(setup.track === undefined ? {} : { track: setup.track }),
    ...(git === null ? {} : { git }),
  });
  const unregister = tools.map((t) => services.tools.register(t));
  services.logger?.log("info", "coding: code.* tools enabled", {
    run: setup.runner !== undefined,
    git: git !== null,
  });
  return {
    stop: () => {
      for (const u of unregister) u();
    },
  };
}
