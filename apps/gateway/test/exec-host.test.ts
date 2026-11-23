import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  type FolderGrantEntry,
  type PolicyConfig,
  type PsychePermissionBroker,
  READ_ONLY_RULE,
} from "@psyche/permissions";
import {
  type MissingPermission,
  namespacedGrantKey,
  type ToolCallDescription,
} from "@psyche/protocol";
import type { CliDriver, CliOptions, CliResult } from "@psyche/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  execHostSrtSettings,
  execHostTool,
  isGit,
  READ_ONLY_TIMEOUT_MS,
  type SrtStatus,
  UNSANDBOXED_WORD,
} from "../src/compose/exec-host.ts";
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

/**
 * Waits for the run just started to reach the driver (a fixed sleep raced on a loaded CI runner,
 * 2026-11-03): each call waits for one more `start` than the last call saw.
 */
let startsSeen = 0;
async function nextStart(): Promise<void> {
  const want = startsSeen + 1;
  await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(want), { timeout: 5_000 });
  startsSeen = started.length;
}

beforeEach(() => {
  tokens.clear();
  started = [];
  startsSeen = 0;
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
    srt: { resolve: async () => srt },
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

const SEVERITY = { none: 0, read: 1, write: 2, destructive: 3, financial: 4 } as const;

/** What the loop sends the broker for a call (agent-core `#gate`). */
function decide(
  t: AgentToolRegistration,
  params: unknown,
  taint = false,
  permissionMode: ToolRunContext["permissionMode"] = "balanced",
) {
  const desc = t.describeCall?.(params) as ToolCallDescription;
  const hash = paramsHash(params);
  const declared = desc.sideEffect ?? t.spec.sideEffect;
  return broker.decide(
    {
      tool: t.spec.name,
      // `stricter(spec, description)`, as the loop does.
      sideEffect: SEVERITY[declared] > SEVERITY[t.spec.sideEffect] ? declared : t.spec.sideEffect,
      ...(desc.meta === undefined ? {} : { meta: desc.meta }),
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
    { threadId: "thr_1", runId: "run_1", permissionMode, taint },
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

/** An audit log that keeps what it is given (the quiet path needs one). */
const auditTrail: { kind: string; data: Record<string, unknown> }[] = [];
const recordingAudit = {
  append: async (e: unknown) => {
    auditTrail.push(e as never);
    return e as never;
  },
};

const echo = { argv: ["/bin/echo", "hi"], cwd: project };

// These run POSIX binaries such as /bin/echo under (mocked) srt. A Windows Gateway offers
// exec_host too, with Windows rules (no srt, every command carded, UNSANDBOXED to run): those
// are tested with Windows programs in "exec_host on Windows" below.
const posixHost = process.platform !== "win32";

describe.skipIf(!posixHost)("exec_host: missing permission → request → retry", () => {
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
      // Presence is for payments only: turning exec_host on is a tap.
      requiresAuthentication: false,
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
    expect(a.requiresAuthentication).toBe(false);
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

describe.skipIf(!posixHost)("exec_host: running", () => {
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
    await nextStart();
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
    await nextStart();
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
    await nextStart();
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

/** The tool's description of a call (empty when it has none). */
function described(t: AgentToolRegistration, params: unknown): ToolCallDescription {
  return t.describeCall?.(params) ?? {};
}

describe.skipIf(!posixHost)(
  "exec_host: read-only commands run without a card (security §5.4)",
  () => {
    const audited: { kind: string; data: Record<string, unknown> }[] = [];
    /** The tool, once its first srt lookup has answered (until then nothing runs quietly). */
    type Folders = (threadId: string) => readonly FolderGrantEntry[];
    const quietHost = async (folders?: Folders) => {
      const t = makeQuiet(folders);
      await new Promise((r) => setTimeout(r, 5));
      return t;
    };
    const makeQuiet = (folders?: Folders) =>
      execHostTool({
        broker: recording(),
        vault: { redact: (t) => t },
        folders:
          folders ??
          ((threadId) => [...(broker.policy.folders ?? []), ...broker.sessionFolders(threadId)]),
        // As the Gateway wires it: one live look per root at a time, through the broker.
        lookRoot: (path) => broker.lookRootNow(path),
        srt: { resolve: async () => srt },
        home: psycheHome,
        userHome: home,
        driver,
        audit: {
          append: async (e) => {
            audited.push(e as never);
            return e as never;
          },
        },
      });
    const on = () => setPolicy({ ...policy, exec: { execHostEnabled: true } });

    /** Decide like the loop, then run with the authority the loop hands the tool. */
    async function quietRun(t: AgentToolRegistration, params: unknown) {
      const d = await decide(t, params);
      expect(d).toMatchObject({ decision: "allow", rule: READ_ONLY_RULE, sideEffect: "read" });
      const out = run(
        t,
        params,
        ctx({
          authority: {
            rule: d.rule,
            bindingHash: d.bindingHash as string,
            ...(d.grantKey === undefined ? {} : { grantKey: d.grantKey }),
          },
        }),
      );
      await nextStart();
      finish({ stdout: Buffer.from("ok\n") });
      return out;
    }

    it("date runs quietly under srt with nothing writable and no network, and is audited", async () => {
      on();
      audited.length = 0;
      const t = await quietHost();
      const params = { argv: ["date"], cwd: project };
      expect(described(t, params).details).toMatchObject({
        readOnly: true,
      });
      const res = await quietRun(t, params);
      const s = started[0];
      expect(s?.file).toBe("/opt/mock/srt");
      const exe = s?.args[s.args.indexOf("--") + 1] as string;
      // Apple's binary from the SIP folders, never a PATH or Homebrew lookup.
      expect(exe).toMatch(/^\/(usr\/)?s?bin\/date$/);
      const settings = s?.settings as {
        filesystem: { allowWrite: string[] };
        network: {
          allowedDomains: string[];
          allowUnixSockets: string[];
          allowLocalBinding: boolean;
        };
      };
      // The project is granted read-write, but a read-only run may write only its scratch dir.
      expect(settings.filesystem.allowWrite).toHaveLength(1);
      expect(settings.filesystem.allowWrite).not.toContain(project);
      expect(settings.network).toEqual({
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [],
        allowLocalBinding: false,
      });
      expect(res.output).toMatchObject({ exitCode: 0, sandboxed: true, outcome: "ok" });
      // Only Apple's programs on PATH (no Homebrew helper a program might call).
      expect(s?.options?.env?.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      // Recorded before it started, completed when it ended, with the same run key.
      expect(audited.map((e) => e.kind)).toEqual([
        "exec_host.read_only_run",
        "exec_host.read_only_run.done",
      ]);
      expect(audited[0]?.data).toMatchObject({ argv: ["date"], cwd: project, executable: exe });
      expect(audited[1]?.data).toMatchObject({
        runKey: audited[0]?.data.runKey,
        exitCode: 0,
        outcome: "ok",
      });
    });

    it("a run the audit log cannot record does not start", async () => {
      on();
      const t = execHostTool({
        broker: recording(),
        vault: { redact: (x) => x },
        folders: (threadId) => [
          ...(broker.policy.folders ?? []),
          ...broker.sessionFolders(threadId),
        ],
        srt: { resolve: async () => srt },
        home: psycheHome,
        userHome: home,
        driver,
        audit: {
          append: async () => {
            throw new Error("disk full");
          },
        },
      });
      await new Promise((r) => setTimeout(r, 5));
      const params = { argv: ["date"], cwd: project };
      const d = await decide(t, params);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(started).toEqual([]);
    });

    it("taint forces a card, labelled read, and the run still writes nothing", async () => {
      on();
      const t = await quietHost();
      const d = await decide(t, { argv: ["date"], cwd: project }, true);
      expect(d).toMatchObject({ decision: "ask", sideEffect: "read", scopesOffered: ["once"] });
    });

    it("manual mode asks; the owner's switch off asks", async () => {
      on();
      const t = await quietHost();
      expect((await decide(t, { argv: ["date"], cwd: project }, false, "manual")).decision).toBe(
        "ask",
      );
      setPolicy({ ...policy, exec: { execHostEnabled: true, readOnlyWithoutAsking: false } });
      expect((await decide(t, { argv: ["date"], cwd: project })).decision).toBe("ask");
    });

    it("without srt nothing runs quietly: it asks, as a read, with UNSANDBOXED on the card", async () => {
      on();
      srt = { missing: true, reason: "srt is not installed" };
      const t = await quietHost();
      const desc = t.describeCall?.({ argv: ["date"], cwd: project }) as ToolCallDescription;
      expect(desc.meta).toMatchObject({
        hostCommand: "read_only",
        hostSandbox: "missing",
      });
      expect(desc.details).toMatchObject({ sandbox: "missing", unsandboxedWord: UNSANDBOXED_WORD });
      expect(await decide(t, { argv: ["date"], cwd: project })).toMatchObject({
        decision: "ask",
        rule: "exec_host:no_sandbox",
        sideEffect: "read",
      });
    });

    it("a symlink out of the folder takes cat out of the class, also when planted after the decision", async () => {
      on();
      writeFileSync(join(outside, "secret.txt"), "s3cret");
      writeFileSync(join(project, "notes.txt"), "hi");
      const link = join(project, "link.txt");
      if (!existsSync(link)) symlinkSync(join(outside, "secret.txt"), link);
      const t = await quietHost();
      expect((await decide(t, { argv: ["cat", "link.txt"], cwd: project })).sideEffect).toBe(
        "destructive",
      );
      // Decided while the operand was a plain file; swapped for a symlink before the run.
      const late = join(project, "late.txt");
      writeFileSync(late, "x");
      const params = { argv: ["cat", "late.txt"], cwd: project };
      const d = await decide(t, params);
      expect(d.rule).toBe(READ_ONLY_RULE);
      spawnSync("/bin/rm", [late]);
      symlinkSync(join(outside, "secret.txt"), late);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(started).toEqual([]);
    });

    it("a granted root swapped for a link into a system folder after the policy was set covers nothing", async () => {
      on();
      // The broker memoised the answer for this root when the policy was set (a real folder).
      const swapped = join(home, "Projects", "swapped");
      mkdirSync(swapped, { recursive: true });
      setPolicy({ ...policy, folders: [...(policy.folders ?? []), { path: swapped, mode: "rw" }] });
      expect(broker.grantedFolders().map((f) => f.path)).toContain(swapped);
      // Swapped for a link to /usr (a stand-in for /opt/homebrew); only the link is touched.
      spawnSync("/bin/rmdir", [swapped]);
      symlinkSync("/usr", swapped);
      // The broker may still list it for up to FOLDER_FRESH_MS (it never looks up a root
      // synchronously); the run looks it up live and refuses.
      const t = await quietHost();
      const params = { argv: ["date"], cwd: swapped };
      const d = await decide(t, params);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(started).toEqual([]);
    });

    it("a granted root swapped for a link into Psyche's own data covers nothing either", async () => {
      on();
      const swapped = join(home, "Projects", "swapped-own");
      mkdirSync(swapped, { recursive: true });
      setPolicy({ ...policy, folders: [...(policy.folders ?? []), { path: swapped, mode: "rw" }] });
      // A link to $PSYCHE_HOME: not a system folder, but a grant on it would be refused.
      spawnSync("/bin/rmdir", [swapped]);
      symlinkSync(psycheHome, swapped);
      // The broker may still list it for up to FOLDER_FRESH_MS (it never looks up a root
      // synchronously); the run looks it up live and refuses.
      const t = await quietHost();
      const params = { argv: ["date"], cwd: swapped };
      const d = await decide(t, params);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(started).toEqual([]);
    });

    it.each([
      ["~/Library", ["Library"]],
      ["~/.ssh", [".ssh"]],
      ["~/.local/bin", [".local", "bin"]],
    ])("a granted root swapped for a link to %s covers nothing", async (_label, parts) => {
      on();
      const target = join(home, ...parts);
      mkdirSync(target, { recursive: true });
      const swapped = join(home, "Projects", `swapped-${parts.join("-")}`);
      mkdirSync(swapped, { recursive: true });
      setPolicy({ ...policy, folders: [...(policy.folders ?? []), { path: swapped, mode: "rw" }] });
      spawnSync("/bin/rmdir", [swapped]);
      symlinkSync(target, swapped);
      const t = await quietHost();
      const params = { argv: ["date"], cwd: swapped };
      const d = await decide(t, params);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(started).toEqual([]);
    });

    it("a granted root swapped for a link to a shareable sibling folder covers nothing", async () => {
      on();
      const sibling = join(home, "Documents");
      mkdirSync(sibling, { recursive: true });
      const swapped = join(home, "Projects", "swapped-docs");
      mkdirSync(swapped, { recursive: true });
      setPolicy({ ...policy, folders: [...(policy.folders ?? []), { path: swapped, mode: "rw" }] });
      spawnSync("/bin/rmdir", [swapped]);
      symlinkSync(sibling, swapped);
      // The broker may still list it for up to FOLDER_FRESH_MS (it never looks up a root
      // synchronously); the run looks it up live and refuses.
      const t = await quietHost();
      const params = { argv: ["date"], cwd: swapped };
      const d = await decide(t, params);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(started).toEqual([]);
    });

    // PR #1395 review r1, finding 1: the root's PARENT swapped for a link. Its real path and the
    // real parent plus its name agree, so only the real path recorded at grant time (or, for
    // home, ~/Library and ~/.ssh, `refuseFolder` on where it leads) can tell.
    const live: Folders = (threadId) => [
      ...broker.grantedFolders(),
      ...broker.liveSessionFolders(threadId),
    ];
    it.each([
      // [where the parent now leads, granted name, how the grant knows its real path]
      ["~", "Library", "recorded in Settings"],
      ["~", ".ssh", "recorded in Settings"],
      ["~/Documents", "notes", "recorded in Settings"],
      ["~", "Library", "first seen by the broker"],
      ["~", ".ssh", "first seen by the broker"],
      ["~/Documents", "notes", "first seen by the broker"],
      ["~", "Library", "not recorded at all"],
      ["~", ".ssh", "not recorded at all"],
      ["~/Documents", "notes", "not recorded at all"],
    ])(
      "a granted root whose parent is swapped for a link to %s (name %s, %s) covers nothing",
      async (to, name, how) => {
        on();
        const target = to === "~" ? home : join(home, "Documents");
        mkdirSync(join(target, name), { recursive: true });
        const parent = join(home, "Parents", `${how.split(" ")[0]}-${name}-${to.length}`);
        const granted = join(parent, name);
        mkdirSync(granted, { recursive: true });
        const entry =
          how === "recorded in Settings"
            ? { path: granted, mode: "rw" as const, real: granted }
            : { path: granted, mode: "rw" as const };
        setPolicy({ ...policy, folders: [...(policy.folders ?? []), entry] });
        if (how === "first seen by the broker") {
          await broker.foldersSettled();
          expect(broker.recordedReal(granted)).toBe(granted);
        }
        rmSync(parent, { recursive: true });
        symlinkSync(target, parent);
        const t = await quietHost(how === "first seen by the broker" ? live : undefined);
        const params = { argv: ["date"], cwd: granted };
        const d = await decide(t, params);
        await expect(
          run(
            t,
            params,
            ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
          ),
        ).rejects.toMatchObject({ code: "forbidden" });
        expect(started).toEqual([]);
      },
    );

    it("a grant typed through a linked parent that has not moved still runs", async () => {
      on();
      const realCloud = join(home, "real-cloud");
      mkdirSync(join(realCloud, "notes"), { recursive: true });
      const cloud = join(home, "cloud");
      symlinkSync(realCloud, cloud);
      const granted = join(cloud, "notes");
      // As Settings stores it: the typed path, with the real path it had when it was added.
      setPolicy({
        ...policy,
        folders: [
          ...(policy.folders ?? []),
          { path: granted, mode: "rw", real: join(realCloud, "notes") },
        ],
      });
      const t = await quietHost();
      const res = await quietRun(t, { argv: ["date"], cwd: granted });
      expect(res.output).toMatchObject({ exitCode: 0, outcome: "ok" });
    });

    it("env, allowedDomains or an absolute argv[0] keep the old card", async () => {
      on();
      const t = await quietHost();
      for (const params of [
        { argv: ["ls"], cwd: project, env: { COLUMNS: "80" } },
        { argv: ["ls"], cwd: project, allowedDomains: ["example.com"] },
        { argv: ["/bin/ls"], cwd: project },
      ]) {
        expect(described(t, params).meta?.hostCommand).toBeUndefined();
        expect((await decide(t, params)).sideEffect).toBe("destructive");
      }
    });
  },
);

/** Every file under `dir` with its size and mtime: what a run must leave exactly as it was. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st === undefined) continue;
      out.push(`${p}:${st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

describe.skipIf(!posixHost)(
  "red team: no read-only command writes a file (real binaries, srt stripped)",
  () => {
    const repo = join(home, "Projects", "repo");
    // The real program, run the way the tool would start it inside srt (the srt prefix dropped,
    // so this checks the argv rules alone, without the sandbox's help).
    const real: CliDriver = {
      start(file, args, options) {
        const at = args.indexOf("--");
        const [exe, ...rest] = at === -1 ? [file, ...args] : args.slice(at + 1);
        const r = spawnSync(exe as string, rest, {
          cwd: options?.cwd,
          env: options?.env,
          timeout: 10_000,
        });
        started.push({ file: exe as string, args: rest });
        return {
          pid: 1,
          done: Promise.resolve({
            exitCode: r.status,
            signal: null,
            stdout: r.stdout ?? Buffer.from(""),
            stderr: r.stderr ?? Buffer.from(""),
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          }),
          kill: () => undefined,
        };
      },
      stream: () => {
        throw new Error("not used");
      },
    };

    it("each command in the class leaves the folder byte for byte", async () => {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "README.md"), "# repo\nline two\n");
      const git = (...a: string[]) =>
        spawnSync("/usr/bin/git", a, {
          cwd: repo,
          env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
        });
      if (git("init", "-q").status === 0) {
        git("add", ".");
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
        // Leave a working-tree change so status and diff have something to read.
        writeFileSync(join(repo, "README.md"), "# repo\nline two changed\n");
      }
      setPolicy({ folders: [{ path: repo, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = execHostTool({
        broker: recording(),
        vault: { redact: (s) => s },
        folders: () => broker.policy.folders ?? [],
        srt: { resolve: async () => srt },
        home: psycheHome,
        userHome: home,
        driver: real,
        audit: recordingAudit,
      });
      await new Promise((r) => setTimeout(r, 5));
      const argvs = [
        ["date"],
        ["pwd"],
        ["whoami"],
        ["uname", "-a"],
        ["ls", "-la"],
        ["cat", "README.md"],
        ["head", "-n", "1", "README.md"],
        ["tail", "-n", "1", "README.md"],
        ["wc", "-l", "README.md"],
        ["file", "README.md"],
        ["stat", "README.md"],
        ["which", "ls"],
        ["ls", "-R"],
      ];
      const before = snapshot(repo);
      let ran = 0;
      for (const argv of argvs) {
        const params = { argv, cwd: repo };
        const desc = t.describeCall?.(params) as ToolCallDescription;
        if (desc.meta === undefined) continue; // not on this machine's system folders
        const d = await decide(t, params);
        expect(d.rule, argv.join(" ")).toBe(READ_ONLY_RULE);
        await run(
          t,
          params,
          ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
        );
        ran++;
        expect(snapshot(repo), argv.join(" ")).toEqual(before);
      }
      expect(ran).toBeGreaterThanOrEqual(10);
    });
  },
);

describe.skipIf(!posixHost)(
  "red team: what never runs quietly (marker-file payloads, security review of #1150)",
  () => {
    const repo = join(home, "Projects", "trap");
    const marker = (name: string) => join(outside, `MARKER-${name}`);
    const quiet = () =>
      execHostTool({
        broker: recording(),
        vault: { redact: (x) => x },
        folders: () => broker.policy.folders ?? [],
        srt: { resolve: async () => srt },
        home: psycheHome,
        userHome: home,
        driver,
        audit: recordingAudit,
      });
    const ready = async () => {
      const t = quiet();
      await new Promise((r) => setTimeout(r, 5));
      return t;
    };
    const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };

    beforeEach(() => {
      setPolicy({ folders: [{ path: repo, mode: "rw" }], exec: { execHostEnabled: true } });
    });

    // The real program, started the way the tool starts it inside srt with the srt prefix dropped
    // (the argv, env and hardening alone, without the sandbox's help).
    const realDriver: CliDriver = {
      start(file, args, options) {
        const at = args.indexOf("--");
        const [exe, ...rest] = at === -1 ? [file, ...args] : args.slice(at + 1);
        const r = spawnSync(exe as string, rest, {
          cwd: options?.cwd,
          env: options?.env,
          timeout: 20_000,
        });
        started.push({ file: exe as string, args: rest, ...(options ? { options } : {}) });
        return {
          pid: 1,
          done: Promise.resolve({
            exitCode: r.status,
            signal: null,
            stdout: r.stdout ?? Buffer.from(""),
            stderr: r.stderr ?? Buffer.from(""),
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          }),
          kill: () => undefined,
        };
      },
      stream: () => {
        throw new Error("not used");
      },
    };
    const readyReal = async () => {
      const t = execHostTool({
        broker: recording(),
        vault: { redact: (x) => x },
        folders: () => broker.policy.folders ?? [],
        srt: { resolve: async () => srt },
        home: psycheHome,
        userHome: home,
        driver: realDriver,
        audit: recordingAudit,
      });
      await new Promise((r) => setTimeout(r, 5));
      return t;
    };
    const gitIn = (dir: string, ...a: string[]) =>
      spawnSync("/usr/bin/git", a, { cwd: dir, env, encoding: "utf8" });
    /** A repository with one commit and a working-tree change; null when git is missing here. */
    const makeRepo = (name: string): string | null => {
      const dir = join(home, "Projects", name);
      mkdirSync(dir, { recursive: true });
      if (gitIn(dir, "init", "-q").status !== 0) return null;
      writeFileSync(join(dir, "a.txt"), "x\n");
      gitIn(dir, "add", "a.txt");
      gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
      writeFileSync(join(dir, "a.txt"), "changed\n");
      return dir;
    };

    it("read-only git runs without a card and runs no program the repo's config names", async () => {
      const dir = makeRepo("gitro-payloads");
      if (dir === null) return; // no git on this machine
      // What a hostile checkout carries: an fsmonitor hook, a clean filter, a textconv driver,
      // an external diff, a gpg program, a pager, an ssh command: each touches a marker.
      writeFileSync(join(dir, ".gitattributes"), "* filter=pwn diff=pwn\n");
      gitIn(dir, "config", "core.fsmonitor", `touch ${marker("fsmonitor")} #`);
      gitIn(dir, "config", "core.pager", `touch ${marker("pager")} #`);
      gitIn(dir, "config", "core.sshCommand", `touch ${marker("ssh")} #`);
      gitIn(dir, "config", "diff.external", `touch ${marker("external")} #`);
      gitIn(dir, "config", "filter.pwn.clean", `touch ${marker("filter")}; cat`);
      gitIn(dir, "config", "diff.pwn.textconv", `touch ${marker("textconv")}; cat`);
      gitIn(dir, "config", "gpg.program", `/bin/sh -c 'touch ${marker("gpg")}'`);
      gitIn(dir, "config", "log.showSignature", "true");
      gitIn(dir, "config", "pager.status", `touch ${marker("pagerstatus")} #`);
      const all = ["fsmonitor", "pager", "ssh", "external", "filter", "textconv", "gpg"];
      const clean = () => {
        for (const m of [...all, "pagerstatus"]) spawnSync("/bin/rm", ["-f", marker(m)]);
      };
      // The payloads are real: plain git runs them.
      gitIn(dir, "status");
      gitIn(dir, "diff");
      expect(existsSync(marker("fsmonitor"))).toBe(true);
      expect(existsSync(marker("filter"))).toBe(true);
      clean();

      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await readyReal();
      const runs = [
        ["git", "status"],
        ["git", "status", "--short", "--branch"],
        ["git", "log", "--oneline", "-5"],
        ["git", "log", "--format=%h %s", "-n", "3"],
        ["git", "diff"],
        ["git", "diff", "--stat"],
        ["git", "show", "HEAD", "--stat"],
        ["git", "branch"],
        ["git", "rev-parse", "HEAD"],
        ["git", "ls-files"],
        ["git", "remote", "-v"],
      ];
      auditTrail.length = 0;
      for (const argv of runs) {
        const params = { argv, cwd: dir };
        expect(described(t, params).meta, argv.join(" ")).toMatchObject({
          hostCommand: "read_only",
        });
        const d = await decide(t, params);
        expect(d, argv.join(" ")).toMatchObject({ decision: "allow", rule: READ_ONLY_RULE });
        const res = await run(
          t,
          params,
          ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
        );
        expect(
          res.output,
          `${argv.join(" ")}: ${(res.output as { stderr: string }).stderr}`,
        ).toMatchObject({ exitCode: 0, outcome: "ok" });
        for (const m of [...all, "pagerstatus"]) {
          expect(existsSync(marker(m)), `${argv.join(" ")} ran the ${m} payload`).toBe(false);
        }
      }
      // blame has no --no-textconv: with a textconv driver defined git refuses to run it (the
      // override is empty) instead of running the driver. Either way no payload runs.
      const blame = { argv: ["git", "blame", "a.txt"], cwd: dir };
      const bd = await decide(t, blame);
      await run(
        t,
        blame,
        ctx({ authority: { rule: bd.rule, bindingHash: bd.bindingHash as string } }),
      );
      for (const m of [...all, "pagerstatus"])
        expect(existsSync(marker(m)), `blame ${m}`).toBe(false);
      const log = (await run(
        t,
        { argv: ["git", "log", "--oneline", "-5"], cwd: dir },
        ctx({
          authority: {
            rule: READ_ONLY_RULE,
            bindingHash: (
              await decide(t, { argv: ["git", "log", "--oneline", "-5"], cwd: dir })
            ).bindingHash as string,
          },
        }),
      )) as { output: { stdout: string } };
      expect(log.output.stdout).toContain("init");
      // Every run is audited before and after, with the reason.
      const begun = auditTrail.filter((e) => e.kind === "exec_host.read_only_run");
      expect(begun.length).toBeGreaterThanOrEqual(runs.length);
      for (const e of auditTrail) expect(e.data.reason).toBe("remembered: read-only git");
      expect(auditTrail.filter((e) => e.kind === "exec_host.read_only_run.done").length).toBe(
        begun.length,
      );
    });

    it("a driver name -c cannot carry refuses the run and runs nothing (review of #1329, B1)", async () => {
      const cases: [string, string][] = [
        ["eq", "a=b"],
        ["space", "a b"],
        ["tab", "a\tb"],
        ["quote", 'a"b'],
      ];
      for (const [label, name] of cases) {
        const dir = makeRepo(`gitro-name-${label}`);
        if (dir === null) return;
        const mark = marker(`name-${label}`);
        writeFileSync(join(dir, ".gitattributes"), `* filter=${name.replace(/\s/g, "")} diff=x\n`);
        gitIn(dir, "config", `filter.${name}.clean`, `touch ${mark}; cat`);
        gitIn(dir, "config", `diff.${name}.textconv`, `touch ${mark}; cat`);
        setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
        const t = await readyReal();
        for (const argv of [
          ["git", "status"],
          ["git", "diff"],
          ["git", "blame", "a.txt"],
        ]) {
          const params = { argv, cwd: dir };
          const d = await decide(t, params);
          const p = run(
            t,
            params,
            ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
          );
          if (label === "quote") {
            // `-c` can carry a quote: switched off like any other name.
            await p.catch(() => undefined);
          } else {
            await expect(p, `${label}: ${argv.join(" ")}`).rejects.toThrow(
              /cannot be switched off/,
            );
          }
          expect(existsSync(mark), `${label}: ${argv.join(" ")} ran the driver`).toBe(false);
        }
      }
    });

    it("a git dir embedded in the tree, or cwd inside .git, never runs quietly (B2)", async () => {
      const dir = makeRepo("gitro-embedded");
      if (dir === null) return;
      const mark = marker("embedded");
      // A committed subdirectory that looks like a bare repository: git opens it, with its own
      // config (a worktree outside the folder, an fsmonitor payload).
      const emb = join(dir, "emb");
      mkdirSync(join(emb, "objects"), { recursive: true });
      mkdirSync(join(emb, "refs"), { recursive: true });
      writeFileSync(join(emb, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(
        join(emb, "config"),
        `[core]\n\tworktree = ${outside}\n\tfsmonitor = "touch ${mark} #"\n`,
      );
      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await readyReal();
      for (const cwd of [emb, join(dir, ".git"), join(dir, ".git", "refs")]) {
        const params = { argv: ["git", "status"], cwd };
        expect(described(t, params).meta?.hostCommand, cwd).toBeUndefined();
        expect((await decide(t, params)).decision, cwd).toBe("ask");
      }
      // Even if the description were fooled, the run asks git what it opens and refuses.
      expect(existsSync(mark)).toBe(false);
      expect(started).toEqual([]);
    });

    it("alternates pointing outside the folder refuse the quiet run (B2)", async () => {
      const dir = makeRepo("gitro-alt");
      if (dir === null) return;
      mkdirSync(join(dir, ".git", "objects", "info"), { recursive: true });
      writeFileSync(join(dir, ".git", "objects", "info", "alternates"), `${outside}\n`);
      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await readyReal();
      const params = { argv: ["git", "log"], cwd: dir };
      const d = await decide(t, params);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
      // Inside the folder refuses too: a store there can name further stores outside it (r2).
      writeFileSync(
        join(dir, ".git", "objects", "info", "alternates"),
        `${join(dir, ".git", "objects")}\n`,
      );
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("an empty driver name is switched off too (review of #1329 r2, B3)", async () => {
      const dir = makeRepo("gitro-empty-name");
      if (dir === null) return;
      const mark = marker("empty-name");
      writeFileSync(join(dir, ".gitattributes"), "* filter= diff=\n");
      writeFileSync(
        join(dir, ".git", "config"),
        `${readFileSync(join(dir, ".git", "config"), "utf8")}[filter ""]\n\tclean = "touch ${mark}; cat"\n[diff ""]\n\ttextconv = "touch ${mark}; cat"\n`,
      );
      writeFileSync(join(dir, "a.txt"), "changed\n");
      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await readyReal();
      for (const argv of [
        ["git", "status"],
        ["git", "diff"],
        ["git", "blame", "a.txt"],
      ]) {
        const params = { argv, cwd: dir };
        const d = await decide(t, params);
        await run(
          t,
          params,
          ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
        ).catch(() => undefined);
        expect(existsSync(mark), `${argv.join(" ")} ran the empty-named driver`).toBe(false);
      }
    });

    it("a repository with submodules never runs quietly (review of #1329 r2, B4)", async () => {
      for (const [label, setup] of [
        [
          "gitmodules",
          (dir: string) =>
            writeFileSync(
              join(dir, ".gitmodules"),
              '[submodule "s"]\n\tpath = s\n\turl = ./s\n\tignore = none\n',
            ),
        ],
        [
          "modules dir",
          (dir: string) => mkdirSync(join(dir, ".git", "modules", "s"), { recursive: true }),
        ],
      ] as const) {
        const dir = makeRepo(`gitro-sub-${label.replace(" ", "-")}`);
        if (dir === null) return;
        setup(dir);
        setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
        const t = await readyReal();
        const params = { argv: ["git", "status"], cwd: dir };
        const d = await decide(t, params);
        await expect(
          run(
            t,
            params,
            ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
          ),
          label,
        ).rejects.toMatchObject({ code: "forbidden" });
      }
    });

    it("blame runs quietly in an ordinary repository", async () => {
      const dir = makeRepo("gitro-blame");
      if (dir === null) return;
      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await readyReal();
      const params = { argv: ["git", "blame", "-L", "1,1", "a.txt"], cwd: dir };
      const d = await decide(t, params);
      expect(d.rule).toBe(READ_ONLY_RULE);
      const res = await run(
        t,
        params,
        ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
      );
      expect(res.output).toMatchObject({ exitCode: 0, outcome: "ok" });
    });

    it("git that can write, execute or leave the folder asks (or is denied)", async () => {
      const dir = makeRepo("gitro-asks");
      if (dir === null) return;
      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await ready();
      for (const argv of [
        ["git", "-c", "core.pager=sh", "status"],
        ["git", "diff", "--output=/tmp/x"],
        ["git", "log", "--ext-diff"],
        ["git", "branch", "evil"],
        ["git", "push"],
        ["git", "-C", "/etc", "status"],
        ["git", "status;", "rm", "-rf", "x"],
        ["git", "log", "--show-signature"],
        ["git", "log", "--format=%G?"],
        ["git", "status", "-vv"],
        ["git", "branch", "--format=%(signature)"],
        ["git", "remote", "add", "x", "https://example.com"],
        ["/usr/bin/git", "status"],
      ]) {
        const params = { argv, cwd: dir };
        // No read-only class (the meta may still name the exec reviewer's sandbox facts).
        expect(described(t, params).meta?.hostCommand, argv.join(" ")).toBeUndefined();
        const d = await decide(t, params);
        expect(d.decision, argv.join(" ")).toBe("ask");
        expect(d.sideEffect, argv.join(" ")).toBe("destructive");
      }
      // Env or network take it out of the class too.
      for (const extra of [{ env: { COLUMNS: "80" } }, { allowedDomains: ["example.com"] }]) {
        const params = { argv: ["git", "status"], cwd: dir, ...extra };
        expect(described(t, params).meta?.hostCommand).toBeUndefined();
        expect((await decide(t, params)).decision).toBe("ask");
      }
      // In a folder the owner has not shared: refused outright, never a quiet run.
      const other = makeRepo("gitro-unshared");
      if (other !== null) {
        const d = await decide(t, { argv: ["git", "status"], cwd: other });
        expect(d.decision).toBe("deny");
      }
      // Manual mode still asks for the plain read.
      const plain = { argv: ["git", "status"], cwd: dir };
      expect((await decide(t, plain, false, "manual")).decision).toBe("ask");
      expect((await decide(t, plain, true)).decision).toBe("ask");
      expect(started).toEqual([]);
    });

    it("a repository that redirects git (a .git file, core.worktree, include) never runs quietly", async () => {
      const dir = makeRepo("gitro-redirect");
      if (dir === null) return;
      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await ready();
      const params = { argv: ["git", "status"], cwd: dir };
      expect(described(t, params).meta).toBeDefined();
      const config = readFileSync(join(dir, ".git", "config"), "utf8");
      for (const extra of ["[core]\n\tworktree = /\n", "[include]\n\tpath = /tmp/evil\n"]) {
        writeFileSync(join(dir, ".git", "config"), config + extra);
        expect(described(t, params).meta?.hostCommand, extra).toBeUndefined();
        expect((await decide(t, params)).decision).toBe("ask");
      }
      writeFileSync(join(dir, ".git", "config"), config);
      expect(described(t, params).meta).toBeDefined();
      // A `.git` file (gitdir: elsewhere) is not a plain repository either.
      const linked = join(home, "Projects", "gitro-linked");
      mkdirSync(linked, { recursive: true });
      writeFileSync(join(linked, ".git"), `gitdir: ${join(dir, ".git")}\n`);
      setPolicy({ folders: [{ path: linked, mode: "rw" }], exec: { execHostEnabled: true } });
      expect(
        described(t, { argv: ["git", "status"], cwd: linked }).meta?.hostCommand,
      ).toBeUndefined();
      // No repository at all.
      const bare = join(home, "Projects", "gitro-none");
      mkdirSync(bare, { recursive: true });
      setPolicy({ folders: [{ path: bare, mode: "rw" }], exec: { execHostEnabled: true } });
      expect(described(t, { argv: ["git", "log"], cwd: bare }).meta?.hostCommand).toBeUndefined();
    });

    it("a folder shared inside a bigger repository does not read the history above it", async () => {
      const dir = makeRepo("gitro-parent");
      if (dir === null) return;
      const sub = join(dir, "sub");
      mkdirSync(sub, { recursive: true });
      setPolicy({ folders: [{ path: sub, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await ready();
      const params = { argv: ["git", "log", "--oneline"], cwd: sub };
      const d = await decide(t, params);
      expect(d.rule).toBe(READ_ONLY_RULE);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(started).toEqual([]);
    });

    it("starts the system git with the hardened env and argv", async () => {
      const dir = makeRepo("gitro-argv");
      if (dir === null) return;
      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await ready();
      const params = { argv: ["git", "diff", "--stat"], cwd: dir };
      const d = await decide(t, params);
      const pending = run(
        t,
        params,
        ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
      );
      await nextStart();
      finish({});
      await pending;
      const s = started[0] as (typeof started)[number];
      const after = s.args.slice(s.args.indexOf("--") + 2);
      expect(after).toEqual(expect.arrayContaining(["--no-pager", "core.fsmonitor=false"]));
      expect(after.slice(-5)).toEqual([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "--stat",
      ]);
      expect(after).toEqual(expect.arrayContaining(["diff.submodule=short"]));
      expect(s.options?.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PAGER: "cat",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CEILING_DIRECTORIES: join(home, "Projects"),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      });
      // Nothing writable but scratch: the profile of every read-only run.
      expect(JSON.stringify(s.settings)).not.toContain(dir);
    });

    it("':' arguments (HEAD:../x, :/) never run quietly", async () => {
      mkdirSync(repo, { recursive: true });
      const t = await ready();
      for (const argv of [
        ["cat", "HEAD:../x"],
        ["ls", ":/"],
        ["wc", "-l", ":(top)a.txt"],
      ]) {
        expect(described(t, { argv, cwd: repo }).meta?.hostCommand, argv.join(" ")).toBeUndefined();
        expect((await decide(t, { argv, cwd: repo })).decision).toBe("ask");
      }
    });

    it("ls -RL with a symlink out of the folder asks; ls -R does not follow it", async () => {
      const dir = join(home, "Projects", "lsr");
      mkdirSync(dir, { recursive: true });
      mkdirSync(join(outside, "secret-dir"), { recursive: true });
      writeFileSync(join(outside, "secret-dir", "MARKER-outside.txt"), "s3cret");
      if (!existsSync(join(dir, "out"))) symlinkSync(join(outside, "secret-dir"), join(dir, "out"));
      setPolicy({ folders: [{ path: dir, mode: "ro" }], exec: { execHostEnabled: true } });
      const t = await ready();
      expect(described(t, { argv: ["ls", "-RL"], cwd: dir }).meta?.hostCommand).toBeUndefined();
      expect((await decide(t, { argv: ["ls", "-RL"], cwd: dir })).decision).toBe("ask");
      // The quiet ls -R, really run: it lists the link, never what is behind it.
      const r = spawnSync("/bin/ls", ["-R"], { cwd: dir, env });
      expect(String(r.stdout)).toContain("out");
      expect(String(r.stdout)).not.toContain("MARKER-outside");
      expect(described(t, { argv: ["ls", "-R"], cwd: dir }).meta).toMatchObject({
        hostCommand: "read_only",
      });
    });

    it("file -z / -Z (decompressors) asks", async () => {
      mkdirSync(repo, { recursive: true });
      const t = await ready();
      for (const argv of [
        ["file", "-z", "a.gz"],
        ["file", "-Z", "a.gz"],
      ]) {
        expect(described(t, { argv, cwd: repo }).meta?.hostCommand).toBeUndefined();
      }
    });

    it("a FIFO operand never runs quietly, also when planted after the decision", async () => {
      const dir = join(home, "Projects", "fifo");
      mkdirSync(dir, { recursive: true });
      spawnSync("/usr/bin/mkfifo", [join(dir, "pipe")]);
      const t = await ready();
      setPolicy({ folders: [{ path: dir, mode: "ro" }], exec: { execHostEnabled: true } });
      for (const prog of ["cat", "head", "tail", "wc", "file", "ls", "stat"]) {
        expect(
          described(t, { argv: [prog, "pipe"], cwd: dir }).meta?.hostCommand,
          prog,
        ).toBeUndefined();
      }
      writeFileSync(join(dir, "late"), "x");
      const params = { argv: ["cat", "late"], cwd: dir };
      const d = await decide(t, params);
      expect(d.rule).toBe(READ_ONLY_RULE);
      spawnSync("/bin/rm", [join(dir, "late")]);
      spawnSync("/usr/bin/mkfifo", [join(dir, "late")]);
      await expect(
        run(t, params, ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } })),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(started).toEqual([]);
    });

    it("a quiet run lasts at most 15 s (here: the test's cap) whatever timeoutMs it asks for", async () => {
      expect(READ_ONLY_TIMEOUT_MS).toBe(15_000);
      mkdirSync(repo, { recursive: true });
      const t = execHostTool({
        broker: recording(),
        vault: { redact: (x) => x },
        folders: () => broker.policy.folders ?? [],
        srt: { resolve: async () => srt },
        home: psycheHome,
        userHome: home,
        driver,
        audit: recordingAudit,
        readOnlyTimeoutMs: 50,
      });
      await new Promise((r) => setTimeout(r, 5));
      const params = { argv: ["date"], cwd: repo, timeoutMs: 600_000 };
      const d = await decide(t, params);
      const res = await run(
        t,
        params,
        ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } }),
      );
      expect(killed).toContain("SIGKILL");
      expect(res.output).toMatchObject({ timedOut: true, outcome: "uncertain" });
    });

    it("at most two quiet runs at once", async () => {
      mkdirSync(repo, { recursive: true });
      const t = await ready();
      const params = { argv: ["date"], cwd: repo };
      const d = await decide(t, params);
      const c = () => ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } });
      const finishers: ((r: Partial<CliResult>) => void)[] = [];
      const first = run(t, params, c());
      await nextStart();
      finishers.push(finish);
      const second = run(t, params, c());
      await nextStart();
      finishers.push(finish);
      await expect(run(t, params, c())).rejects.toMatchObject({ code: "unavailable" });
      expect(started).toHaveLength(2);
      for (const f of finishers) f({});
      await Promise.all([first, second]);
    });

    it("simultaneous quiet runs, started with no delay between them: still at most two", async () => {
      mkdirSync(repo, { recursive: true });
      const finishers: (() => void)[] = [];
      const many: CliDriver = {
        start() {
          let done: (r: CliResult) => void = () => undefined;
          const p = new Promise<CliResult>((r) => {
            done = r;
          });
          finishers.push(() =>
            done({
              exitCode: 0,
              signal: null,
              stdout: Buffer.from(""),
              stderr: Buffer.from(""),
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 1,
            }),
          );
          return { pid: 1, done: p, kill: () => undefined };
        },
        stream: () => {
          throw new Error("not used");
        },
      };
      const t = execHostTool({
        broker: recording(),
        vault: { redact: (x) => x },
        folders: () => broker.policy.folders ?? [],
        srt: { resolve: async () => srt },
        home: psycheHome,
        userHome: home,
        driver: many,
        audit: recordingAudit,
      });
      await new Promise((r) => setTimeout(r, 5));
      const params = { argv: ["date"], cwd: repo };
      const d = await decide(t, params);
      const c = () => ctx({ authority: { rule: d.rule, bindingHash: d.bindingHash as string } });
      // All three before any await: the slot is taken synchronously.
      const settled = Promise.allSettled([
        run(t, params, c()),
        run(t, params, c()),
        run(t, params, c()),
      ]);
      await vi.waitFor(() => expect(finishers).toHaveLength(2));
      for (const f of finishers) f();
      const out = await settled;
      expect(finishers).toHaveLength(2);
      expect(out.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(
        (out.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
      ).toMatchObject({
        code: "unavailable",
      });
    });

    it("a hard-linked operand never runs quietly (realpath cannot see where it lives)", async () => {
      const dir = join(home, "Projects", "hard");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(outside, "MARKER-hard.txt"), "s3cret");
      if (!existsSync(join(dir, "copy.txt")))
        linkSync(join(outside, "MARKER-hard.txt"), join(dir, "copy.txt"));
      writeFileSync(join(dir, "plain.txt"), "x");
      setPolicy({ folders: [{ path: dir, mode: "ro" }], exec: { execHostEnabled: true } });
      const t = await ready();
      expect(
        described(t, { argv: ["cat", "copy.txt"], cwd: dir }).meta?.hostCommand,
      ).toBeUndefined();
      expect(described(t, { argv: ["cat", "plain.txt"], cwd: dir }).meta).toMatchObject({
        hostCommand: "read_only",
      });
    });

    it("every git exec_host runs, carded ones too, has its config's programs switched off", async () => {
      const dir = join(home, "Projects", "hardened");
      mkdirSync(dir, { recursive: true });
      const git = (...a: string[]) => spawnSync("/usr/bin/git", a, { cwd: dir, env });
      if (git("init", "-q").status !== 0) return; // no git on this machine
      git("config", "filter.pwn.clean", `touch ${marker("hardened")}; cat`);
      git("config", "diff.pwn.textconv", `touch ${marker("hardened")}; cat`);
      setPolicy({ folders: [{ path: dir, mode: "rw" }], exec: { execHostEnabled: true } });
      const t = await ready();
      // A git outside the read-only class (`--show-signature` asks), so it is carded.
      const params = { argv: ["git", "log", "--show-signature"], cwd: dir };
      const a = await card(t, params);
      await answer(a.id);
      const out = run(t, params, ctx({ approvalId: a.id }));
      await vi.waitFor(() => expect(started).toHaveLength(1));
      finish({});
      await out;
      const s = started[0];
      const inner = s?.args.slice((s?.args.indexOf("--") ?? 0) + 2) ?? [];
      for (const v of [
        "core.fsmonitor=false",
        "core.hooksPath=/dev/null",
        "gpg.program=/usr/bin/false",
        "log.showSignature=false",
        "diff.external=",
        "filter.pwn.clean=",
        "filter.pwn.process=",
        "filter.pwn.smudge=",
        "diff.pwn.textconv=",
      ]) {
        expect(inner, v).toContain(v);
      }
      // The owner's own argv comes last, unchanged.
      expect(inner.slice(-2)).toEqual(["log", "--show-signature"]);
      expect(existsSync(marker("hardened"))).toBe(false);
    });
  },
);

/**
 * exec_host on a Windows Gateway: Windows programs found with PATHEXT in Windows' own folders,
 * never a batch file through cmd.exe, drive-letter cwds compared without case, a Windows env,
 * Windows git hardening, and, with no host sandbox there, every command on a card that runs
 * only with UNSANDBOXED typed on it.
 */
describe.skipIf(process.platform !== "win32")("exec_host on Windows", () => {
  const sys = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  // skipIf still runs this body on other platforms, so only resolve the real path on Windows.
  const whoami =
    process.platform === "win32"
      ? realpathSync.native(join(sys, "whoami.exe"))
      : join(sys, "whoami.exe");
  const winHost = (audit = false) =>
    execHostTool({
      broker: recording(),
      vault: { redact: (t) => t },
      folders: (threadId) => [...(broker.policy.folders ?? []), ...broker.sessionFolders(threadId)],
      srt: { resolve: async () => srt },
      home: psycheHome,
      userHome: home,
      driver,
      platform: "win32",
      ...(audit ? { audit: recordingAudit } : {}),
    });
  beforeEach(() => {
    srt = { missing: true, reason: "unsupported_platform" };
    setPolicy({ ...policy, exec: { execHostEnabled: true, readOnlyWithoutAsking: true } });
  });

  it("finds a bare name with PATHEXT in Windows' folders, takes an absolute .exe, refuses batch files", async () => {
    const t = winHost();
    const a = await card(t, { argv: ["whoami"], cwd: project });
    expect(a.details).toMatchObject({ executable: whoami });
    const b = await card(t, { argv: [whoami.toLowerCase()], cwd: project });
    expect(b.details).toMatchObject({ executable: whoami });
    const bat = join(project, "build.cmd");
    writeFileSync(bat, "@echo off\r\necho hi\r\n");
    expect(() => t.describeCall?.({ argv: [bat], cwd: project })).toThrow(/batch file/);
    // `.\build` finds the .cmd by PATHEXT and is refused the same way, never run through cmd.exe.
    expect(() => t.describeCall?.({ argv: [".\\build"], cwd: project })).toThrow(/batch file/);
    expect(() => t.describeCall?.({ argv: ["psyche-no-such-tool"], cwd: project })).toThrow(
      /not in .*System32/,
    );
  });

  it("asks for every command, read-only ones too, and says there is no sandbox to set up", async () => {
    const t = winHost(true);
    const d = await decide(t, { argv: ["whoami"], cwd: project });
    expect(d.decision).toBe("ask");
    expect(described(t, { argv: ["whoami"], cwd: project }).meta?.hostCommand).toBeUndefined();
    const a = await card(t, { argv: ["whoami"], cwd: project });
    expect(a.details).toMatchObject({
      sandbox: "missing",
      sandboxMissingReason: "unsupported_platform",
      hostSandbox: "none",
      unsandboxedWord: UNSANDBOXED_WORD,
    });
  });

  it("an approval without UNSANDBOXED runs nothing and points nowhere it cannot be fixed", async () => {
    const t = winHost();
    const params = { argv: ["whoami"], cwd: project };
    const a = await card(t, params);
    await answer(a.id);
    const err = await run(t, params, ctx({ approvalId: a.id })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable", details: { reason: "no_host_sandbox" } });
    expect((err as { details?: { missing?: unknown } }).details?.missing).toBeUndefined();
    expect(String((err as Error).message)).toContain(UNSANDBOXED_WORD);
    expect(started).toEqual([]);
  });

  it("with UNSANDBOXED typed: runs the .exe directly in a drive-letter subfolder with a Windows env", async () => {
    const t = winHost();
    const sub = join(project, "Src");
    mkdirSync(sub, { recursive: true });
    // Another case and forward slashes are the same folder on Windows.
    const cwd = sub.toUpperCase().replaceAll("\\", "/");
    const params = { argv: ["whoami", "/user"], cwd, env: { CI: "1" } };
    const a = await card(t, params);
    await answer(a.id, { unsandboxed: UNSANDBOXED_WORD });
    const out = run(t, params, ctx({ approvalId: a.id }));
    await nextStart();
    finish({ stdout: Buffer.from("me\r\n") });
    expect((await out).output).toMatchObject({ exitCode: 0, sandboxed: false, outcome: "ok" });
    const s = started[0];
    expect(s?.file).toBe(whoami);
    expect(s?.args).toEqual(["/user"]);
    expect(s?.options?.cwd?.toLowerCase()).toBe(realpathSync(sub).toLowerCase());
    const env = s?.options?.env ?? {};
    expect(String(env.PATH).split(";")[0]?.toLowerCase()).toBe(sys.toLowerCase());
    expect(env.PATHEXT).toBe(".COM;.EXE");
    expect(env.USERPROFILE).toBe(home);
    expect(env.CI).toBe("1");
    expect(env.TEMP).toBe(env.TMP);
    expect(String(env.TEMP).startsWith(join(psycheHome, "exec-host"))).toBe(true);
    // Nothing POSIX, and nothing else of the Gateway's own environment.
    for (const k of ["HOME", "TMPDIR", "LANG", "USER"]) expect(env[k], k).toBeUndefined();
    expect(Object.keys(env).some((k) => k.startsWith("PSYCHE"))).toBe(false);
  });

  it("refuses a cwd outside the grants, a rooted cwd without a drive, and Windows' reserved env", async () => {
    const t = winHost();
    expect(() => t.describeCall?.({ argv: ["whoami"], cwd: "\\Users\\x" })).toThrow(/drive/);
    for (const k of ["USERPROFILE", "PATHEXT", "SYSTEMROOT", "COMSPEC", "APPDATA", "TEMP"]) {
      expect(() => t.describeCall?.({ argv: ["whoami"], cwd: project, env: { [k]: "x" } })).toThrow(
        /fixed/,
      );
    }
    // Outside the grants: denied before any card, naming the folder (the run checks again).
    const params = { argv: ["whoami"], cwd: outside };
    const d = await decide(t, params);
    expect(d).toMatchObject({ decision: "deny", missing: { need: "folder", path: outside } });
    await expect(run(t, params, ctx({ approvalId: "ap_none" }))).rejects.toMatchObject({
      code: "forbidden",
      details: { missing: { need: "folder" } },
    });
    expect(started).toEqual([]);
  });

  it("every git gets Windows' hardening (no hooks, no gpg) before the owner's argv", async () => {
    const t = winHost();
    let git: string;
    try {
      const d = t.describeCall?.({ argv: ["git", "--version"], cwd: project }) as
        | ToolCallDescription
        | undefined;
      git = d?.details?.executable as string;
    } catch {
      return; // no Git for Windows on this machine
    }
    const params = { argv: ["git", "status"], cwd: project };
    const a = await card(t, params);
    await answer(a.id, { unsandboxed: UNSANDBOXED_WORD });
    const out = run(t, params, ctx({ approvalId: a.id }));
    await nextStart();
    finish({});
    await out;
    const s = started[0];
    expect(s?.file).toBe(git);
    for (const v of [
      "core.fsmonitor=false",
      `core.hooksPath=${join(sys, "psyche-disabled")}`,
      `gpg.program=${join(sys, "psyche-disabled.exe")}`,
      "log.showSignature=false",
      "diff.external=",
    ]) {
      expect(s?.args, v).toContain(v);
    }
    expect(s?.args.slice(-1)).toEqual(["status"]);
  });
});

describe("program-grant runs: folder-confined reads, folded git names", () => {
  const base = {
    psycheHome: "/Users/me/.psyche",
    userHome: "/Users/me",
    scratch: "/Users/me/.psyche/exec-host/s1",
    writable: [],
    allowedDomains: [],
  };
  it("denies the home and /Volumes and re-allows only the grant folder", () => {
    const fs = (
      execHostSrtSettings({ ...base, confineRead: "/Users/me/project" }) as {
        filesystem: { denyRead: string[]; allowRead: string[] };
      }
    ).filesystem;
    expect(fs.denyRead).toEqual(expect.arrayContaining(["/Users/me", "/Volumes"]));
    expect(fs.allowRead).toContain("/Users/me/project");
  });
  it.skipIf(!posixHost)(
    "never writes persistence locations, even inside a granted home folder",
    () => {
      const fs = (
        execHostSrtSettings({ ...base, writable: ["/Users/me"] }) as {
          filesystem: { denyWrite: string[]; allowWrite: string[] };
        }
      ).filesystem;
      expect(fs.allowWrite).toContain("/Users/me");
      expect(fs.denyWrite).toEqual(
        expect.arrayContaining([
          "/Users/me/Applications",
          "/Users/me/Library/LaunchAgents",
          "/Users/me/Library/Preferences",
          "/Users/me/.zshrc",
          "/Users/me/.bash_profile",
          "/Users/me/.config/fish",
          "/Users/me/.gitconfig",
          "/Users/me/.ssh",
        ]),
      );
      expect(fs.denyWrite).not.toContain("/Users/me");
    },
  );
  // #1434 review r1, finding 4: the file tools' write protection, dot-home rule included.
  it.skipIf(!posixHost)("denies what the file tools refuse under a home share", () => {
    const denyWrite = (writable: string[]) =>
      (
        execHostSrtSettings({
          ...base,
          writable,
          homeDotEntries: [".newrc", ".tool", ".zshrc"],
        }) as { filesystem: { denyWrite: string[] } }
      ).filesystem.denyWrite;
    const home = denyWrite(["/Users/me"]);
    expect(home).toEqual(
      expect.arrayContaining([
        "/Users/me/.newrc",
        "/Users/me/.tool",
        "/Users/me/.aws",
        ...(process.platform === "darwin"
          ? ["/Users/me/Library", "/Users/me/bin", "/Users/me/.hammerspoon"]
          : []),
      ]),
    );
    expect(home).not.toContain("/Users/me/Projects");
    // A project folder: the dot entries in home are not writable anyway, so none are listed.
    const project = denyWrite(["/Users/me/Projects/app"]);
    expect(project).not.toContain("/Users/me/.newrc");
    expect(project).toContain("/Users/me/.zshrc");
  });
  it("leaves an ordinary run's profile alone (control)", () => {
    const fs = (
      execHostSrtSettings(base) as { filesystem: { denyRead: string[]; allowRead: string[] } }
    ).filesystem;
    expect(fs.denyRead).not.toContain("/Users/me");
    expect(fs.denyRead).not.toContain("/Volumes");
  });
  it("GIT and a long-s spelling get git's hardening on darwin", () => {
    expect(isGit("/usr/bin/GIT", undefined, "darwin")).toBe(true);
    expect(isGit("/usr/bin/x", "Git", "darwin")).toBe(true);
    expect(isGit("/usr/bin/git", undefined, "darwin")).toBe(true);
    expect(isGit("/usr/bin/gitk", undefined, "darwin")).toBe(false);
  });
});

describe.skipIf(!posixHost)("program grant: Always allow <program> in <folder> (run path)", () => {
  const params = { argv: ["grep", "-r", "foo", "."], cwd: project };
  const tool = (over: Record<string, unknown> = {}) =>
    execHostTool({
      broker: recording(),
      vault: { redact: (t) => t },
      folders: (threadId) => [...(broker.policy.folders ?? []), ...broker.sessionFolders(threadId)],
      srt: { resolve: async () => srt },
      home: psycheHome,
      userHome: home,
      driver,
      audit: recordingAudit,
      ...over,
    });

  /** The owner taps "Always allow grep in <folder>"; returns the grant-authorized context. */
  async function granted(t: AgentToolRegistration) {
    setPolicy({ folders: [{ path: project, mode: "rw" }], exec: { execHostEnabled: true } });
    // The card reads the sandbox's last known state: let the first look finish.
    t.describeCall?.(params);
    await new Promise((r) => setTimeout(r, 20));
    const a = await card(t, params);
    expect(a.details).toMatchObject({ hostProgram: { program: "grep", argv: null } });
    await answer(a.id, { hostProgram: true });
    const d = await decide(t, params);
    expect(d).toMatchObject({ decision: "allow" });
    expect(d.rule).toMatch(/^grant:/);
    const desc = t.describeCall?.(params) as ToolCallDescription;
    return {
      d,
      authority: {
        rule: d.rule,
        bindingHash: d.bindingHash as string,
        grantKey: namespacedGrantKey(t.spec.name, desc.grantKey as string),
        grantId: d.grantId as string,
        scope: "always",
      } as never,
    };
  }

  beforeEach(() => {
    auditTrail.length = 0;
  });

  it("runs under srt confined to the folder: home and temp roots denied, writes only to scratch, audited", async () => {
    const t = tool();
    const { authority } = await granted(t);
    const pend = run(t, params, ctx({ authority }));
    await nextStart();
    const fs = (started[0]?.settings as { filesystem: Record<string, string[]> } | undefined)
      ?.filesystem as Record<string, string[]>;
    expect(fs.denyRead).toEqual(
      expect.arrayContaining([
        home,
        "/Volumes",
        "/tmp",
        "/private/tmp",
        "/var/folders",
        "/private/var/folders",
        "/Users/Shared",
      ]),
    );
    expect(fs.allowRead).toContain(realpathSync(project));
    // Nothing is writable but the run's own scratch, although the folder is read-write.
    expect(fs.allowWrite).toHaveLength(1);
    // The scratch lives under a denied temp root: it is re-allowed for reading (allowRead wins
    // over denyRead in srt, as scratch.ts relies on) and is the only writable place.
    expect(fs.allowRead).toContain(fs.allowWrite?.[0]);
    expect(auditTrail.map((e) => e.kind)).toEqual(["exec_host.program_run"]);
    finish({ stdout: Buffer.from("ok") });
    expect((await pend).output).toMatchObject({ exitCode: 0, sandboxed: true });
    expect(auditTrail.map((e) => e.kind)).toEqual([
      "exec_host.program_run",
      "exec_host.program_run.done",
    ]);
  });

  it("an ordinary exact grant is not confined (control)", async () => {
    const t = tool();
    setPolicy({ folders: [{ path: project, mode: "rw" }], exec: { execHostEnabled: true } });
    const a = await card(t, echo);
    await answer(a.id, {});
    const pend = run(t, echo, ctx({ approvalId: a.id }));
    await nextStart();
    const fs = (started[0]?.settings as { filesystem: Record<string, string[]> } | undefined)
      ?.filesystem as Record<string, string[]>;
    expect(fs.denyRead).not.toContain(home);
    finish({});
    await pend;
    expect(auditTrail).toHaveLength(0);
  });

  it("stops a run at the quiet class's cap (here shortened)", async () => {
    const t = tool({ readOnlyTimeoutMs: 40 });
    const { authority } = await granted(t);
    const pend = run(t, { ...params, timeoutMs: 600_000 }, ctx({ authority }));
    await nextStart();
    const r = await pend;
    expect(killed).toContain("SIGKILL");
    expect(r.output).toMatchObject({ timedOut: true });
  });

  it("a revoked grant throws at run time, and nothing starts", async () => {
    const t = tool();
    const { d, authority } = await granted(t);
    await broker.revokeGrant(d.grantId as string);
    await expect(run(t, params, ctx({ authority }))).rejects.toThrow(/not live/);
    expect(started).toHaveLength(0);
  });

  it("a path that now leaves the folder, or a missing ledger, throws instead of running", async () => {
    const t = tool();
    const { authority } = await granted(t);
    await expect(
      run(t, { argv: ["grep", "-r", "foo", "/etc"], cwd: project }, ctx({ authority })),
    ).rejects.toThrow(/no longer fits|binding|mismatch/);
    const bare = tool({ broker: { get: (id: string) => broker.get(id) } });
    await expect(run(bare, params, ctx({ authority }))).rejects.toThrow(/ledger/);
    expect(started).toHaveLength(0);
  });
});
