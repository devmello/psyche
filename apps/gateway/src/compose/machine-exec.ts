import { createHash } from "node:crypto";
import type { ToolRunContext } from "@psyche/agent-core";
import {
  type AuditLog,
  type ComputerMachineRef,
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
 * - **The card** reads "Run `<argv>` on lab-box", and its binding is the tool, every argument
 *   and the machine's device id: a card approved for one machine is refused on another and on
 *   the Host, even when names were swapped between the card and the run (the run checks the
 *   approval's own `machine` against the computer it is about to reach).
 * - **Where:** a folder granted on that machine for this conversation (`machine_files` op
 *   `request_folder`); the box checks it again against its own ceiling.
 * - **What runs** is resolved by the box, which reports the real executable and its SHA-256.
 *   An `always` grant pins that hash at its first run, and later runs send it back
 *   (`expectSha256`): a changed binary is refused by the box. A grant run with no pin refuses
 *   (asks again) rather than trusting whatever runs now.
 * - **Taint:** everything the box returns is `untrusted`; a tainted turn gets `once` only (the
 *   broker's rule for a destructive card).
 * - The box runs it contained (bwrap) by default, never with a shell, with a scrubbed
 *   environment, output capped and the process group killed on Stop or when the machine is
 *   removed. No srt, no `UNSANDBOXED`: the box's ceiling decides containment.
 */

export interface MachineExecParams {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  allowedDomains?: string[];
  timeoutMs?: number;
  machine: string;
}

export interface MachineExecDeps {
  directory: MachineDirectory;
  grants: MachineFolderGrants;
  broker: Pick<PermissionBroker, "get">;
  vault: { redact(text: string): string };
  audit?: Pick<AuditLog, "append">;
}

/** Names the box refuses too (its `reserved_env`): checked here so the card never shows them. */
const RESERVED =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|IFS|ENV|BASH_ENV|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|PROMPT_COMMAND|SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO|DBUS_SESSION_BUS_ADDRESS|DBUS_SYSTEM_BUS_ADDRESS|XDG_RUNTIME_DIR|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|LD_.*|PSYCHE_.*|SUDO_.*|BASH_FUNC_.*|GIO_.*|GTK_.*|QT_.*)$/;

/** The grant key of one exact command on one machine. */
export function machineExecGrantKey(
  deviceId: string,
  argv: readonly string[],
  cwd: string,
  env: readonly string[],
): string {
  return `exec_host|machine|${deviceId}|${JSON.stringify([argv, cwd, env])}`;
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

export function machineExec(deps: MachineExecDeps) {
  /** Binary hashes pinned by `always` grants, by grant id (lost on restart: those runs ask again). */
  const pins = new Map<string, string>();

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

  function checked(p: MachineExecParams) {
    const machine = resolve(p.machine);
    const cwd = machinePath(p.cwd);
    if (cwd === undefined) {
      throw new PsycheError("invalid_params", "cwd must be an absolute path without `..`");
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
        "allowedDomains is not used on a machine: its own limits decide whether commands reach the network",
      );
    }
    return { machine, cwd, env: envList(p.env ?? {}) };
  }

  return {
    /** The card's description (synchronous, as `describeCall` must be). */
    describe(p: MachineExecParams): ToolCallDescription {
      const { machine, cwd, env } = checked(p);
      // Before the card: no grant on this machine holds the folder means nothing could run.
      if (!deps.grants.anyCovering(machine.deviceId, cwd, false)) {
        throw needsMachineFolder(machine, cwd, "read");
      }
      const command = p.argv.join(" ");
      return {
        kind: "exec_host",
        target: { kind: "command", value: command.slice(0, 1000) },
        summary: `Run \`${command.slice(0, 80)}\` on ${machine.name}`,
        details: {
          machine,
          argv: p.argv,
          cwd,
          env,
          onMachine: true,
        },
        bindingFields: {
          argv: p.argv,
          cwd,
          env: { ...(p.env ?? {}) },
          machine: machine.deviceId,
          network: "none",
        },
        grantKey: machineExecGrantKey(machine.deviceId, p.argv, cwd, env),
      };
    },

    async run(p: MachineExecParams, ctx: ToolRunContext): Promise<ToolResult> {
      const { machine, cwd, env } = checked(p);
      // The approval or grant must be this machine's: a card answered for one computer never
      // runs on another, whatever the `machine` argument resolves to now.
      let expectSha256: string | undefined;
      let pinGrant: string | undefined;
      if (ctx.approvalId !== undefined) {
        const a = await deps.broker.get(ctx.approvalId);
        const d = (a?.details ?? {}) as {
          machine?: { deviceId?: unknown };
          argv?: unknown;
          cwd?: unknown;
          env?: unknown;
        };
        // The loop verified the binding; the card's own words must say the same (belt and braces:
        // the machine, the argv, the cwd and the env the owner saw).
        const same =
          a !== undefined &&
          a.kind === "exec_host" &&
          d.machine?.deviceId === machine.deviceId &&
          JSON.stringify(d.argv) === JSON.stringify(p.argv) &&
          d.cwd === cwd &&
          JSON.stringify(d.env) === JSON.stringify(env);
        if (!same) {
          throw new PsycheError(
            "binding_mismatch",
            `this command was not approved for ${machine.name}; it was not run`,
          );
        }
        // An `always` answer made a grant: its first run pins the binary.
        if (ctx.authority?.grantId !== undefined && ctx.authority.scope === "always") {
          pinGrant = ctx.authority.grantId;
        }
      } else {
        const key = ctx.authority?.grantKey;
        const id = ctx.authority?.grantId;
        if (key !== machineExecGrantKey(machine.deviceId, p.argv, cwd, env) || id === undefined) {
          throw new PsycheError(
            "forbidden",
            `a command on ${machine.name} needs its card or its own grant; it was not run`,
          );
        }
        expectSha256 = pins.get(id);
        if (expectSha256 === undefined) {
          throw new PsycheError(
            "forbidden",
            `the grant for this command on ${machine.name} has not pinned its program yet; approve it again`,
          );
        }
      }
      const grant = deps.grants.covering(machine.deviceId, ctx.threadId, cwd);
      if (grant === undefined) throw needsMachineFolder(machine, cwd, "read");
      const client = deps.directory.client(machine.deviceId);
      if (client === undefined) {
        throw new PsycheError("unavailable", `${machine.name} is offline`, {
          retryable: true,
          details: { reason: "machine_offline", machine },
        });
      }
      const timeoutMs = p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
      const started = Date.now();
      const r = await client.invoke(
        "exec.host",
        {
          argv: p.argv,
          cwd,
          folder: grant.path,
          folderMode: grant.mode,
          ...(p.env === undefined ? {} : { env: p.env }),
          timeoutMs,
          ...(expectSha256 === undefined ? {} : { expectSha256 }),
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
      if (
        r.ok &&
        pinGrant !== undefined &&
        sha !== undefined &&
        /^sha256:[0-9a-f]{64}$/.test(sha)
      ) {
        pins.set(pinGrant, sha);
      }
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
            ...(sha === undefined ? {} : { executableSha256: sha }),
          },
        })
        .catch(() => undefined);
      if (!r.ok) {
        const e = r.error ?? { code: "internal", message: "the machine failed" };
        const reason = (e.details as { reason?: unknown } | undefined)?.reason;
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
