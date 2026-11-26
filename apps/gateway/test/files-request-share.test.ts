import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { createRun, createThread, openDb, type PsycheDb, putAgentThreadState } from "@psyche/db";
import { createPermissionBroker, type PsychePermissionBroker } from "@psyche/permissions";
import { FilesMethods } from "@psyche/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { filesHandlers } from "../src/compose/files.ts";
import { requestFolderAccessTool } from "../src/compose/folder-access.ts";
import type { Call } from "../src/context.ts";

/**
 * `files.requestShare`: the chat's "Share this folder (read only)" button raises the same
 * `folder_access` card as `request_folder_access`, outside an agent run. The owner's pick is
 * what is granted, never the hinted path; nothing is granted without the card.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-share-")));
const home = join(root, "home");
const project = join(home, "Projects", "app");
const picked = join(home, "Projects", "picked");
mkdirSync(project, { recursive: true });
mkdirSync(picked, { recursive: true });
writeFileSync(join(picked, "a.txt"), "x");

const DEVICE = { deviceId: "dev_mac" };
let broker: PsychePermissionBroker;
let db: PsycheDb;
let threadId: string;
const tokens = new Map<string, string>();

beforeEach(() => {
  tokens.clear();
  db = openDb(":memory:");
  threadId = createThread(db, { kind: "main", sessionKey: "owner:main" }).id;
  broker = createPermissionBroker({
    armDelayMs: 0,
    approvers: {
      device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
    },
    folderAccess: {
      env: () => ({ home, psycheHome: join(home, ".psyche") }),
      persist: async () => {},
    },
  });
});

/** The broker with the answer tokens kept, as the Gateway's announcing broker hands them out. */
const tracked = () =>
  new Proxy(broker, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop !== "requestApproval") return typeof v === "function" ? v.bind(target) : v;
      return async (...args: Parameters<PsychePermissionBroker["requestApproval"]>) => {
        const issued = await target.requestApproval(...args);
        tokens.set(issued.approval.id, issued.answerTokens.desktop ?? "");
        return issued;
      };
    },
  });

const share = () => ({
  broker: tracked(),
  surfaces: ["desktop"],
  folderEnv: () => ({ home, psycheHome: join(home, ".psyche") }),
  grantedFolders: (id: string) => [...(broker.policy.folders ?? []), ...broker.sessionFolders(id)],
});

const callAs = (scopes: string[]): Call =>
  ({
    ctx: { db },
    identity: { scopes },
  }) as unknown as Call;
const ADMIN = ["operator.read", "operator.admin"];

const requestShare = (
  scopes: string[] = ADMIN,
  params: Record<string, unknown> = { threadId, path: "~/Projects/app", access: "read" },
) => {
  const h = filesHandlers({ folders: () => [], home: root, share: share() })["files.requestShare"];
  return h?.run(callAs(scopes), params as never) as Promise<{
    status: "pending" | "already";
    approvalId?: string;
  }>;
};

const answer = async (id: string, scope: "once" | "always", folderPath: string) =>
  broker.answer({
    approvalId: id,
    answerToken: tokens.get(id) ?? "",
    decision: "approve",
    scope,
    folderPath,
    decidedBy: DEVICE,
  });

