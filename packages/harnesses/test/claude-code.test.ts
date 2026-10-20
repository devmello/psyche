import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAgentLoop } from "@psyche/agent-core";
import type {
  AgentEvent,
  ApprovalRequestInput,
  IssuedApproval,
  ModelEvent,
} from "@psyche/protocol";
import { FakeClock, FakeModelProvider, FakePermissionBroker } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeHarness,
  type ClaudeSession,
  type ClaudeTransport,
  classifyClaudeTool,
  claudeArgv,
  type GateRequest,
  HOOK,
  RELAY,
  SandboxClaudeTransport,
  stubHarness,
} from "../src/index.ts";

const map = { container: "/workspace/repo", host: "/Users/o/src/app" };

describe("Claude Code tool classification", () => {
  it("maps edits, commands, pushes and fetches onto Psyche's cards", () => {
    expect(
      classifyClaudeTool(
        "Edit",
        { file_path: "/workspace/repo/src/a.ts", old_string: "a", new_string: "b" },
        map,
      ),
    ).toMatchObject({
      sideEffect: "write",
      kind: "file_write",
      target: { kind: "path", value: "/Users/o/src/app/src/a.ts" },
      details: { diff: "-a\n+b" },
    });
    expect(classifyClaudeTool("Bash", { command: "npm test" }, map)).toMatchObject({
      sideEffect: "write",
      kind: "exec",
      target: { kind: "command", value: "npm test" },
    });
    expect(classifyClaudeTool("Bash", { command: "git push origin main" }, map)).toMatchObject({
      sideEffect: "write",
      kind: "git_push",
      details: { force: false },
    });
    expect(
      classifyClaudeTool("Bash", { command: "git push --force origin main" }, map),
    ).toMatchObject({
      sideEffect: "destructive",
      kind: "git_push",
      details: { force: true },
    });
    expect(
      classifyClaudeTool("Read", { file_path: "/workspace/repo/README.md" }, map),
    ).toMatchObject({
      sideEffect: "read",
      target: { value: "/Users/o/src/app/README.md" },
    });
    expect(
      classifyClaudeTool("WebFetch", { url: "https://docs.example.com/x" }, map),
    ).toMatchObject({
      kind: "new_origin",
      target: { kind: "origin", value: "https://docs.example.com" },
    });
    expect(classifyClaudeTool("SomethingNew", {}, map).sideEffect).toBe("write");
  });
});

// --- a scripted Claude Code session -------------------------------------------------------

interface Step {
  gate?: { tool: string; input: unknown; id: string; result: string };
  line?: unknown;
}

/** Replays a session: each gated call waits for Psyche's answer, then reports its result. */
function fakeTransport(steps: Step[]) {
  const sent: string[] = [];
  const answers: Record<string, boolean> = {};
  const transport: ClaudeTransport = {
    available: async () => true,
    async start() {
      const gateQueue: GateRequest[] = [];
      const lineQueue: string[] = [];
      let wake: (() => void) | undefined;
      let finished = false;
      const notify = () => wake?.();
      const pump = (async () => {
        for (const s of steps) {
          if (s.line !== undefined) lineQueue.push(JSON.stringify(s.line));
          if (s.gate !== undefined) {
            const g = s.gate;
            const allowed = await new Promise<boolean>((resolve) => {
              gateQueue.push({
                tool: g.tool,
                input: g.input,
                toolUseId: g.id,
                respond: (d) => resolve(d.allow),
              });
              notify();
            });
            answers[g.id] = allowed;
            lineQueue.push(
              JSON.stringify({
                type: "assistant",
                message: {
                  content: [{ type: "tool_use", id: g.id, name: g.tool, input: g.input }],
                },
              }),
              JSON.stringify({
                type: "user",
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: g.id,
                      content: allowed ? g.result : "denied",
                      is_error: !allowed,
                    },
                  ],
                },
              }),
            );
          }
          notify();
        }
        finished = true;
        notify();
      })();
      const drain = <T>(queue: T[]) => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length > 0) {
              yield queue.shift() as T;
              continue;
            }
            if (finished) return;
            await new Promise<void>((r) => {
              wake = r;
            });
          }
        },
      });
      const session: ClaudeSession = {
        containerCwd: "/workspace/repo",
        send: (line) => sent.push(line),
        endInput: () => undefined,
        lines: drain(lineQueue),
        gates: drain(gateQueue),
        exited: pump.then(() => ({ exitCode: 0 })),
        kill: async () => undefined,
      };
      return session;
    },
  };
  return { transport, sent, answers };
}

class RecordingBroker extends FakePermissionBroker {
  readonly issued: IssuedApproval[] = [];
  override async requestApproval(input: ApprovalRequestInput): Promise<IssuedApproval> {
    const issued = await super.requestApproval(input);
    this.issued.push(issued);
    return issued;
  }
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const toolCall = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name, input },
  { type: "usage", usage },
  { type: "finish", reason: "tool_calls" },
];
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];

