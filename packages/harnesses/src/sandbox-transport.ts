import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { PsycheError, type SandboxMount, type SandboxScope } from "@psyche/protocol";
import type {
  ClaudeSession,
  ClaudeSessionOptions,
  ClaudeTransport,
  GateRequest,
} from "./transport.ts";

/**
 * Claude Code in the sandbox (feature C10; security §5). The CLI runs in a container of its own
 * scope with the owner's repository bind-mounted at `/workspace/repo` (`.git` read-only, as for
 * `code.run`) and network only through the egress proxy, allowlisted to the Anthropic API. The
 * API key comes from the vault for this session only (`credential`, which asks the owner).
 *
 * Gating: a small relay (`RELAY`) runs in the same container over the runner's stdio channel and
 * listens on a Unix socket in the container's `/tmp`. Claude Code's `PreToolUse` hook (`HOOK`,
 * registered with `--settings`) sends each tool call there and waits; the relay forwards it to
 * the host, the adapter asks the broker, and the answer goes back the same way. A hook that
 * cannot reach the relay denies, and `--permission-prompts none` denies anything a hook did not
 * allow: the session fails closed. Both scripts are Node (the image has Node 24) and the relay
 * writes the hook to `/tmp` itself, so the image needs only the `claude` CLI.
 */

export const REPO_IN_SANDBOX = "/workspace/repo";
const SOCKET = "/tmp/psyche-gate.sock";
const HOOK_FILE = "/tmp/psyche-gate-hook.mjs";
/** Hosts the CLI needs with an API key (models, flags); nothing else is allowlisted. */
export const CLAUDE_EGRESS = ["api.anthropic.com"];

/** Runs in Claude Code's `PreToolUse` hook: asks the relay, prints the hook decision. */
export const HOOK = String.raw`
import net from "node:net";
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
};
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw); } catch { return deny("Psyche could not read this call"); }
  const sock = net.connect("${SOCKET}");
  const timer = setTimeout(() => deny("Psyche did not answer"), 15 * 60 * 1000);
  let buf = "";
  sock.on("error", () => deny("Psyche is not reachable"));
  sock.on("data", (c) => {
    buf += c;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    clearTimeout(timer);
    let a;
    try { a = JSON.parse(buf.slice(0, nl)); } catch { return deny("Psyche sent an unreadable answer"); }
    if (a.decision !== "allow") return deny(String(a.reason || "Psyche did not allow this"));
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Allowed by Psyche" } }));
    process.exit(0);
  });
  sock.write(JSON.stringify({ tool_name: input.tool_name, tool_input: input.tool_input, tool_use_id: input.tool_use_id }) + "\n");
});
`;

/** Runs over the runner's stdio channel: socket requests out on stdout, answers in on stdin. */
export const RELAY = String.raw`
import net from "node:net";
import { writeFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
// A previous session in this container left a read-only copy: replace it, never write through it.
try { rmSync("${HOOK_FILE}", { force: true }); } catch {}
writeFileSync("${HOOK_FILE}", process.argv[1] ?? "", { mode: 0o500 });
try { rmSync("${SOCKET}"); } catch {}
const pending = new Map();
let next = 0;
const server = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (c) => {
    buf += c;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    let req;
    try { req = JSON.parse(buf.slice(0, nl)); } catch { sock.end(JSON.stringify({ decision: "deny", reason: "bad request" }) + "\n"); return; }
    const id = ++next;
    pending.set(id, sock);
    process.stdout.write(JSON.stringify({ id, tool_name: req.tool_name, tool_input: req.tool_input, tool_use_id: req.tool_use_id }) + "\n");
  });
  sock.on("error", () => {});
});
server.listen("${SOCKET}", () => process.stdout.write(JSON.stringify({ ready: true }) + "\n"));
createInterface({ input: process.stdin }).on("line", (line) => {
  let a;
  try { a = JSON.parse(line); } catch { return; }
  const sock = pending.get(a.id);
  if (!sock) return;
  pending.delete(a.id);
  sock.end(JSON.stringify({ decision: a.decision, reason: a.reason }) + "\n");
});
process.stdin.on("end", () => process.exit(0));
`;

