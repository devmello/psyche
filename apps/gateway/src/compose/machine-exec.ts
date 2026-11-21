import { createHash } from "node:crypto";
import type { ToolRunContext } from "@psyche/agent-core";
import {
  type AuditLog,
  type ComputerMachineRef,
  type ErrorCode,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_OUTPUT_CAP_BYTES,
  type PermissionBroker,
  PsycheError,
  type ToolCallDescription,
  type ToolResult,
} from "@psyche/protocol";
import {
  type MachineDirectory,
  type MachineFolderGrants,
  machinePath,
  needsMachineFolder,
} from "./machine-files.ts";

/**
 * `exec_host` on a paired machine (docs/design/linux-helper-only-2026.md §5.1, wave H5): the
 * `machine` hook of `compose/exec-host.ts`. A call that names `machine` never runs on the Host.
 *
 * - **What runs is on the card.** Before the card the box resolves argv[0] and hashes the file
 *   it would run (`exec.resolve`); the card shows that program and binds its SHA-256, whether the
 *   box runs it contained or on the full account, and the network (off unless the call asks and
 *   the box's limits allow it). The run sends the hash back (`expectSha256`) and the box runs the
 *   very inode it hashed, or nothing (`executable_changed`). A grant's key holds the same hash,
 *   so a changed binary never runs under an old grant: it gets a fresh card.
 * - **The card's binding** is the tool, every argument, the machine's device id, the hash, the
 *   containment and the network: a card approved for one machine is refused on another and on
 *   the Host, even when names were swapped between the card and the run.
 * - **Where:** a folder granted on that machine for this conversation (`machine_files` op
 *   `request_folder`), pinned by the box's folder id; the box checks it again against its own
 *   ceiling and refuses a folder that was swapped since (`folder_moved`).
 * - **Taint:** everything the box returns is `untrusted`; a tainted turn gets `once` only.
 * - The box runs it contained (bwrap, network off) by default, never with a shell, with a
 *   scrubbed environment, output capped and the process tree killed on Stop or when the machine
 *   is removed. No srt, no `UNSANDBOXED`: the box's ceiling decides containment.
 */

export interface MachineExecParams {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  allowedDomains?: string[];
  timeoutMs?: number;
  machine: string;
  /** Ask for the network inside the box's sandbox (off by default; the box's limits decide). */
  network?: boolean;
}

export interface MachineExecDeps {
  directory: MachineDirectory;
  grants: MachineFolderGrants;
  broker: Pick<PermissionBroker, "get">;
  vault: { redact(text: string): string };
  audit?: Pick<AuditLog, "append">;
  /** Clock for the resolve cache (tests). */
  now?: () => number;
}

/** Names the box refuses too (its `reserved_env`): checked here so the card never shows them. */
const RESERVED =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|IFS|ENV|BASH_ENV|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|PROMPT_COMMAND|SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO|DBUS_SESSION_BUS_ADDRESS|DBUS_SYSTEM_BUS_ADDRESS|XDG_RUNTIME_DIR|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|LD_.*|PSYCHE_.*|SUDO_.*|BASH_FUNC_.*|GIO_.*|GTK_.*|QT_.*)$/;

/** How long a resolved program is used before the box is asked again (in the background). */
export const MACHINE_RESOLVE_TTL_MS = 5 * 60_000;
/** How long the box's refusal of a program is repeated before it is asked again. */
const RESOLVE_ERROR_TTL_MS = 10_000;

/** What the box said about argv[0] in a folder: the file it would run, and how. */
export interface MachineProgram {
  executable: string;
  sha256: string;
  contained: boolean;
  networkAllowed: boolean;
}

/** The grant key of one exact command, program, containment and network on one machine. */
export function machineExecGrantKey(
  deviceId: string,
  argv: readonly string[],
  cwd: string,
  env: readonly string[],
  run: { sha256: string; contained: boolean; network: boolean },
): string {
  return `exec_host|machine|${deviceId}|${JSON.stringify([
    argv,
    cwd,
    env,
    run.sha256,
    run.contained ? "contained" : "full_account",
    run.network ? "network" : "no_network",
  ])}`;
}

const envList = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .sort();