describe("ClaudeCodeHarness through the agent loop (C10)", () => {
  it("gates each call with Psyche's cards: the edit is approved, the push is denied", async () => {
    const clock = new FakeClock();
    const broker = new RecordingBroker({
      clock,
      policy: { byTool: { "harness.delegate": "allow", "harness__claude-code__Read": "allow" } },
    });
    const { transport, sent, answers } = fakeTransport([
      { line: { type: "system", subtype: "init", session_id: "sess_1" } },
      {
        gate: {
          tool: "Read",
          input: { file_path: "/workspace/repo/src/add.js" },
          id: "t1",
          result: "a - b",
        },
      },
      {
        gate: {
          tool: "Edit",
          input: {
            file_path: "/workspace/repo/src/add.js",
            old_string: "a - b",
            new_string: "a + b",
          },
          id: "t2",
          result: "edited",
        },
      },
      {
        gate: {
          tool: "Bash",
          input: { command: "git push origin main" },
          id: "t3",
          result: "pushed",
        },
      },
      {
        line: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Fixed add(). The push was not allowed.",
          session_id: "sess_1",
        },
      },
    ]);
    const loop = createAgentLoop({
      provider: FakeModelProvider.script([
        toolCall("d1", "harness.delegate", {
          harness: "claude-code",
          cwd: "/Users/o/src/app",
          brief: "Fix add() and push",
        }),
        say("Claude Code fixed add(); the push needs you."),
      ]),
      model: "fake/main",
      broker,
      clock,
    });
    loop.harnesses.register(new ClaudeCodeHarness({ transport, model: "sonnet" }));
    loop.harnesses.register(stubHarness("codex", "Codex"));
    const events: AgentEvent[] = [];
    const run = (async () => {
      for await (const e of loop.startTurn({
        threadId: "thr_1",
        runId: "run_1",
        input: { text: "fix add() in /Users/o/src/app and push" },
        mode: "attended",
        permissionMode: "balanced",
      }))
        events.push(e);
    })();
    const answer = async (kind: string, decision: "approve" | "deny") => {
      for (let i = 0; i < 400 && !broker.issued.some((x) => x.approval.kind === kind); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const issued = broker.issued.find((x) => x.approval.kind === kind);
      if (issued === undefined) throw new Error(`no ${kind} card`);
      clock.advance(500);
      const surface = Object.keys(issued.answerTokens)[0] as string;
      await broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens[surface] as string,
        decision,
        decidedBy: { deviceId: "dev_owner", surface },
      });
      return issued.approval;
    };
    const edit = await answer("file_write", "approve");
    expect(edit).toMatchObject({
      target: { value: "/Users/o/src/app/src/add.js" },
      details: { diff: "-a - b\n+a + b" },
    });
    const push = await answer("git_push", "deny");
    expect(push.scopesOffered).toEqual(["once"]);
    await run;
    expect(answers).toEqual({ t1: true, t2: true, t3: false });
    expect(JSON.parse(sent[0] as string)).toMatchObject({
      type: "user",
      message: { role: "user", content: "Fix add() and push" },
    });
    const delegate = events.find(
      (e) =>
        e.type === "tool_call" &&
        e.toolCallId === "d1" &&
        (e.status === "ok" || e.status === "failed"),
    );
    expect(delegate).toBeDefined();
    const receipts = await broker.listReceipts();
    expect(receipts.map((r) => r.kind)).toContain("file_write");
    expect(receipts.some((r) => r.kind === "git_push")).toBe(false);
  });
});

// --- the sandbox transport ---------------------------------------------------------------

function fakeProcess(script?: (stdin: PassThrough, stdout: PassThrough) => void) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let exit: (v: { exitCode: number | null }) => void = () => undefined;
  const exited = new Promise<{ exitCode: number | null }>((r) => {
    exit = r;
  });
  script?.(stdin, stdout);
  return {
    stdin,
    stdout,
    exited,
    exit: () => {
      stdout.end();
      exit({ exitCode: 0 });
    },
    kill: async () => {
      stdout.end();
      exit({ exitCode: null });
    },
  };
}