/** Claude Code's settings for the session: every tool call goes through the hook first. */
export function hookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${HOOK_FILE}` }] }],
    },
  });
}

/** The CLI's argv: headless, stream-json both ways, gated by the hook, nothing else allowed. */
export function claudeArgv(extra: readonly string[]): string[] {
  return [
    "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "default",
    "--permission-prompts",
    "none",
    "--settings",
    hookSettings(),
    ...extra,
  ];
}

/** The runner's stdio process, structurally (`@psyche/sandbox` `SandboxStdio`). */
export interface StdioProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly exited: Promise<{ exitCode: number | null }>;
  kill(signal?: "TERM" | "KILL"): Promise<void>;
}

export interface SandboxClaudeDeps {
  /** The sandbox part's container runner (`ensureSandbox` with mounts, `openStdio`). */
  runner: {
    backends(): Promise<string[]>;
    ensureSandbox(
      scope: SandboxScope,
      options: { network: "proxy"; mounts: SandboxMount[] },
    ): Promise<{ id: string }>;
    openStdio(
      sandboxId: string,
      options: { argv: string[]; cwd?: string; env?: Record<string, string> },
    ): Promise<StdioProcess>;
  };
  /** The egress proxy's allowlist for the session's scope. */
  egressAllowlist(scope: SandboxScope, hosts: readonly string[]): void;
  /** The owner's granted folders (the session's folder must be granted read-write). */
  folders(): readonly { path: string; mode: "ro" | "rw" }[];
  /** The API key for one session, after the owner's approval; `dispose` clears it. */
  credential(
    run: ClaudeSessionOptions["run"],
  ): Promise<{ env: Record<string, string>; dispose(): void }>;
  /** Whether the repository has a `.git` folder (mounted read-only on top). */
  hasGitDir(path: string): boolean;
}

const isUnder = (child: string, root: string) =>
  root === "/" ? child.startsWith("/") : child === root || child.startsWith(`${root}/`);

export class SandboxClaudeTransport implements ClaudeTransport {
  readonly #d: SandboxClaudeDeps;

  constructor(deps: SandboxClaudeDeps) {
    this.#d = deps;
  }

  async available(): Promise<boolean> {
    return (await this.#d.runner.backends().catch(() => [])).length > 0;
  }

  async start(o: ClaudeSessionOptions): Promise<ClaudeSession> {
    const root = o.cwd.replace(/\/+$/, "") || "/";
    const grant = this.#d
      .folders()
      .filter((f) => isUnder(root, f.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (grant === undefined)
      throw new PsycheError("forbidden", `${root} is outside every granted folder`);
    if (grant.mode !== "rw")
      throw new PsycheError("forbidden", `${grant.path} is granted read-only`);
    const owner =
      o.run?.taskId === undefined ? `thread:${o.run?.threadId ?? "none"}` : `task:${o.run.taskId}`;
    const scope: SandboxScope = {
      kind: "project",
      id: `claude-${createHash("sha256").update(`${owner}|${root}`).digest("hex").slice(0, 16)}`,
    };
    const mounts: SandboxMount[] = [
      { source: root, target: REPO_IN_SANDBOX, readOnly: false },
      ...(this.#d.hasGitDir(root)
        ? [{ source: `${root}/.git`, target: `${REPO_IN_SANDBOX}/.git`, readOnly: true }]
        : []),
    ];
    const sandbox = await this.#d.runner.ensureSandbox(scope, { network: "proxy", mounts });
    this.#d.egressAllowlist(scope, CLAUDE_EGRESS);
    const relay = await this.#d.runner.openStdio(sandbox.id, {
      argv: ["node", "--input-type=module", "--eval", RELAY, "--", HOOK],
      cwd: "/workspace",
    });
    const relayLines = createInterface({ input: relay.stdout })[Symbol.asyncIterator]();
    const first = await relayLines.next();
    if (first.done === true || !String(first.value).includes('"ready"')) {
      await relay.kill("KILL");
      throw new PsycheError("unavailable", "the session's permission relay did not start");
    }
    const secret = await this.#d.credential(o.run);
    let claude: StdioProcess;
    try {
      claude = await this.#d.runner.openStdio(sandbox.id, {
        argv: claudeArgv(o.args),
        cwd: REPO_IN_SANDBOX,
        env: {
          ...secret.env,
          HOME: "/workspace/.claude-home",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_TELEMETRY: "1",
        },
      });
    } catch (err) {
      secret.dispose();
      await relay.kill("KILL");
      throw err;
    }
    const exited = claude.exited.finally(async () => {
      secret.dispose();
      relay.stdin.end();
      await relay.kill("TERM").catch(() => undefined);
    });
    const gates: AsyncIterable<GateRequest> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const r = await relayLines.next();
          if (r.done === true) return;
          let msg: { id?: number; tool_name?: string; tool_input?: unknown; tool_use_id?: string };
          try {
            msg = JSON.parse(String(r.value));
          } catch {
            continue;
          }
          if (typeof msg.id !== "number" || typeof msg.tool_name !== "string") continue;
          const id = msg.id;
          yield {
            tool: msg.tool_name,
            input: msg.tool_input,
            ...(typeof msg.tool_use_id === "string" ? { toolUseId: msg.tool_use_id } : {}),
            respond: (d) =>
              relay.stdin.write(
                `${JSON.stringify(d.allow ? { id, decision: "allow" } : { id, decision: "deny", reason: d.reason })}\n`,
              ),
          };
        }
      },
    };
    return {
      containerCwd: REPO_IN_SANDBOX,
      send: (line) => claude.stdin.write(`${line}\n`),
      endInput: () => claude.stdin.end(),
      lines: createInterface({ input: claude.stdout }),
      gates,
      exited,
      kill: async () => {
        await claude.kill("TERM").catch(() => undefined);
      },
    };
  }
}
