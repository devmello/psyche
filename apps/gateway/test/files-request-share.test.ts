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
      isOwnerSender: async () => false,
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
    const running = await requestShare();
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
});