function argvHash(argv: readonly string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(argv)).digest("hex")}`;
}

const str = (v: unknown, cap: number) => (typeof v === "string" ? v.slice(0, cap) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const SHA = /^sha256:[0-9a-f]{64}$/;
const BOX_CODES: ReadonlySet<string> = new Set([
  "not_found",
  "forbidden",
  "invalid_params",
  "unavailable",
  "binding_mismatch",
]);
/** The box's refusals that mean "what was approved is not what is there now". */
const STALE = new Set(["executable_changed", "executable_changing", "containment_changed"]);

type Cached =
  | { at: number; program: MachineProgram }
  | { at: number; error: PsycheError }
  | { at: number; pending: true };

/** Whether the command gets the network: always on the full account, else only when asked. */
const networkOf = (p: MachineExecParams, contained: boolean) => !contained || p.network === true;

export function machineExec(deps: MachineExecDeps) {
  const now = deps.now ?? Date.now;
  /** argv[0] in a folder on a machine → what the box resolved it to (no secrets: paths, hashes). */
  const programs = new Map<string, Cached>();
  const cacheKey = (deviceId: string, argv0: string, cwd: string) =>
    JSON.stringify([deviceId, argv0, cwd]);

  function resolve(ref: string): ComputerMachineRef {
    const m = deps.directory.resolve(ref);
    if (m === undefined) {
      throw new PsycheError(
        "not_found",
        `No paired computer is called ${ref}; machines.list names them`,
      );
    }
    return m;
  }

  function offline(machine: ComputerMachineRef): PsycheError {
    return new PsycheError("unavailable", `${machine.name} is offline`, {
      retryable: true,
      details: { reason: "machine_offline", machine },
    });
  }

  function checked(p: MachineExecParams) {
    const machine = resolve(p.machine);
    const cwd = machinePath(p.cwd);
    if (cwd === undefined) {
      throw new PsycheError("invalid_params", "cwd must be an absolute path without `..`");
    }
    const argv0 = p.argv[0];
    if (typeof argv0 !== "string" || argv0 === "" || argv0.includes("\0")) {
      throw new PsycheError("invalid_params", "argv[0] must name a program");
    }
    for (const k of Object.keys(p.env ?? {})) {
      if (RESERVED.test(k)) throw new PsycheError("invalid_params", `env ${k} is fixed`);
      if ((p.env?.[k] ?? "").includes("{{cred:")) {
        throw new PsycheError("invalid_params", `env ${k}: no vault placeholders on a machine`);
      }
    }
    if ((p.allowedDomains ?? []).length > 0) {
      throw new PsycheError(
        "invalid_params",
        "allowedDomains is not used on a machine: ask for `network: true`, and the computer's own limits decide",
      );
    }
    return { machine, cwd, argv0, env: envList(p.env ?? {}) };
  }

  /** Asks the box what argv[0] is in `cwd`, and keeps the answer. */
  function refresh(machine: ComputerMachineRef, argv0: string, cwd: string): void {
    const key = cacheKey(machine.deviceId, argv0, cwd);
    const before = programs.get(key);
    if (before !== undefined && "pending" in before) return;
    const client = deps.directory.client(machine.deviceId);
    if (client === undefined) return;
    // A known program stays usable while it is checked again; an unknown one is pending.
    if (before === undefined || !("program" in before)) {
      programs.set(key, { at: now(), pending: true });
    }
    void client
      .invoke("exec.resolve", { argv0, cwd }, { timeoutMs: 15_000 })
      .then((r) => {
        if (!r.ok) {
          const e = r.error ?? { code: "unavailable", message: "the machine failed" };
          const reason = (e.details as { reason?: unknown } | undefined)?.reason;
          const code = BOX_CODES.has(e.code) ? (e.code as ErrorCode) : "unavailable";
          programs.set(key, {
            at: now(),
            error: new PsycheError(code, `${machine.name}: ${str(e.message, 500)}`, {
              details: {
                machine,
                ...(typeof reason === "string" ? { reason: reason.slice(0, 64) } : {}),
              },
            }),
          });
          return;
        }
        const res = (r.result ?? {}) as Record<string, unknown>;
        const executable = typeof res.executable === "string" ? machinePath(res.executable) : "";
        if (
          executable === undefined ||
          executable === "" ||
          typeof res.executableSha256 !== "string" ||
          !SHA.test(res.executableSha256) ||
          typeof res.contained !== "boolean" ||
          typeof res.networkAllowed !== "boolean"
        ) {
          programs.set(key, {
            at: now(),
            error: new PsycheError("unavailable", `${machine.name} gave no usable answer`),
          });
          return;
        }
        programs.set(key, {
          at: now(),
          program: {
            executable,
            sha256: res.executableSha256,
            contained: res.contained,
            networkAllowed: res.networkAllowed,
          },
        });
      })
      .catch(() => {
        programs.set(key, {
          at: now(),
          error: new PsycheError("unavailable", `${machine.name} did not answer`, {
            retryable: true,
          }),
        });
      });
  }

  /**
   * The program argv[0] names on the box, for the card (synchronous, as `describeCall` must be).
   * The first call for a program asks the box and is refused with "call again": the card never
   * shows a program the box did not name.
   */
  function programFor(machine: ComputerMachineRef, argv0: string, cwd: string): MachineProgram {
    const key = cacheKey(machine.deviceId, argv0, cwd);
    const c = programs.get(key);
    if (c !== undefined && "program" in c) {
      if (now() - c.at > MACHINE_RESOLVE_TTL_MS) refresh(machine, argv0, cwd);
      return c.program;
    }
    if (c !== undefined && "error" in c) {
      programs.delete(key);
      if (now() - c.at <= RESOLVE_ERROR_TTL_MS) throw c.error;
    }
    if (deps.directory.client(machine.deviceId) === undefined) throw offline(machine);
    refresh(machine, argv0, cwd);
    throw new PsycheError(
      "invalid_params",
      `checking ${argv0.slice(0, 200)} on ${machine.name} first (the card shows the program it runs and its hash); call exec_host again with the same arguments`,
      { retryable: true, details: { reason: "machine_resolving", machine } },
    );
  }

  /** The cached program, for a run under a grant (the gate described it moments ago). */
  function cachedProgram(deviceId: string, argv0: string, cwd: string): MachineProgram | undefined {
    const c = programs.get(cacheKey(deviceId, argv0, cwd));
    return c !== undefined && "program" in c ? c.program : undefined;
  }

  function forget(deviceId: string, argv0: string, cwd: string): void {
    programs.delete(cacheKey(deviceId, argv0, cwd));
  }

  return {
    /** The card's description (synchronous, as `describeCall` must be). */
    describe(p: MachineExecParams): ToolCallDescription {
      const { machine, cwd, argv0, env } = checked(p);
      // Before the card: no grant on this machine holds the folder means nothing could run.
      const folder = deps.grants.widest(machine.deviceId, cwd);
      if (folder === undefined) throw needsMachineFolder(machine, cwd, "read");
      const program = programFor(machine, argv0, cwd);
      if (p.network === true && program.contained && !program.networkAllowed) {
        throw new PsycheError(
          "forbidden",
          `${machine.name}'s limits keep contained commands off the network; ask the owner to allow it there, or run without it`,
          { details: { reason: "machine_policy", machine } },
        );
      }
      const network = networkOf(p, program.contained);
      const command = p.argv.join(" ");
      const where = program.contained
        ? network
          ? " with the network on"
          : ""
        : " on the full account";
      return {
        kind: "exec_host",
        target: { kind: "command", value: command.slice(0, 1000) },
        summary: `Run \`${command.slice(0, 80)}\` on ${machine.name}${where}`,
        details: {
          machine,
          argv: p.argv,
          cwd,
          env,
          onMachine: true,
          executable: program.executable,
          executableSha256: program.sha256,
          contained: program.contained,
          network: network ? "on" : "off",
          folder: folder.path,
          folderMode: folder.mode,
        },
        bindingFields: {
          argv: p.argv,
          cwd,
          env: { ...(p.env ?? {}) },
          machine: machine.deviceId,
          executable: program.executable,
          executableSha256: program.sha256,
          contained: program.contained,
          network: network ? "on" : "none",
        },
        grantKey: machineExecGrantKey(machine.deviceId, p.argv, cwd, env, {
          sha256: program.sha256,
          contained: program.contained,
          network,
        }),
      };
    },

    async run(p: MachineExecParams, ctx: ToolRunContext): Promise<ToolResult> {
      const { machine, cwd, argv0, env } = checked(p);
      // What was approved: from the card itself, or from the grant's key. A card answered for
      // one computer never runs on another, whatever the `machine` argument resolves to now.
      let approved: { sha256: string; contained: boolean; network: boolean };
      if (ctx.approvalId !== undefined) {
        const a = await deps.broker.get(ctx.approvalId);
        const d = (a?.details ?? {}) as {
          machine?: { deviceId?: unknown };
          argv?: unknown;
          cwd?: unknown;
          env?: unknown;
          executableSha256?: unknown;
          contained?: unknown;
          network?: unknown;
        };
        // The loop verified the binding; the card's own words must say the same (belt and braces:
        // the machine, the argv, the cwd, the env, the program and how it runs).
        const same =
          a !== undefined &&
          a.kind === "exec_host" &&
          d.machine?.deviceId === machine.deviceId &&
          JSON.stringify(d.argv) === JSON.stringify(p.argv) &&
          d.cwd === cwd &&
          JSON.stringify(d.env) === JSON.stringify(env) &&
          typeof d.executableSha256 === "string" &&
          SHA.test(d.executableSha256) &&
          typeof d.contained === "boolean" &&
          (d.network === "on" || d.network === "off") &&
          (d.network === "on") === networkOf(p, d.contained);
        if (!same) {
          throw new PsycheError(
            "binding_mismatch",
            `this command was not approved for ${machine.name}; it was not run`,
          );
        }
        approved = {
          sha256: d.executableSha256 as string,
          contained: d.contained as boolean,
          network: d.network === "on",
        };
      } else {
        // A grant: its key holds the program's hash, so it covers that program only.
        const program = cachedProgram(machine.deviceId, argv0, cwd);
        const run =
          program === undefined
            ? undefined
            : {
                sha256: program.sha256,
                contained: program.contained,
                network: networkOf(p, program.contained),
              };
        const key = ctx.authority?.grantKey;
        if (
          run === undefined ||
          ctx.authority?.grantId === undefined ||
          key !== machineExecGrantKey(machine.deviceId, p.argv, cwd, env, run)
        ) {
          // The program changed between the check and the run, or no grant names it: the next
          // call shows its card.
          throw new PsycheError(
            "binding_mismatch",
            `this command on ${machine.name} is not covered by a grant for this program; call it again to see its card`,
          );
        }
        approved = run;
      }
      const grant = deps.grants.covering(machine.deviceId, ctx.threadId, cwd);
      if (grant === undefined) throw needsMachineFolder(machine, cwd, "read");
      const client = deps.directory.client(machine.deviceId);
      if (client === undefined) throw offline(machine);
      const timeoutMs = p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
      const started = Date.now();
      const r = await client.invoke(
        "exec.host",
        {
          argv: p.argv,
          cwd,
          folder: grant.path,
          folderMode: grant.mode,
          ...(grant.folderId === undefined ? {} : { folderId: grant.folderId }),
          ...(p.env === undefined ? {} : { env: p.env }),
          timeoutMs,
          expectSha256: approved.sha256,
          expectContained: approved.contained,
          // The sandbox's switch; a full-account command has the account's network anyway.
          ...(approved.contained && approved.network ? { network: true } : {}),
        },
        {
          // The box refuses exec.host without one; it names what let this run.
          approvalId: ctx.approvalId ?? (ctx.authority?.grantId as string),
          signal: ctx.signal,
          timeoutMs: timeoutMs + 15_000,
          onEvent: (e) => {
            const d = e.data as { stream?: unknown; text?: unknown } | undefined;
            if (d?.stream === "stdout" || d?.stream === "stderr") {
              ctx.onUpdate({
                data: { machine, stream: d.stream, text: deps.vault.redact(str(d.text, 64_000)) },
              });
            }
          },
        },
      );
      const res = (r.ok ? r.result : {}) as Record<string, unknown>;
      const sha = typeof res.executableSha256 === "string" ? res.executableSha256 : undefined;
      const exitCode = num(res.exitCode);
      const timedOut = res.timedOut === true;
      // Receipt-like trail: the argv hash, cwd, exit code and duration, never output.
      await deps.audit
        ?.append({
          kind: "machine.exec",
          actor: { type: "agent", runId: ctx.runId },
          subject: { runId: ctx.runId, threadId: ctx.threadId },
          data: {
            machine,
            argvSha256: argvHash(p.argv),
            cwd,
            ok: r.ok,
            exitCode,
            durationMs: Date.now() - started,
            executableSha256: sha ?? approved.sha256,
            contained: approved.contained,
            network: approved.network,
          },
        })
        .catch(() => undefined);
      if (!r.ok) {
        const e = r.error ?? { code: "internal", message: "the machine failed" };
        const reason = (e.details as { reason?: unknown } | undefined)?.reason;
        // What was approved is not what is there now: the next call checks the box again (and
        // so shows a fresh card), and a swapped folder is not granted any more.
        if (typeof reason === "string" && STALE.has(reason)) forget(machine.deviceId, argv0, cwd);
        if (reason === "folder_moved") deps.grants.forget(grant);
        return {
          output: {
            machine,
            error: {
              code: str(e.code, 64),
              message: str(e.message, 2000),
              ...(typeof reason === "string" ? { reason: reason.slice(0, 64) } : {}),
            },
          },
          isError: true,
          provenance: "untrusted",
        };
      }
      const outcome = timedOut ? "uncertain" : exitCode === 0 ? "ok" : "failed";
      return {
        output: {
          machine,
          exitCode,
          stdout: deps.vault.redact(str(res.stdout, EXEC_OUTPUT_CAP_BYTES)),
          stderr: deps.vault.redact(str(res.stderr, EXEC_OUTPUT_CAP_BYTES)),
          durationMs: num(res.durationMs),
          truncated: res.truncated === true,
          timedOut,
          contained: res.contained === true,
          network: res.network === true,
          executable: str(res.executable, 4096),
          ...(sha === undefined ? {} : { executableSha256: sha }),
          cwd,
          outcome,
        },
        provenance: "untrusted",
        ...(outcome === "ok" ? {} : { isError: true }),
      };
    },
  };
}

export type MachineExecHook = ReturnType<typeof machineExec>;