describe("files.requestShare", () => {
  it("is an admin, side-effecting method that takes read only", () => {
    const spec = FilesMethods["files.requestShare"];
    expect(spec.scope).toBe("operator.admin");
    expect(spec.sideEffecting).toBe(true);
  });

  it("raises a folder_access card bound like the tool's, and grants nothing by itself", async () => {
    const r = await requestShare();
    expect(r.status).toBe("pending");
    const [card] = await broker.list({ status: "pending" });
    expect(card?.id).toBe(r.approvalId);
    expect(card).toMatchObject({
      kind: "folder_access",
      grantKey: "folder_access|ro",
      sideEffect: "read",
      scopesOffered: ["once", "always"],
      taint: false,
      requestedBy: { threadId, runId: null },
    });
    expect(card?.details).toMatchObject({
      requestedPath: "~/Projects/app",
      access: "ro",
      resolvedPath: project,
    });
    expect(broker.sessionFolders(threadId)).toEqual([]);

    // The tool's card for the same request has the same shape (kind, grant key, details).
    const tool: AgentToolRegistration = requestFolderAccessTool(share());
    const ctx: ToolRunContext = {
      callId: "call_1",
      threadId,
      runId: "run_1",
      taint: false,
      permissionMode: "balanced",
      mode: "attended",
      signal: new AbortController().signal,
      onUpdate: () => undefined,
    };
    void tool.run?.({ path: "~/Projects/app", reason: "r", access: "read" }, ctx);
    let other: Awaited<ReturnType<typeof broker.list>>[number] | undefined;
    for (let i = 0; i < 50 && other === undefined; i++) {
      other = (await broker.list({ status: "pending" })).find((a) => a.id !== r.approvalId);
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(other).toBeDefined();
    expect(other?.kind).toBe(card?.kind);
    expect(other?.grantKey).toBe(card?.grantKey);
    expect(other?.sideEffect).toBe(card?.sideEffect);
    expect(other?.scopesOffered).toEqual(card?.scopesOffered);
    expect(other?.details).toMatchObject({ access: "ro", resolvedPath: project });
  });

  it("grants the folder the owner picks, not the hinted path", async () => {
    const r = await requestShare();
    await answer(r.approvalId as string, "once", picked);
    expect(broker.sessionFolders(threadId)).toEqual([{ path: picked, mode: "ro" }]);
    expect(broker.sessionFolders(threadId).some((f) => f.path === project)).toBe(false);
  });

  it("offers Allow once only on a tainted thread (saved taint, or a turn still running)", async () => {
    putAgentThreadState(db, threadId, { taint: { sources: [{ sourceKind: "web" }] } });
    const saved = await requestShare();
    const [a] = await broker.list({ status: "pending" });
    expect(a?.id).toBe(saved.approvalId);
    expect(a?.scopesOffered).toEqual(["once"]);
    expect(a?.taint).toBe(true);
    await expect(answer(saved.approvalId as string, "always", picked)).rejects.toBeDefined();
    expect(broker.policy.folders ?? []).toEqual([]);

    // A running turn's taint is not saved yet: fail closed.
    putAgentThreadState(db, threadId, {});
    createRun(db, { threadId, modelRef: "fake/model" });
    const running = await requestShare(ADMIN, {
      threadId,
      path: "~/Projects/picked",
      access: "read",
    });
    const card = (await broker.list({ status: "pending" })).find(
      (x) => x.id === running.approvalId,
    );
    expect(card?.scopesOffered).toEqual(["once"]);
  });

  it("refuses a device without operator.admin, before any card", async () => {
    await expect(requestShare(["operator.read", "operator.approvals"])).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await broker.list({ status: "pending" })).toEqual([]);
  });

  it("refuses any access other than read", async () => {
    for (const access of ["read_write", "rw", "write", undefined]) {
      await expect(
        requestShare(ADMIN, { threadId, path: "~/Projects/app", access }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    }
    expect(await broker.list({ status: "pending" })).toEqual([]);
  });

  it("answers at once when a granted folder already covers the path, and for an unknown thread", async () => {
    broker.setPolicy({ ...broker.policy, folders: [{ path: join(home, "Projects"), mode: "ro" }] });
    expect(await requestShare()).toEqual({ status: "already" });
    expect(await broker.list({ status: "pending" })).toEqual([]);
    await expect(
      requestShare(ADMIN, { threadId: "thr_nope", path: "~/Projects/app", access: "read" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("leaves one pending card for 5 clicks, two devices, or a card the agent already raised", async () => {
    const racing = await Promise.all([1, 2, 3, 4, 5].map(() => requestShare()));
    expect(new Set(racing.map((r) => r.approvalId)).size).toBe(1);
    const again = await requestShare(["operator.admin"]);
    expect(again.approvalId).toBe(racing[0]?.approvalId);
    expect(await broker.list({ status: "pending" })).toHaveLength(1);

    // A card the agent raised with request_folder_access on this thread is reused too.
    const other = join(home, "Projects", "other");
    mkdirSync(other, { recursive: true });
    const tool = requestFolderAccessTool(share());
    const ctx: ToolRunContext = {
      callId: "call_9",
      threadId,
      runId: "run_9",
      taint: false,
      permissionMode: "balanced",
      mode: "attended",
      signal: new AbortController().signal,
      onUpdate: () => undefined,
    };
    void tool.run?.({ path: other, reason: "r", access: "read" }, ctx);
    let agentCard: { id: string } | undefined;
    for (let i = 0; i < 50 && agentCard === undefined; i++) {
      agentCard = (await broker.list({ status: "pending" })).find(
        (a) => a.details.resolvedPath === other,
      );
      await new Promise((res) => setTimeout(res, 5));
    }
    const viaButton = await requestShare(ADMIN, { threadId, path: other, access: "read" });
    expect(viaButton.approvalId).toBe(agentCard?.id);
    expect(await broker.list({ status: "pending" })).toHaveLength(2);
  });

  it("never reuses the agent's read & write card, nor an untainted card once the thread is tainted", async () => {
    // The agent asked for read & write: the read-only button raises its own read-only card.
    const rwFolder = join(home, "Projects", "rw");
    mkdirSync(rwFolder, { recursive: true });
    const tool = requestFolderAccessTool(share());
    const ctx: ToolRunContext = {
      callId: "call_rw",
      threadId,
      runId: "run_rw",
      taint: false,
      permissionMode: "balanced",
      mode: "attended",
      signal: new AbortController().signal,
      onUpdate: () => undefined,
    };
    void tool.run?.({ path: rwFolder, reason: "r", access: "read_write" }, ctx);
    let rwCard: { id: string } | undefined;
    for (let i = 0; i < 50 && rwCard === undefined; i++) {
      rwCard = (await broker.list({ status: "pending" })).find(
        (a) => a.details.resolvedPath === rwFolder,
      );
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(rwCard).toBeDefined();
    const viaButton = await requestShare(ADMIN, { threadId, path: rwFolder, access: "read" });
    expect(viaButton.approvalId).not.toBe(rwCard?.id);
    const mine = (await broker.list({ status: "pending" })).find(
      (a) => a.id === viaButton.approvalId,
    );
    expect(mine?.details.access).toBe("ro");

    // An untainted read-only card offered Always; once the thread is tainted it is not reused.
    const before = await requestShare();
    const untainted = (await broker.list({ status: "pending" })).find(
      (a) => a.id === before.approvalId,
    );
    expect(untainted?.scopesOffered).toContain("always");
    putAgentThreadState(db, threadId, { taint: { sources: [{ sourceKind: "web" }] } });
    const after = await requestShare();
    expect(after.approvalId).not.toBe(before.approvalId);
    const tainted = (await broker.list({ status: "pending" })).find(
      (a) => a.id === after.approvalId,
    );
    expect(tainted?.scopesOffered).toEqual(["once"]);
  });

  it("offers what the tool offers per thread kind, and refuses channel and subagent threads", async () => {
    const mk = (kind: "automation" | "incognito" | "channel" | "subagent") =>
      createThread(db, { kind, sessionKey: `k:${kind}` }).id;
    const scopes = async (id: string) => {
      const r = await requestShare(ADMIN, { threadId: id, path: "~/Projects/app", access: "read" });
      return (await broker.list({ status: "pending" })).find((a) => a.id === r.approvalId)
        ?.scopesOffered;
    };
    // An automation thread has no "this conversation": a lasting answer only, as for the tool.
    expect(await scopes(mk("automation"))).toEqual(["always"]);
    expect(await scopes(mk("incognito"))).toEqual(["once", "always"]);
    for (const kind of ["channel", "subagent"] as const) {
      await expect(
        requestShare(ADMIN, { threadId: mk(kind), path: "~/Projects/app", access: "read" }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await broker.list({ status: "pending" })).toHaveLength(2);
  });

  it("words the card neutrally, keeping the agent's path as the place it tried", async () => {
    const r = await requestShare();
    const card = (await broker.list({ status: "pending" })).find((a) => a.id === r.approvalId);
    expect(card?.summary).toBe("Share a folder for this chat (a file tool tried ~/Projects/app)");
    expect(card?.details).toMatchObject({
      reason: "Share a folder for this chat",
      requestedPath: "~/Projects/app",
    });
    expect(JSON.stringify(card)).not.toMatch(/You chose/);
  });
});
