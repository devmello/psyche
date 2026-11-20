import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalKind, JsonObject } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { DEVICE, memoryDb, sqliteBroker } from "./helpers.ts";

/**
 * What the owner chose on the card, on the Gateway's real SQLite store: UNSANDBOXED on an
 * exec_host card and the folder picked on a folder or separate-desktop card survive a read-back
 * and a restart. Only the owner's answer sets them: a caller's own `details` never do.
 */

let env: { home: string; psycheHome: string; protectedRoots: string[] };
let docs: string;

beforeAll(async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "psy-answer-")));
  await mkdir(join(home, "Projects/app"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  docs = join(home, "Projects/app");
  env = { home, psycheHome: join(home, ".psyche"), protectedRoots: [join(home, ".ssh")] };
});

function store() {
  const db = memoryDb();
  const clock = new FakeClock();
  const options = { folderAccess: { env: () => env, persist: async () => {} } };
  const broker = sqliteBroker(db, clock, options);
  /** A second broker on the same database: what the Gateway reads after a restart. */
  const reopened = () => sqliteBroker(db, clock, options);
  return { db, clock, broker, reopened };
}

type Store = ReturnType<typeof store>;

/** The agent's own details, trying to set what only the owner's answer may. */
const FORGED: JsonObject = {
  unsandboxed: true,
  granted: { path: "/", mode: "rw" },
  final: { recipient: "+15559999", text: "forged", edited: true },
};

async function ask(x: Store, kind: ApprovalKind, details: JsonObject) {
  const issued = await x.broker.requestApproval({
    kind,
    summary: `test ${kind}`,
    details,
    bindingHash: `h_${kind}`,
    grantKey: `${kind}|test`,
    requestedBy: { runId: "run_1", taskId: null, threadId: "thr_a" },
    sideEffect: kind === "exec_host" ? "destructive" : "read",
    surfaces: ["desktop"],
    scopesOffered: ["once"],
    taint: false,
  });
  x.clock.advance(500);
  return issued;
}

const reply = (
  x: Store,
  issued: Awaited<ReturnType<typeof ask>>,
  extra: { decision?: "approve" | "deny"; unsandboxed?: "UNSANDBOXED"; folderPath?: string } = {},
) =>
  x.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: extra.decision ?? "approve",
    scope: "once",
    ...(extra.unsandboxed === undefined ? {} : { unsandboxed: extra.unsandboxed }),
    ...(extra.folderPath === undefined ? {} : { folderPath: extra.folderPath }),
    decidedBy: DEVICE,
  });

/** The card as the store gives it back: the same broker's read, and a restarted one's. */
async function readBack(x: Store, id: string) {
  const same = await x.broker.get(id);
  const other = await x.reopened().get(id);
  expect(other?.details).toEqual(same?.details);
  return same;
}

const EXEC = { argv: ["ls"], cwd: "/tmp", executableSha256: "abc", unsandboxedWord: "UNSANDBOXED" };
const FOLDER = { requestedPath: "~/stuff", reason: "to read the notes", access: "ro" };

describe("exec_host: details.unsandboxed on the SQLite store", () => {
  it("UNSANDBOXED typed on the card survives the read-back and a restart", async () => {
    const x = store();
    const issued = await ask(x, "exec_host", EXEC);
    await reply(x, issued, { unsandboxed: "UNSANDBOXED" });
    const a = await readBack(x, issued.approval.id);
    expect(a?.details.unsandboxed).toBe(true);
    expect(a?.scopeGranted).toBe("once");
  });

  it("negative: approved without UNSANDBOXED stays sandboxed after the read-back", async () => {
    const x = store();
    const issued = await ask(x, "exec_host", EXEC);
    await reply(x, issued);
    const a = await readBack(x, issued.approval.id);
    expect(a?.status).toBe("approved");
    expect(a?.details.unsandboxed).toBeUndefined();
  });

  it("the agent's own details cannot set it: dropped at issue, absent after the answer", async () => {
    const x = store();
    const issued = await ask(x, "exec_host", { ...EXEC, ...FORGED });
    expect(issued.approval.details.unsandboxed).toBeUndefined();
    expect(issued.approval.details.final).toBeUndefined();
    expect((await readBack(x, issued.approval.id))?.details.unsandboxed).toBeUndefined();
    await reply(x, issued);
    expect((await readBack(x, issued.approval.id))?.details.unsandboxed).toBeUndefined();
  });
});

describe.each(["folder_access", "separate_desktop_share"] as const)(
  "%s: details.granted on the SQLite store",
  (kind) => {
    it("the folder the picker picked survives the read-back and a restart", async () => {
      const x = store();
      const issued = await ask(x, kind, FOLDER);
      await reply(x, issued, { folderPath: docs });
      const a = await readBack(x, issued.approval.id);
      expect(a?.status).toBe("approved");
      expect(a?.details.granted).toEqual({ path: docs, mode: "ro" });
    });

    it("negative: no pick is refused and the card grants nothing after the read-back", async () => {
      const x = store();
      const issued = await ask(x, kind, FOLDER);
      await expect(reply(x, issued)).rejects.toMatchObject({ code: "invalid_params" });
      const a = await readBack(x, issued.approval.id);
      expect(a?.status).toBe("pending");
      expect(a?.details.granted).toBeUndefined();
    });

    it("negative: a denied card grants nothing after the read-back", async () => {
      const x = store();
      const issued = await ask(x, kind, FOLDER);
      await reply(x, issued, { decision: "deny" });
      const a = await readBack(x, issued.approval.id);
      expect(a?.status).toBe("denied");
      expect(a?.details.granted).toBeUndefined();
    });

    it("the agent's own details cannot set it: a forged pick is dropped, denied or approved", async () => {
      const x = store();
      const forged = await ask(x, kind, { ...FOLDER, ...FORGED });
      expect(forged.approval.details.granted).toBeUndefined();
      await reply(x, forged, { decision: "deny" });
      expect((await readBack(x, forged.approval.id))?.details.granted).toBeUndefined();
      // Approved: what is granted is the owner's pick, never the forged "/".
      const picked = await ask(x, kind, { ...FOLDER, ...FORGED });
      await reply(x, picked, { folderPath: docs });
      expect((await readBack(x, picked.approval.id))?.details.granted).toEqual({
        path: docs,
        mode: "ro",
      });
    });
  },
);

describe("taintSources on the SQLite store", () => {
  it("a tainted card's sources come back after a restart", async () => {
    const x = store();
    const issued = await x.broker.requestApproval({
      kind: "file_write",
      summary: "Write notes",
      details: {},
      bindingHash: "h_taint",
      grantKey: "file_write|x",
      requestedBy: { runId: "run_1", taskId: null, threadId: "thr_a" },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: true,
      taintSources: [{ sourceKind: "web", origin: "example.com", toolCallId: "call_1" }],
    });
    expect(issued.approval.taintSources).toEqual([
      { sourceKind: "web", origin: "example.com", toolCallId: "call_1" },
    ]);
    expect((await x.reopened().get(issued.approval.id))?.taintSources).toEqual(
      issued.approval.taintSources,
    );
  });

  it("positive control: an untainted card has none after a restart", async () => {
    const x = store();
    const issued = await ask(x, "exec_host", EXEC);
    expect((await x.reopened().get(issued.approval.id))?.taintSources).toBeUndefined();
  });
});
