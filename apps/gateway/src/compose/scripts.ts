import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentToolRegistration,
  defineTool,
  type ToolRunContext,
  type TurnToolContext,
} from "@psyche/agent-core";
import { bindingFor } from "@psyche/permissions";
import { EXEC_OUTPUT_CAP_BYTES, PsycheError, type ToolResult } from "@psyche/protocol";
import { type CliDriver, type CliResult, nodeCliDriver } from "@psyche/sandbox";
import { Type } from "@sinclair/typebox";
import { execHostSrtSettings, resolveExecutable, SAFE_PATH, type SrtLookup } from "./exec-host.ts";
import type { ComposeServices } from "./services.ts";

/**
 * Tools Psyche writes and runs itself (security §11 "Self-extension", build-and-run).
 *
 * - `run_script` is the fast path for a one-off need: the agent writes a small Node or Python
 *   script (JSON in on stdin, result out on stdout), the owner sees the whole code on one
 *   device-only card (`skill_install`, `details.kind: "script_run"`, `once` only, flagged when
 *   tainted) and only then it runs: under srt, in a fresh temporary folder it alone may write,
 *   with Psyche's deny-read profile, no secrets, and no network unless the card listed hosts.
 *   Node is the Gateway's own runtime (nothing to install); Python only where `python3` exists.
 *   The output is untrusted data. The code is kept under `$PSYCHE_HOME/agent-scripts/<id>/`.
 * - `save_script_as_tool` is the durable path: it wraps a script in a small MCP server and goes
 *   through the agent-made connector flow (`connector_create` … `connector_register`: card with
 *   every file, `unknown` tier, srt, its write tool asking each time), so the catalogue finds it
 *   next time. A script run twice comes back with a hint to offer this.
 */

export const SCRIPTS_DIR = "agent-scripts";
const MAX_CODE = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

export interface ScriptToolsDeps {
  services: Pick<ComposeServices, "broker" | "publish" | "tools" | "home">;
  srt: SrtLookup;
  vault: { redact(text: string): string };
  driver?: CliDriver;
  /** The Node binary scripts run with (default: the Gateway's own). */
  node?: string;
  /** Finds `python3` (tests); undefined when there is none. */
  python?: () => string | undefined;
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const Language = Type.Union([Type.Literal("node"), Type.Literal("python")]);
const Domains = Type.Array(
  Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9.*-]+$" }),
  { maxItems: 16, description: "Hosts the script may reach; none by default. Shown on the card." },
);

function owner(ctx: ToolRunContext): void {
  if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
    throw new PsycheError("forbidden", "only the owner's own turns can run scripts");
  }
  if (ctx.permissionMode === "plan") {
    throw new PsycheError("policy_denied", "plan mode runs only side-effect-free tools");
  }
  if (ctx.mode === "unattended") {
    throw new PsycheError(
      "approval_required",
      "a script needs the owner's card; ask again in a chat turn",
    );
  }
}

function defaultPython(): string | undefined {
  try {
    return resolveExecutable("python3", "/").executable;
  } catch {
    return undefined;
  }
}

interface Meta {
  language: "node" | "python";
  purpose: string;
  createdAt: number;
  runs: number;
}