describe("SandboxClaudeTransport", () => {
  it("runs the CLI and the relay in a proxy sandbox with the repo mounted and gates over the relay", async () => {
    const opened: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = [];
    const ensured: unknown[] = [];
    const allowlists: unknown[] = [];
    let disposed = false;
    const relayIn: string[] = [];
    const relay = fakeProcess((stdin, stdout) => {
      stdin.on("data", (c) => relayIn.push(String(c)));
      stdout.write(`${JSON.stringify({ ready: true })}\n`);
      stdout.write(
        `${JSON.stringify({ id: 1, tool_name: "Edit", tool_input: { file_path: "x" }, tool_use_id: "t1" })}\n`,
      );
    });
    const cli = fakeProcess();
    const transport = new SandboxClaudeTransport({
      runner: {
        backends: async () => ["docker"],
        ensureSandbox: async (scope, options) => {
          ensured.push({ scope, options });
          return { id: "sbx_1" };
        },
        openStdio: async (_id, options) => {
          opened.push(options);
          return opened.length === 1 ? relay : cli;
        },
      },
      egressAllowlist: (scope, hosts) => allowlists.push({ scope, hosts }),
      folders: () => [{ path: "/Users/o/src", mode: "rw" }],
      credential: async () => ({
        env: { ANTHROPIC_API_KEY: "sk-test-not-real" },
        dispose: () => {
          disposed = true;
        },
      }),
      hasGitDir: () => true,
    });
    const session = await transport.start({
      cwd: "/Users/o/src/app",
      run: { runId: "run_1", threadId: "thr_1", taskId: "task_1", callId: "d1", taint: false },
      args: ["--max-turns", "40"],
      signal: new AbortController().signal,
    });
    expect(ensured[0]).toMatchObject({
      scope: { kind: "project" },
      options: {
        network: "proxy",
        mounts: [
          { source: "/Users/o/src/app", target: "/workspace/repo", readOnly: false },
          { source: "/Users/o/src/app/.git", target: "/workspace/repo/.git", readOnly: true },
        ],
      },
    });
    expect(allowlists[0]).toMatchObject({ hosts: ["api.anthropic.com"] });
    expect(opened[0]?.argv.slice(0, 4)).toEqual(["node", "--input-type=module", "--eval", RELAY]);
    expect(opened[0]?.env).toBeUndefined();
    expect(opened[1]?.argv).toEqual(claudeArgv(["--max-turns", "40"]));
    expect(opened[1]?.argv).toContain("--permission-prompts");
    expect(opened[1]?.cwd).toBe("/workspace/repo");
    expect(Object.keys(opened[1]?.env ?? {}).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_TELEMETRY",
      "HOME",
    ]);
    const gate = (await session.gates[Symbol.asyncIterator]().next()).value as GateRequest;
    expect(gate).toMatchObject({ tool: "Edit", toolUseId: "t1" });
    gate.respond({ allow: false, reason: "no" });
    await new Promise((r) => setImmediate(r));
    expect(relayIn.join("")).toBe(`${JSON.stringify({ id: 1, decision: "deny", reason: "no" })}\n`);
    cli.exit();
    await session.exited;
    expect(disposed).toBe(true);
  });

  it("refuses a folder that is not granted read-write", async () => {
    const transport = new SandboxClaudeTransport({
      runner: {
        backends: async () => ["docker"],
        ensureSandbox: async () => ({ id: "x" }),
        openStdio: async () => fakeProcess(),
      },
      egressAllowlist: () => undefined,
      folders: () => [{ path: "/Users/o/src", mode: "ro" }],
      credential: async () => ({ env: {}, dispose: () => undefined }),
      hasGitDir: () => false,
    });
    const start = (cwd: string) =>
      transport.start({ cwd, args: [], signal: new AbortController().signal });
    await expect(start("/Users/o/src/app")).rejects.toMatchObject({ code: "forbidden" });
    await expect(start("/Users/o/elsewhere")).rejects.toMatchObject({ code: "forbidden" });
  });
});

// --- the real relay and hook scripts, on the host ----------------------------------------

describe("relay and hook scripts", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function hookDecision(socket: string, decide?: (req: { id: number }) => string) {
    const relaySrc = RELAY.replaceAll("/tmp/psyche-gate.sock", socket).replaceAll(
      "/tmp/psyche-gate-hook.mjs",
      join(dir, "hook.mjs"),
    );
    const hookSrc = HOOK.replaceAll("/tmp/psyche-gate.sock", socket);
    const relay =
      decide === undefined
        ? undefined
        : spawn(process.execPath, ["--input-type=module", "--eval", relaySrc, "--", hookSrc], {
            stdio: ["pipe", "pipe", "inherit"],
          });
    if (relay !== undefined) {
      await new Promise<void>((resolve) => {
        let buf = "";
        relay.stdout?.on("data", (c) => {
          buf += String(c);
          for (;;) {
            const nl = buf.indexOf("\n");
            if (nl < 0) break;
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const msg = JSON.parse(line) as { ready?: boolean; id?: number };
            if (msg.ready === true) resolve();
            else if (typeof msg.id === "number")
              relay.stdin?.write(`${decide?.({ id: msg.id })}\n`);
          }
        });
      });
    }
    const hook = spawn(process.execPath, ["--input-type=module", "--eval", hookSrc], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    hook.stdout?.on("data", (c) => {
      out += String(c);
    });
    hook.stdin?.end(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "a" },
        tool_use_id: "t1",
      }),
    );
    await new Promise((r) => hook.on("exit", r));
    relay?.kill();
    return JSON.parse(out) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
  }

  it("allow and deny travel from the host to Claude Code's hook; no relay means deny", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-relay-")));
    const socket = join(dir, "gate.sock");
    const allowed = await hookDecision(socket, ({ id }) =>
      JSON.stringify({ id, decision: "allow" }),
    );
    expect(allowed.hookSpecificOutput.permissionDecision).toBe("allow");
    const denied = await hookDecision(socket, ({ id }) =>
      JSON.stringify({ id, decision: "deny", reason: "Psyche did not allow this: owner said no" }),
    );
    expect(denied.hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: "Psyche did not allow this: owner said no",
    });
    const unreachable = await hookDecision(join(dir, "missing.sock"));
    expect(unreachable.hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: "Psyche is not reachable",
    });
  });
});
