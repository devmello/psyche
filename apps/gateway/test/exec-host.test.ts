import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentToolRegistration,
  bindingHash,
  paramsHash,
  type ToolRunContext,
} from "@psyche/agent-core";
import {
  createPermissionBroker,
  type PolicyConfig,
  type PsychePermissionBroker,
} from "@psyche/permissions";
import {
  type MissingPermission,
  namespacedGrantKey,
  type ToolCallDescription,
} from "@psyche/protocol";
import type { CliDriver, CliOptions, CliResult } from "@psyche/sandbox";
import { beforeEach, describe, expect, it } from "vitest";
import { execHostTool, type SrtStatus, UNSANDBOXED_WORD } from "../src/compose/exec-host.ts";
import { withFolder } from "../src/compose/folder-access.ts";
import { requestPermissionTool } from "../src/compose/request-permission.ts";

/**
 * `exec_host` (security §5.4) and the missing-permission flow (§3.13) below the loop: the broker
 * decides the call the way the loop builds it, a denial names what is missing, request_permission
 * raises the card, and the retry is decided again. srt is mocked (never run); the process driver
 * records what would start.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-xh-")));
const home = join(root, "home");
const psycheHome = join(home, ".psyche");
const project = join(home, "Projects", "app");
const outside = join(home, "Elsewhere");
for (const d of [project, outside, join(home, ".ssh"), psycheHome])
  mkdirSync(d, { recursive: true });

const DEVICE = { deviceId: "dev_mac" };
let broker: PsychePermissionBroker;
let policy: PolicyConfig;
let srt: SrtStatus;
let started: { file: string; args: readonly string[]; options?: CliOptions; settings?: unknown }[];
let finish: (r: Partial<CliResult>) => void;
let killed: string[];
let connectorAsks: [string, string][];
let connected: boolean;
const tokens = new Map<string, string>();

const setPolicy = (next: PolicyConfig) => {
  policy = next;
  broker.setPolicy(next);
};

beforeEach(() => {
  tokens.clear();
  started = [];
  killed = [];
  connectorAsks = [];
  connected = false;
  srt = { path: "/opt/mock/srt" };
  broker = createPermissionBroker({
    armDelayMs: 0,
    approvers: {
      device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
      isOwnerSender: async () => false,
    },
    folderAccess: {
      env: () => ({ home, psycheHome }),
      persist: async (e) => setPolicy(withFolder(policy, e)),
    },
  });
  setPolicy({ folders: [{ path: project, mode: "rw" }] });
});

/** Records the answer token of every card raised through it. */
const recording = () =>
  new Proxy(broker, {
    get(target, prop) {
      if (prop !== "requestApproval") {
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return async (...args: Parameters<PsychePermissionBroker["requestApproval"]>) => {
        const issued = await target.requestApproval(...args);
        tokens.set(issued.approval.id, issued.answerTokens.desktop ?? "");
        return issued;
      };
    },
  });

const driver: CliDriver = {
  start(file, args, options) {
    const at = args.indexOf("--settings");
    const settings =
      at === -1 ? undefined : JSON.parse(readFileSync(args[at + 1] as string, "utf8"));
    started.push({ file, args, ...(options ? { options } : {}), settings });
    const done = new Promise<CliResult>((resolve) => {
      finish = (r) =>
        resolve({
          exitCode: 0,
          signal: null,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 5,
          ...r,
        });
    });
    return {
      pid: 1,
      done,
      kill: (signal = "SIGKILL") => {
        killed.push(signal);
        finish({ exitCode: null, signal });
      },
    };
  },
  stream: () => {
    throw new Error("not used");
  },
};

const execHost = () =>
  execHostTool({
    broker: recording(),
    vault: { redact: (t) => t.replaceAll("s3cret", "[masked]") },
    folders: (threadId) => [...(broker.policy.folders ?? []), ...broker.sessionFolders(threadId)],
    srt: { resolve: () => srt },
    home: psycheHome,
    userHome: home,
    driver,
  });

const requestPermission = () =>
  requestPermissionTool({
    broker: recording(),
    surfaces: ["desktop"],
    execHostEnabled: () => broker.policy.exec?.execHostEnabled === true,
    enableExecHost: async () =>
      setPolicy({ ...policy, exec: { ...(policy.exec ?? {}), execHostEnabled: true } }),
    allowConnectorAsk: async (connector, group) => {
      connectorAsks.push([connector, group]);
      setPolicy({ ...policy, connectors: { "apple.mail": { [group]: "ask" } } });
      return true;
    },
    connectorConnected: async () => connected,
    sandboxReady: () => "path" in srt,
  });

const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext => ({
  callId: "call_1",
  threadId: "thr_1",
  runId: "run_1",
  taint: false,
  permissionMode: "balanced",
  mode: "attended",
  signal: new AbortController().signal,
  onUpdate: () => undefined,
  ...over,
});

function run(t: AgentToolRegistration, params: unknown, c: ToolRunContext) {
  if (t.run === undefined) throw new Error("tool has no run");
  return t.run(params, c);
}

/** What the loop sends the broker for a call (agent-core `#gate`). */
function decide(t: AgentToolRegistration, params: unknown, taint = false) {
  const desc = t.describeCall?.(params) as ToolCallDescription;
  const hash = paramsHash(params);
  return broker.decide(
    {
      tool: t.spec.name,
      sideEffect: t.spec.sideEffect,
      ...(desc.target === undefined ? {} : { target: desc.target, targetKind: desc.target.kind }),
      params: structuredClone(params) as Record<string, unknown>,
      paramsHash: hash,
      ...(desc.kind === undefined ? {} : { kind: desc.kind }),
      bindingHash: bindingHash(desc.kind as string, {
        tool: t.spec.name,
        paramsHash: hash,
        fields: desc.bindingFields,
      }),
      grantKey: namespacedGrantKey(t.spec.name, desc.grantKey as string),
    },
    { threadId: "thr_1", runId: "run_1", permissionMode: "balanced", taint },
  );
}

/** The loop's card for an `ask`: summary and details from describeCall. */
async function card(t: AgentToolRegistration, params: unknown) {
  const d = await decide(t, params);
  expect(d.decision).toBe("ask");
  const desc = t.describeCall?.(params) as ToolCallDescription;
  const issued = await recording().requestApproval({
    kind: d.approvalKind ?? "exec_host",
    summary: desc.summary ?? "",
    details: { ...desc.details },
    bindingHash: d.bindingHash as string,
    grantKey: d.grantKey as string,
    requestedBy: { runId: "run_1", taskId: null, threadId: "thr_1", toolCallId: "call_1" },
    sideEffect: "destructive",
    surfaces: ["desktop"],
    taint: false,
  });
  return issued.approval;
}

async function pending() {
  for (let i = 0; i < 100; i++) {
    const [a] = await broker.list({ status: "pending" });
    if (a && tokens.has(a.id)) return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval raised");
}

function answer(id: string, extra: Record<string, unknown> = {}) {
  return broker.answer({
    approvalId: id,
    answerToken: tokens.get(id) ?? "",
    decision: "approve",
    scope: "once",
    decidedBy: DEVICE,
    ...extra,
  });
}

const echo = { argv: ["/bin/echo", "hi"], cwd: project };

describe("exec_host: missing permission → request → retry", () => {
  it("is off by default; the owner turns it on from the chat card and the retry asks", async () => {
    const t = execHost();
    const denied = await decide(t, echo);
    expect(denied).toMatchObject({ decision: "deny", rule: "exec_host:disabled" });
    const need = denied.missing as MissingPermission;
    expect(need).toEqual({ need: "capability", capability: "exec_host" });

    const pend = run(requestPermission(), { need, reason: "run the tests" }, ctx());
    const a = await pending();
    expect(a).toMatchObject({
      kind: "permission_request",
      deviceOnly: true,
      requiresAuthentication: true,
      scopesOffered: ["once"],
      details: { need, reason: "run the tests" },
    });
    expect(broker.policy.exec?.execHostEnabled).not.toBe(true);
    await answer(a.id);
    expect((await pend).output).toMatchObject({ granted: true });
    expect(broker.policy.exec?.execHostEnabled).toBe(true);
    expect((await decide(t, echo)).decision).toBe("ask");
  });

  it("a denied Enable card leaves it off, and a tainted turn cannot turn it on", async () => {
    const pend = run(
      requestPermission(),
      { need: { need: "capability", capability: "exec_host" }, reason: "x" },
      ctx(),
    );
    const a = await pending();
    await broker.answer({
      approvalId: a.id,
      answerToken: tokens.get(a.id) ?? "",
      decision: "deny",
      decidedBy: DEVICE,
    });
    expect((await pend).output).toEqual({ granted: false, status: "denied" });
    const tainted = await run(
      requestPermission(),
      { need: { need: "capability", capability: "exec_host" }, reason: "x" },
      ctx({ taint: true }),
    );
    expect(tainted.output).toMatchObject({ granted: false, status: "refused" });
    expect(await broker.list({ status: "pending" })).toEqual([]);
    expect(broker.policy.exec?.execHostEnabled).not.toBe(true);
  });

  it("a cwd outside the grants names the folder; the folder card grants it and the retry asks", async () => {
    setPolicy({ ...policy, exec: { execHostEnabled: true } });
    const t = execHost();
    const params = { argv: ["/bin/echo", "hi"], cwd: outside };
    const denied = await decide(t, params);
    expect(denied).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
    expect(denied.missing).toEqual({ need: "folder", path: outside, access: "read_write" });

    const pend = run(requestPermission(), { need: denied.missing, reason: "build it" }, ctx());
    const a = await pending();
    expect(a.kind).toBe("folder_access");
    await answer(a.id, { folderPath: outside });
    expect((await pend).output).toMatchObject({ granted: true, path: outside });
    expect((await decide(t, params)).decision).toBe("ask");
  });

  it("a connector group set to deny: the owner loosens it to ask and the retry asks", async () => {
    setPolicy({ ...policy, connectors: { "apple.mail": { "mail.send": "deny" } } });
    const send = {
      tool: "node.mail.send",
      sideEffect: "write" as const,
      target: { kind: "recipient" as const, value: "a@b.c" },
      targetKind: "recipient" as const,
      params: { to: "a@b.c" },
      paramsHash: paramsHash({ to: "a@b.c" }),
    };
    const ctxD = {
      threadId: "thr_1",
      runId: "run_1",
      permissionMode: "balanced" as const,
      taint: false,
    };
    const denied = await broker.decide(send, ctxD);
    expect(denied.decision).toBe("deny");
    expect(denied.missing).toMatchObject({ need: "connector_action", connector: "apple.mail" });

    const pend = run(requestPermission(), { need: denied.missing, reason: "send it" }, ctx());
    const a = await pending();
    expect(a.requiresAuthentication).toBe(true);
    await answer(a.id);
    expect((await pend).output).toMatchObject({ granted: true });
    expect(connectorAsks).toEqual([["apple.mail", (denied.missing as { group: string }).group]]);
    expect((await broker.decide(send, ctxD)).decision).toBe("ask");
  });

  it("a connector that is not connected: Check again reports whether it is now", async () => {
    const need = { need: "connector", connector: "google" };
    const pend = run(requestPermission(), { need, reason: "read mail" }, ctx());
    const a = await pending();
    expect(a.requiresAuthentication).toBe(false);
    connected = true;
    await answer(a.id);
    expect((await pend).output).toMatchObject({ granted: true });
  });
});

describe("exec_host: running", () => {
  beforeEach(() => setPolicy({ ...policy, exec: { execHostEnabled: true } }));

  it("shows the exact argv, cwd, env and resolved executable on the card", async () => {
    const a = await card(execHost(), { ...echo, env: { CI: "1" } });
    expect(a.deviceOnly).toBe(true);
    expect(a.details).toMatchObject({
      argv: ["/bin/echo", "hi"],
      cwd: project,
      env: ["CI=1"],
      executable: realpathSync("/bin/echo"),
      executableSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sandbox: "srt",
      unsandboxedWord: UNSANDBOXED_WORD,
    });
  });

  it("runs under srt with the deny profile and masks secrets in the output", async () => {
    const t = execHost();
    const a = await card(t, echo);
    await answer(a.id);
    const out = run(t, echo, ctx({ approvalId: a.id }));
    await new Promise((r) => setTimeout(r, 20));
    finish({ stdout: Buffer.from("token s3cret\n") });
    const res = await out;
    const s = started[0];
    expect(s?.file).toBe("/opt/mock/srt");
    expect(s?.args.slice(2)).toEqual(["--", realpathSync("/bin/echo"), "hi"]);
    expect(s?.options).toMatchObject({ cwd: project, processGroup: true });
    expect(s?.options?.env?.PATH).not.toContain(home);
    const fs = (
      s?.settings as { filesystem: { denyRead: string[]; allowWrite: string[] } } | undefined
    )?.filesystem ?? { denyRead: [], allowWrite: [] };
    for (const p of [
      join(psycheHome, "vault"),
      join(psycheHome, "state"),
      join(psycheHome, "audit"),
      join(home, ".ssh"),
      join(home, "Library", "Keychains"),
      join(home, "Library", "Application Support", "Google", "Chrome"),
    ]) {
      expect(fs.denyRead).toContain(p);
    }
    expect(fs.allowWrite).toContain(project);
    expect(s?.settings).toMatchObject({
      network: { allowedDomains: [], allowLocalBinding: false },
      allowAppleEvents: false,
      enableWeakerNetworkIsolation: false,
    });
    expect(res.output).toMatchObject({
      exitCode: 0,
      stdout: "token [masked]\n",
      sandboxed: true,
      outcome: "ok",
    });
  });

  it("without srt, refuses to run unless the owner typed UNSANDBOXED, then runs directly", async () => {
    srt = { missing: true, reason: "srt is not installed" };
    const t = execHost();
    const a = await card(t, echo);
    expect(a.details).toMatchObject({
      sandbox: "missing",
      sandboxMissingReason: "srt is not installed",
    });
    await answer(a.id);
    await expect(run(t, echo, ctx({ approvalId: a.id }))).rejects.toMatchObject({
      code: "unavailable",
      details: { missing: { need: "sandbox" } },
    });
    expect(started).toEqual([]);

    const b = await card(t, echo);
    await answer(b.id, { unsandboxed: UNSANDBOXED_WORD });
    const out = run(t, echo, ctx({ approvalId: b.id }));
    await new Promise((r) => setTimeout(r, 20));
    finish({});
    expect((await out).output).toMatchObject({ sandboxed: false });
    expect(started[0]?.file).toBe(realpathSync("/bin/echo"));
    expect(started[0]?.args).toEqual(["hi"]);
  });

  it("refuses when the folder was revoked after approval, or the binary changed", async () => {
    const t = execHost();
    const a = await card(t, echo);
    await answer(a.id);
    setPolicy({ ...policy, folders: [] });
    await expect(run(t, echo, ctx({ approvalId: a.id }))).rejects.toMatchObject({
      code: "forbidden",
      details: { missing: { need: "folder" } },
    });
    setPolicy({ ...policy, folders: [{ path: project, mode: "rw" }] });
    // An approval whose recorded hash is another binary's.
    const other = await card(t, { argv: ["/bin/ls"], cwd: project });
    await answer(other.id);
    await expect(run(t, echo, ctx({ approvalId: other.id }))).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    expect(started).toEqual([]);
  });

  it("Esc / Stop kills the process group and the receipt is uncertain", async () => {
    const t = execHost();
    const a = await card(t, echo);
    await answer(a.id);
    const stop = new AbortController();
    const out = run(t, echo, ctx({ approvalId: a.id, signal: stop.signal }));
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    const res = await out;
    expect(killed).toEqual(["SIGKILL"]);
    expect(res.output).toMatchObject({ stopped: true, outcome: "uncertain" });
    expect(res.isError).toBe(true);
  });

  it("a bounded timeout kills it", async () => {
    const t = execHost();
    const a = await card(t, { ...echo, timeoutMs: 1_000 });
    await answer(a.id);
    const res = await run(t, { ...echo, timeoutMs: 1_000 }, ctx({ approvalId: a.id }));
    expect(killed).toEqual(["SIGKILL"]);
    expect(res.output).toMatchObject({ timedOut: true, outcome: "uncertain" });
  });

  it("refuses reserved env names and vault placeholders", () => {
    const t = execHost();
    expect(() => t.describeCall?.({ ...echo, env: { PATH: "/tmp" } })).toThrow(/fixed/);
    expect(() => t.describeCall?.({ ...echo, env: { DYLD_INSERT_LIBRARIES: "x" } })).toThrow();
    expect(() => t.describeCall?.({ ...echo, env: { TOKEN: "{{cred:gh}}" } })).toThrow(
      /placeholder/,
    );
  });
});
