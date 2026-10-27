import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertFolderGrantable,
  type FolderGrantEntry,
  folderScopesOffered,
  type PolicyContext,
  refuseFolder,
  resolveFolderPick,
} from "../src/index.ts";
import { call, DEVICE, makeBroker, path } from "./helpers.ts";

/**
 * Folder access the agent asks for (security §3.5): the owner's pick is what is granted, `once`
 * lasts for the conversation, `always` is stored for Settings, taint allows `once` only, and
 * sensitive roots are refused after symlinks and `..` resolve.
 */

let home: string;
let psycheHome: string;
let env: { home: string; psycheHome: string; protectedRoots: string[] };
let docs: string;
let notes: string;

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psy-home-")));
  psycheHome = join(home, ".psyche");
  for (const d of ["Library/Mail", ".ssh", ".psyche/state", "Projects/app", "Documents/notes"]) {
    await mkdir(join(home, d), { recursive: true });
  }
  docs = join(home, "Projects/app");
  notes = join(home, "Documents/notes");
  env = { home, psycheHome, protectedRoots: [join(home, ".ssh")] };
});

describe("sensitive roots", () => {
  it("refuses /, the home root, ~/Library, ~/.ssh and ~/.psyche", async () => {
    for (const p of ["/", home, join(home, "Library"), join(home, ".ssh"), psycheHome]) {
      await expect(resolveFolderPick(p, env)).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(resolveFolderPick(join(home, "Library/Mail"), env)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(resolveFolderPick(join(psycheHome, "state"), env)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses an ancestor of a sensitive root (nothing broader than needed)", () => {
    expect(refuseFolder(home, env)).toBe("sensitive_root");
    expect(refuseFolder("/Users", env)).toBe("sensitive_root");
    expect(refuseFolder("/", env)).toBe("sensitive_root");
  });

  it("allows an ordinary folder inside home and returns its real path", async () => {
    expect(await resolveFolderPick(docs, env)).toBe(docs);
  });

  it("resolves .. before judging", async () => {
    expect(await resolveFolderPick(`${docs}/../..`, env).catch((e) => e.code)).toBe("forbidden");
    expect(await resolveFolderPick(`${docs}/../../Documents/notes`, env)).toBe(notes);
  });

  it("resolves a symlink before judging, so a link to ~/.ssh is refused", async () => {
    const link = join(home, "Projects/innocent");
    await symlink(join(home, ".ssh"), link);
    await expect(resolveFolderPick(link, env)).rejects.toMatchObject({ code: "forbidden" });
    const ok = join(home, "Projects/alias");
    await symlink(docs, ok);
    expect(await resolveFolderPick(ok, env)).toBe(docs);
  });

  it("refuses files, missing paths and relative paths", async () => {
    await expect(resolveFolderPick(join(home, "nope"), env)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(resolveFolderPick("Projects", env)).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("the Settings path applies the same rule", async () => {
    await expect(assertFolderGrantable(home, env)).rejects.toMatchObject({ code: "forbidden" });
    await expect(assertFolderGrantable("~/.ssh", env)).rejects.toMatchObject({ code: "forbidden" });
    await expect(assertFolderGrantable(docs, env)).resolves.toBeUndefined();
  });
});

const ctx = (taint = false, threadId = "thr_a"): PolicyContext => ({
  threadId,
  runId: "run_1",
  permissionMode: "balanced",
  taint,
  ...(taint ? { taintSources: [{ sourceKind: "web" }] } : {}),
});

function harness() {
  const persisted: FolderGrantEntry[] = [];
  const h = makeBroker({
    folderAccess: {
      env: () => env,
      persist: async (e) => void persisted.push(e),
    },
  });
  return { ...h, persisted };
}

async function ask(h: ReturnType<typeof harness>, c: PolicyContext, access: "ro" | "rw" = "ro") {
  const issued = await h.broker.requestApproval({
    kind: "folder_access",
    summary: "Share a folder: ~/stuff",
    details: { requestedPath: "~/stuff", reason: "to read the notes", access },
    bindingHash: `h${Math.random()}`.replace(".", "") as never,
    grantKey: `folder_access|${access}`,
    requestedBy: { runId: c.runId, taskId: null, threadId: c.threadId },
    sideEffect: access === "rw" ? "write" : "read",
    surfaces: ["desktop"],
    scopesOffered: folderScopesOffered(c.taint),
    taint: c.taint,
  });
  h.clock.advance(500);
  return issued;
}

const answer = (
  h: ReturnType<typeof harness>,
  issued: Awaited<ReturnType<typeof ask>>,
  scope: "once" | "always",
  folderPath?: string,
) =>
  h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope,
    ...(folderPath === undefined ? {} : { folderPath }),
    decidedBy: DEVICE,
  });

const read = (p: string, c: PolicyContext) =>
  h0.broker.decide(call("read_file", "read", path(p)), c);
let h0: ReturnType<typeof harness>;

describe("grant flow", () => {
  it("is device-only and offers once and always when clean", async () => {
    const h = harness();
    const issued = await ask(h, ctx());
    expect(issued.approval.deviceOnly).toBe(true);
    expect(issued.approval.scopesOffered).toEqual(["once", "always"]);
  });

  it("once: the pick (not the agent's string) is allowed in that conversation only", async () => {
    h0 = harness();
    const c = ctx();
    expect((await read(`${docs}/a.txt`, c)).rule).toBe("folder:not_granted");
    const done = await answer(h0, await ask(h0, c), "once", docs);
    expect(done.status).toBe("approved");
    expect(done.details.granted).toEqual({ path: docs, mode: "ro" });
    expect((await read(`${docs}/a.txt`, c)).decision).toBe("allow");
    // Another conversation, and a sibling folder, stay out.
    expect((await read(`${docs}/a.txt`, ctx(false, "thr_b"))).rule).toBe("folder:not_granted");
    expect((await read(`${notes}/a.txt`, c)).rule).toBe("folder:not_granted");
    expect(h0.persisted).toEqual([]);
    // /new ends it.
    await h0.broker.endSession("thr_a");
    expect((await read(`${docs}/a.txt`, c)).rule).toBe("folder:not_granted");
  });

  it("read-only picks refuse writes; read-write picks allow them", async () => {
    h0 = harness();
    const c = ctx();
    await answer(h0, await ask(h0, c, "ro"), "once", docs);
    const w = (p: string) => h0.broker.decide(call("write_file", "write", path(p)), c);
    expect((await w(`${docs}/a.txt`)).rule).toBe("folder:read_only");
    await answer(h0, await ask(h0, c, "rw"), "once", notes);
    expect((await w(`${notes}/a.txt`)).rule).not.toBe("folder:read_only");
    expect((await w(`${notes}/a.txt`)).decision).not.toBe("deny");
  });

  it("always: stores exactly the picked folder for Settings and does not end with the thread", async () => {
    h0 = harness();
    const c = ctx();
    const done = await answer(h0, await ask(h0, c), "always", docs);
    expect(done.scopeGranted).toBe("always");
    expect(h0.persisted).toEqual([{ path: docs, mode: "ro" }]);
    // Never a parent of the pick.
    expect(h0.persisted.every((f) => f.path === docs)).toBe(true);
  });

  it("an always pick applies once the policy carries it, and revoking removes access", async () => {
    h0 = harness();
    const c = ctx();
    h0.broker.setPolicy({ ...h0.broker.policy, folders: [{ path: docs, mode: "ro" }] });
    expect((await read(`${docs}/a.txt`, c)).decision).toBe("allow");
    h0.broker.setPolicy({ ...h0.broker.policy, folders: [] });
    expect((await read(`${docs}/a.txt`, c)).rule).toBe("folder:not_granted");
  });

  it("a sensitive pick is refused and the card stays pending", async () => {
    h0 = harness();
    const issued = await ask(h0, ctx());
    await expect(answer(h0, issued, "once", home)).rejects.toMatchObject({ code: "forbidden" });
    expect((await h0.broker.get(issued.approval.id))?.status).toBe("pending");
    const retry = await answer(h0, issued, "once", docs);
    expect(retry.status).toBe("approved");
  });

  it("approving without a pick is rejected", async () => {
    h0 = harness();
    const issued = await ask(h0, ctx());
    await expect(answer(h0, issued, "once")).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("deny grants nothing", async () => {
    h0 = harness();
    const c = ctx();
    const issued = await ask(h0, c);
    await h0.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "deny",
      decidedBy: DEVICE,
    });
    expect((await read(`${docs}/a.txt`, c)).rule).toBe("folder:not_granted");
    expect(h0.persisted).toEqual([]);
  });
});

describe("taint", () => {
  it("offers once only, and an always answer is rejected", async () => {
    const h = harness();
    const issued = await ask(h, ctx(true));
    expect(issued.approval.scopesOffered).toEqual(["once"]);
    await expect(answer(h, issued, "always", docs)).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(h.persisted).toEqual([]);
    expect((await answer(h, issued, "once", docs)).scopeGranted).toBe("once");
  });

  it("the broker narrows the scopes itself even if the caller offered always", async () => {
    const h = harness();
    const c = ctx(true);
    const issued = await h.broker.requestApproval({
      kind: "folder_access",
      summary: "Share a folder",
      details: { requestedPath: "~/x", reason: "r", access: "ro" },
      bindingHash: "hh1" as never,
      grantKey: "folder_access|ro",
      requestedBy: { runId: c.runId, taskId: null, threadId: c.threadId },
      sideEffect: "read",
      surfaces: ["desktop"],
      scopesOffered: ["once", "always"],
      taint: true,
    });
    expect(issued.approval.scopesOffered).toEqual(["once"]);
  });
});