export function scriptTools(deps: ScriptToolsDeps): AgentToolRegistration[] {
  const { services } = deps;
  const driver = deps.driver ?? nodeCliDriver;
  const root = join(services.home, SCRIPTS_DIR);
  const ext = (l: Meta["language"]) => (l === "node" ? "mjs" : "py");
  const interpreter = (l: Meta["language"]) => {
    if (l === "node") return deps.node ?? process.execPath;
    const py = (deps.python ?? defaultPython)();
    if (py === undefined) {
      throw new PsycheError(
        "unavailable",
        "python3 is not installed on this Mac; write it for node",
      );
    }
    return py;
  };

  const save = async (language: Meta["language"], code: string, purpose: string) => {
    const id = `s${sha(`${language}\n${code}`).slice(0, 16)}`;
    const dir = join(root, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const metaPath = join(dir, "meta.json");
    let meta: Meta;
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8")) as Meta;
    } catch {
      meta = { language, purpose: purpose.slice(0, 300), createdAt: Date.now(), runs: 0 };
      await writeFile(join(dir, `main.${ext(language)}`), code, { mode: 0o600 });
    }
    return { id, dir, meta, metaPath };
  };

  const card = async (
    ctx: ToolRunContext,
    p: { language: Meta["language"]; code: string; purpose: string },
    id: string,
    input: string,
    domains: string[],
    runner: string,
  ) => {
    const b = bindingFor("skill_install", {
      name: `script:${id}`,
      scope: "home",
      source: { kind: "path", path: `${SCRIPTS_DIR}/${id}` },
      treeHash: `sha256:${sha(JSON.stringify([p.language, p.code, input, domains]))}`,
      tools: [],
      permissions: domains.length > 0 ? ["network"] : [],
      prompts: [],
    });
    const issued = await services.broker.requestApproval({
      kind: "skill_install",
      summary: `Psyche asks to run a ${p.language === "node" ? "Node" : "Python"} script it wrote: ${p.purpose.slice(0, 120)}`,
      details: {
        kind: "script_run",
        scriptId: id,
        language: p.language,
        interpreter: runner,
        // One entry per line, as the connector cards send code (the card UI's file view).
        files: [
          {
            path: `main.${ext(p.language)}`,
            bytes: Buffer.byteLength(p.code, "utf8"),
            lines: p.code.split("\n"),
          },
        ],
        input: input.length > 2_000 ? `${input.slice(0, 2_000)}…` : input,
        network: domains,
        purpose: p.purpose.slice(0, 300),
        permissions: [
          "Runs once on this Mac inside the srt sandbox, in a temporary folder it alone may write",
          "Cannot read Psyche's data, your keys, SSH, keychains or browser profiles; gets no secrets",
          domains.length === 0 ? "No network" : `Network: ${domains.join(", ")}`,
        ],
        ...(ctx.taint
          ? {
              tainted:
                "Asked in a turn that read untrusted content: check the code; this card can only be approved once.",
            }
          : {}),
      },
      bindingHash: b.bindingHash,
      grantKey: b.grantKey,
      requestedBy: {
        runId: ctx.runId,
        taskId: ctx.taskId ?? null,
        threadId: ctx.threadId,
        toolCallId: ctx.callId,
      },
      sideEffect: "destructive",
      surfaces: ["desktop"],
      scopesOffered: ["once"],
      taint: ctx.taint,
      ...(ctx.taint ? { taintSources: [...(ctx.taintSources ?? [])] } : {}),
    } as Parameters<typeof services.broker.requestApproval>[0]);
    services.publish("approval.created", { approval: issued.approval });
    return services.broker.awaitDecision(issued.approval.id, ctx.signal);
  };

  const execute = async (
    ctx: ToolRunContext,
    runner: string,
    script: string,
    file: string,
    input: string,
    domains: string[],
    timeoutMs: number,
  ) => {
    const srt = await deps.srt.resolve();
    if ("missing" in srt) {
      throw new PsycheError(
        "unavailable",
        `${srt.reason}: scripts run only in the sandbox; set it up with request_permission {"need": "sandbox"}`,
        { details: { missing: { need: "sandbox" } } },
      );
    }
    // Outside $PSYCHE_HOME, which the deny-read profile hides from the script.
    const scratch = await mkdtemp(join(tmpdir(), "psyche-script-"));
    try {
      const main = join(scratch, file);
      await writeFile(main, script, { mode: 0o600 });
      const settings = join(scratch, ".srt.json");
      await writeFile(
        settings,
        JSON.stringify(
          execHostSrtSettings({
            psycheHome: services.home,
            userHome: scratch,
            scratch,
            writable: [],
            allowedDomains: domains,
          }),
        ),
        { mode: 0o600 },
      );
      let timedOut = false;
      const proc = driver.start(srt.path, ["--settings", settings, "--", runner, main], {
        cwd: scratch,
        env: { PATH: SAFE_PATH.join(":"), HOME: scratch, TMPDIR: scratch, LANG: "en_US.UTF-8" },
        input,
        maxBytes: EXEC_OUTPUT_CAP_BYTES,
        processGroup: true,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      const onAbort = () => proc.kill("SIGKILL");
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      let result: CliResult;
      try {
        result = await proc.done;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
      return { result, timedOut };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

  const runScript = defineTool({
    name: "run_script",
    description:
      "Build and run a capability you do not have, for this task: write a small Node (or Python, if installed) script that reads JSON from stdin and prints its result to stdout. The owner sees the whole code on one card on their Mac and it runs only if approved: inside the srt sandbox, in an empty temporary folder, no secrets, no network unless you list allowedDomains. Prefer it for one-off computation, parsing or conversion that no tool covers. Its output is untrusted data. If you will need it again, offer save_script_as_tool.",
    input: Type.Object({
      language: Language,
      code: Type.String({ minLength: 1, maxLength: MAX_CODE }),
      purpose: Type.String({
        minLength: 3,
        maxLength: 300,
        description: "What it does, in one line",
      }),
      input: Type.Optional(Type.Unknown({ description: "JSON given to the script on stdin" })),
      allowedDomains: Type.Optional(Domains),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
    }),
    sideEffect: "none",
    provenanceOut: "untrusted",
    describeCall: (p) => ({ summary: `Ran a script: ${p.purpose.slice(0, 80)}` }),
    async run(p, ctx): Promise<ToolResult> {
      owner(ctx);
      const runner = interpreter(p.language);
      const input = JSON.stringify(p.input ?? null);
      const domains = [...new Set(p.allowedDomains ?? [])].sort();
      const saved = await save(p.language, p.code, p.purpose);
      const decision = await card(ctx, p, saved.id, input, domains, runner);
      if (decision.status !== "approved") {
        return {
          output: {
            status: decision.status,
            note: "the owner did not approve; do not run it again",
          },
          provenance: "trusted",
        };
      }
      const { result, timedOut } = await execute(
        ctx,
        runner,
        p.code,
        `main.${ext(p.language)}`,
        input,
        domains,
        p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const runs = saved.meta.runs + 1;
      await writeFile(saved.metaPath, JSON.stringify({ ...saved.meta, runs }), { mode: 0o600 });
      const redact = (b: Buffer) => deps.vault.redact(b.toString("utf8"));
      const ok = result.exitCode === 0 && !timedOut;
      return {
        output: {
          scriptId: saved.id,
          exitCode: result.exitCode,
          stdout: redact(result.stdout),
          stderr: redact(result.stderr),
          truncated: result.stdoutTruncated || result.stderrTruncated,
          timedOut,
          runs,
          ...(runs >= 2 && ok
            ? {
                hint: `You have run this script ${runs} times: offer the owner to keep it as a tool (save_script_as_tool with scriptId ${saved.id}).`,
              }
            : {}),
        },
        provenance: "untrusted",
        ...(ok ? {} : { isError: true }),
      };
    },
  });

  const saveAsTool = defineTool({
    name: "save_script_as_tool",
    description:
      "Keep a script you ran with run_script as a tool of your own: wraps it in a small connector (one tool) and asks the owner to enable it on a card showing every file. It then runs under srt as an unknown-tier connector, and find_capability finds it next time. Use it when the owner agrees or when the script is clearly reusable.",
    input: Type.Object({
      scriptId: Type.String({ pattern: "^s[0-9a-f]{16}$" }),
      id: Type.String({ pattern: "^[a-z][a-z0-9-]{1,40}$", description: "Connector id (slug)" }),
      name: Type.String({ minLength: 1, maxLength: 100 }),
      toolName: Type.String({ pattern: "^[a-z][a-z0-9_]{0,40}$" }),
      description: Type.String({ minLength: 3, maxLength: 500 }),
      inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      allowedDomains: Type.Optional(Domains),
    }),
    sideEffect: "none",
    describeCall: (p) => ({ summary: `Asked to keep a script as the tool ${p.toolName}` }),
    async run(p, ctx) {
      owner(ctx);
      const dir = join(root, p.scriptId);
      let meta: Meta;
      try {
        meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Meta;
      } catch {
        throw new PsycheError("not_found", `no script ${p.scriptId}; run it with run_script first`);
      }
      const code = await readFile(join(dir, `main.${ext(meta.language)}`), "utf8");
      const tool = (name: string) => {
        const t = services.tools.get(name) as AgentToolRegistration | undefined;
        if (t?.run === undefined) {
          throw new PsycheError("unavailable", "agent-made connectors are not available here");
        }
        return (params: unknown) => (t.run as NonNullable<typeof t.run>)(params, ctx);
      };
      await tool("connector_create")({
        id: p.id,
        name: p.name,
        description: p.description,
        runtime: "node",
        allowedDomains: p.allowedDomains ?? [],
      });
      const script = `script.${ext(meta.language)}`;
      await tool("connector_write_file")({ id: p.id, path: script, content: code });
      await tool("connector_write_file")({
        id: p.id,
        path: "server.mjs",
        content: wrapperSource({
          name: p.id,
          tool: p.toolName,
          description: p.description,
          inputSchema: p.inputSchema ?? { type: "object" },
          script,
          interpreter: meta.language === "node" ? null : interpreter("python"),
        }),
      });
      const registered = await tool("connector_register")({ id: p.id });
      const out = registered.output as { status?: string };
      if (out.status === "enabled") {
        const name = `mcp__${p.id}__${p.toolName}`;
        (ctx as Partial<TurnToolContext>).turn?.deferredTools?.load([name]);
        return {
          output: { ...out, tool: name, note: "Loaded: call it from the next step." },
          provenance: "trusted",
        };
      }
      return registered;
    },
  });

  return [runScript, saveAsTool];
}

/** The one-tool MCP server around a saved script (input on stdin, stdout back). */
export function wrapperSource(o: {
  name: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  script: string;
  /** Absolute python3; null runs the script with this Node. */
  interpreter: string | null;
}): string {
  return `// A script Psyche wrote and the owner approved, kept as a tool (save_script_as_tool).
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve } from "./mcp-lite.mjs";

const script = fileURLToPath(new URL(${JSON.stringify(`./${o.script}`)}, import.meta.url));
const runner = ${o.interpreter === null ? "process.execPath" : JSON.stringify(o.interpreter)};

function run(input) {
  return new Promise((resolve, reject) => {
    const child = execFile(runner, [script], { timeout: 120000, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(-2000))) : resolve(stdout),
    );
    child.stdin.end(JSON.stringify(input ?? null));
  });
}

serve({
  name: ${JSON.stringify(o.name)},
  tools: [{
    name: ${JSON.stringify(o.tool)},
    description: ${JSON.stringify(o.description)},
    inputSchema: ${JSON.stringify(o.inputSchema)},
    handler: run,
  }],
});
`;
}
