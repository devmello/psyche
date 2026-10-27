import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { fileTools } from "@psyche/files";
import { createPermissionBroker, type PsychePermissionBroker } from "@psyche/permissions";
import { beforeEach, describe, expect, it } from "vitest";
import { requestFolderAccessTool, withFolder } from "../src/compose/folder-access.ts";

/**
 * `request_folder_access` end to end below the loop: the tool raises the card, the owner's pick
 * is granted, and the file tools can use the folder in the same turn. A tainted turn is offered
 * `once` only; `always` lands in the persisted policy list.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-fa-")));
const home = join(root, "home");
const project = join(home, "Projects", "app");
mkdirSync(project, { recursive: true });
mkdirSync(join(home, ".ssh"), { recursive: true });
writeFileSync(join(project, "notes.txt"), "hello folder");

const DEVICE = { deviceId: "dev_mac" };
let broker: PsychePermissionBroker;
let stored: { path: string; mode: "ro" | "rw" }[];

beforeEach(() => {
  stored = [];
  broker = createPermissionBroker({
    armDelayMs: 0,
    approvers: {
      device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
      isOwnerSender: async () => false,
    },
    folderAccess: {
      env: () => ({ home, psycheHome: join(home, ".psyche") }),
      persist: async (e) => {
        stored = withFolder({ folders: stored }, e).folders;
      },
    },
  });
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

/** A registration's in-process `run` (defineTool always sets it). */
function run(t: AgentToolRegistration | undefined, params: unknown, c: ToolRunContext) {
  if (t?.run === undefined) throw new Error("tool has no run");
  return t.run(params, c);
}

const tool = () =>
  requestFolderAccessTool({
    broker: new Proxy(broker, {
      get(target, prop, receiver) {
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
    }),
    surfaces: ["desktop"],
  });
const input = { path: "~/Projects/app", reason: "read the notes", access: "read" as const };

async function pending() {
  for (let i = 0; i < 50; i++) {
    const [a] = await broker.list({ status: "pending" });
    if (a && tokens.has(a.id)) return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval raised");
}

describe("request_folder_access", () => {
  it("grants the picked folder for this conversation, usable by the file tools at once", async () => {
    const pend = run(tool(), input, ctx());
    const a = await pending();
    expect(a.kind).toBe("folder_access");
    expect(a.details).toMatchObject({ requestedPath: "~/Projects/app", access: "ro" });
    expect(a.scopesOffered).toEqual(["once", "always"]);
    await answerPending(a.id, "once", project);
    const out = (await pend).output as { granted: boolean; path: string; access: string };
    expect(out).toMatchObject({ granted: true, path: project, access: "read" });

    const read = fileTools({
      folders: (scope) => [
        ...(broker.policy.folders ?? []),
        ...(scope ? broker.sessionFolders(scope.threadId) : []),
      ],
    }).find((t) => t.spec.name === "read_file");
    const res = await run(read, { path: join(project, "notes.txt") }, ctx());
    expect(JSON.stringify(res?.output)).toContain("hello folder");
    // A different conversation does not get the folder.
    await expect(
      run(read, { path: join(project, "notes.txt") }, ctx({ threadId: "thr_2" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("always persists the picked folder for Settings", async () => {
    const pend = run(tool(), input, ctx());
    const a = await pending();
    await answerPending(a.id, "always", project);
    expect((await pend).output).toMatchObject({ granted: true, until: "revoked" });
    expect(stored).toEqual([{ path: project, mode: "ro" }]);
  });

  it("a tainted turn is offered once only", async () => {
    const pend = run(tool(), input, ctx({ taint: true, taintSources: [{ sourceKind: "web" }] }));
    const a = await pending();
    expect(a.scopesOffered).toEqual(["once"]);
    expect(a.taint).toBe(true);
    await answerPending(a.id, "once", project);
    await pend;
    expect(stored).toEqual([]);
  });

  it("a denial returns granted:false and grants nothing", async () => {
    const pend = run(tool(), input, ctx());
    const a = await pending();
    await answerPending(a.id, "deny", "");
    expect((await pend).output).toEqual({ granted: false, status: "denied" });
    expect(broker.sessionFolders("thr_1")).toEqual([]);
  });

  it("refuses unattended runs and non-owner requesters without raising a card", async () => {
    await expect(run(tool(), input, ctx({ mode: "unattended" }))).rejects.toMatchObject({
      code: "approval_required",
    });
    await expect(
      run(tool(), input, ctx({ requester: { role: "guest" } as never })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await broker.list({ status: "pending" })).toEqual([]);
  });
});

describe("withFolder", () => {
  it("adds a folder once and lets read-write replace read-only", () => {
    const a = withFolder({ folders: [] }, { path: "/x", mode: "ro" });
    expect(withFolder(a, { path: "/x", mode: "ro" }).folders).toHaveLength(1);
    expect(withFolder(a, { path: "/x", mode: "rw" }).folders).toEqual([{ path: "/x", mode: "rw" }]);
    expect(withFolder(a, { path: "/x", mode: "ro" }).folders).toEqual([{ path: "/x", mode: "ro" }]);
  });
});

/** The answer token exists only on the issued approval, so the test broker handle records it. */
const tokens = new Map<string, string>();

async function answerPending(id: string, scope: "once" | "always" | "deny", folderPath: string) {
  const answerToken = tokens.get(id) ?? "";
  if (scope === "deny") {
    await broker.answer({ approvalId: id, answerToken, decision: "deny", decidedBy: DEVICE });
    return;
  }
  await broker.answer({
    approvalId: id,
    answerToken,
    decision: "approve",
    scope,
    folderPath,
    decidedBy: DEVICE,
  });
}
