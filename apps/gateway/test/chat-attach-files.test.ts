import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { createThread, openDb, type PsycheDb } from "@psyche/db";
import { fileTools } from "@psyche/files";
import { createPermissionBroker, type PsychePermissionBroker } from "@psyche/permissions";
import { ChatMethods } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it } from "vitest";
import type { Call } from "../src/context.ts";
import { chatHandlers } from "../src/handlers/chat.ts";

/**
 * Files attached to a chat message from disk (desktop): the owner's pick is the approval, the
 * broker holds a read-only grant for exactly those files in that thread, and `read_file` honours
 * it the way the Gateway wires it (`fileTools` with the thread's session folders).
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-attach-")));
const home = join(root, "home");
const docs = join(home, "Documents");
const report = join(docs, "report.txt");
const sibling = join(docs, "sibling.txt");
mkdirSync(docs, { recursive: true });
mkdirSync(join(home, ".ssh"), { recursive: true });
mkdirSync(join(home, ".psyche"), { recursive: true });
writeFileSync(report, "Q3 numbers");
writeFileSync(sibling, "not attached");
writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
writeFileSync(join(home, ".psyche", "vault.json"), "{}");
symlinkSync(join(home, ".ssh", "id_ed25519"), join(docs, "innocent.txt"));

const DAY = 24 * 60 * 60 * 1000;
let now: number;
let broker: PsychePermissionBroker;
let db: PsycheDb;
let threadA: string;
let threadB: string;
let sent: Record<string, unknown>[];

const tools = () =>
  Object.fromEntries(
    fileTools({
      folders: (scope) => [
        ...(broker.policy.folders ?? []),
        ...(scope === undefined ? [] : broker.sessionFolders(scope.threadId)),
      ],
    }).map((t) => [t.spec.name, t]),
  ) as Record<string, AgentToolRegistration>;

const readFile = (threadId: string, path: string) =>
  tools().read_file?.run?.({ path }, {
    signal: new AbortController().signal,
    taint: false,
    threadId,
  } as unknown as ToolRunContext) as Promise<{
    output: { text: string };
    provenance: string;
  }>;

const call = (over: { desktopShell?: true; loopback?: boolean } = {}): Call =>
  ({
    ctx: {
      db,
      chatFiles: {
        attach: (t: string, p: string[], by: { deviceId: string }) => broker.attachFiles(t, p, by),
        granted: (t: string) => [...(broker.policy.folders ?? []), ...broker.sessionFolders(t)],
      },
      sessions: {
        send: (input: Record<string, unknown>) => {
          sent.push(input);
          return { messageId: "msg_1", runId: null, queued: false };
        },
      },
    },
    identity: { deviceId: "dev_mac", role: "client", scopes: ["operator.admin"], ...over },
    conn: { peer: { remoteLoopback: over.loopback ?? true } },
    emit: () => {},
    afterCommit: () => {},
  }) as unknown as Call;
const desktop = () => call({ desktopShell: true });

type Handler = (c: Call, p: unknown) => unknown;
const handler = (name: string): Handler => {
  const h = chatHandlers[name];
  if (h === undefined) throw new Error(`no handler ${name}`);
  return h.run as Handler;
};

interface AttachResult {
  files: { path: string; name: string; size: number; type: string }[];
  refused: { path: string; reason: string }[];
}
const attach = async (threadId: string, paths: string[], c = desktop()) =>
  (await handler("chat.attachFiles")(c, { threadId, paths })) as AttachResult;

beforeEach(() => {
  now = Date.UTC(2026, 10, 18, 9, 0, 0);
  db = openDb(":memory:");
  threadA = createThread(db, { kind: "main", sessionKey: "owner:a" }).id;
  threadB = createThread(db, { kind: "main", sessionKey: "owner:b" }).id;
  sent = [];
  broker = createPermissionBroker({
    armDelayMs: 0,
    clock: { now: () => now },
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

describe("chat.attachFiles", () => {
  it("makes the attached file readable by read_file in that thread, as untrusted data", async () => {
    const res = await attach(threadA, [report]);
    expect(res.refused).toEqual([]);
    expect(res.files).toEqual([{ path: report, name: "report.txt", size: 10, type: "text/plain" }]);
    expect(Value.Check(ChatMethods["chat.attachFiles"].result, res)).toBe(true);
    const read = await readFile(threadA, report);
    expect(read.output.text).toBe("Q3 numbers");
    expect(read.provenance).toBe("untrusted");
  });

  it("does not open the sibling file in the same folder", async () => {
    await attach(threadA, [report]);
    await expect(readFile(threadA, sibling)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      readFile(threadA, join(docs, "..", "Documents", "sibling.txt")),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("is read-only and for that thread only", async () => {
    await attach(threadA, [report]);
    await expect(readFile(threadB, report)).rejects.toMatchObject({ code: "forbidden" });
    const write = tools().write_file?.run?.({ path: report, content: "x" }, {
      signal: new AbortController().signal,
      taint: false,
      threadId: threadA,
    } as unknown as ToolRunContext);
    await expect(write).rejects.toMatchObject({ code: "forbidden" });
    expect(broker.sessionFolders(threadA)).toEqual([{ path: report, mode: "ro" }]);
  });

  it("refuses a file under a sensitive root, including through a symlink", async () => {
    const res = await attach(threadA, [
      join(home, ".ssh", "id_ed25519"),
      join(home, ".psyche", "vault.json"),
      join(docs, "innocent.txt"),
    ]);
    expect(res.files).toEqual([]);
    expect(res.refused.map((r: { reason: string }) => r.reason)).toEqual([
      "sensitive",
      "sensitive",
      "sensitive",
    ]);
    expect(broker.sessionFolders(threadA)).toEqual([]);
    await expect(readFile(threadA, join(home, ".ssh", "id_ed25519"))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses a folder, a missing file and a relative path, and keeps the good ones", async () => {
    const res = await attach(threadA, [docs, join(docs, "gone.txt"), "report.txt", report]);
    expect(res.files.map((f: { path: string }) => f.path)).toEqual([report]);
    expect(res.refused.map((r: { reason: string }) => r.reason)).toEqual([
      "not_file",
      "missing",
      "not_file",
    ]);
  });

  it("ends after 24 hours", async () => {
    await attach(threadA, [report]);
    now += DAY - 1000;
    expect((await readFile(threadA, report)).output.text).toBe("Q3 numbers");
    now += 2000;
    await expect(readFile(threadA, report)).rejects.toMatchObject({ code: "forbidden" });
    expect(broker.sessionFolders(threadA)).toEqual([]);
  });

  it("ends with the thread", async () => {
    await attach(threadA, [report]);
    await broker.endSession(threadA);
    await expect(readFile(threadA, report)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("leaves a wider read-write folder alone instead of narrowing it", async () => {
    broker.setPolicy({ ...broker.policy, folders: [{ path: docs, mode: "rw" }] });
    await attach(threadA, [report]);
    expect(broker.sessionFolders(threadA)).toEqual([]);
    expect((await readFile(threadA, report)).output.text).toBe("Q3 numbers");
  });

  it("is for the desktop app on this Mac only", async () => {
    await expect(attach(threadA, [report], call())).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      attach(threadA, [report], call({ desktopShell: true, loopback: false })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(broker.sessionFolders(threadA)).toEqual([]);
  });
});

describe("chat.send attachedFiles", () => {
  const send = async (threadId: string, attachedFiles: { path: string }[]) =>
    handler("chat.send")(desktop(), {
      threadId,
      content: "summarise this",
      attachedFiles,
    });

  it("tells the agent name, size and type of exactly the attached files", async () => {
    await attach(threadA, [report]);
    await send(threadA, [{ path: report }]);
    const preamble = String(sent[0]?.preamble);
    expect(preamble).toContain(report);
    expect(preamble).toContain("report.txt, 10 bytes, text/plain");
    expect(preamble).toContain("read_file");
    expect(preamble).not.toContain("sibling");
    expect(sent[0]?.taintSources).toBeUndefined();
  });

  it("refuses a path nobody attached, another thread's file and an expired one", async () => {
    await expect(send(threadA, [{ path: report }])).rejects.toMatchObject({ code: "forbidden" });
    await attach(threadA, [report]);
    await expect(send(threadB, [{ path: report }])).rejects.toMatchObject({ code: "forbidden" });
    await expect(send(threadA, [{ path: sibling }])).rejects.toMatchObject({ code: "forbidden" });
    now += DAY + 1;
    await expect(send(threadA, [{ path: report }])).rejects.toMatchObject({ code: "forbidden" });
    expect(sent).toEqual([]);
  });
});
