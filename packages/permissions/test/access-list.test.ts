import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  accessEntries,
  type Caller,
  createPermissionHandlers,
  type FolderGrantEntry,
  folderCovers,
  resolveRequestedFolder,
  revokeAccess,
} from "../src/index.ts";
import { call, DEVICE, makeBroker, path } from "./helpers.ts";

/**
 * "The agent asks, the owner answers once, it is remembered": what covers a later request, what the
 * card pre-fills, how the owner narrows a grant, and the access list with its revoke (the folders
 * Settings shows, kept until revoked or for one chat).
 */

let home: string;
let project: string;
let notes: string;
let env: { home: string; psycheHome: string; protectedRoots: string[] };

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psy-acc-")));
  for (const d of [".ssh", ".psyche", "Projects/app/src", "Documents/notes"]) {
    await mkdir(join(home, d), { recursive: true });
  }
  project = join(home, "Projects/app");
  notes = join(home, "Documents/notes");
  await writeFile(join(project, "readme.md"), "hi");
  env = { home, psycheHome: join(home, ".psyche"), protectedRoots: [join(home, ".ssh")] };
});

describe("folderCovers: never ask twice for the same scope", () => {
  const grants: FolderGrantEntry[] = [
    { path: "/Users/o/Projects", mode: "rw" },
    { path: "/Users/o/Projects/ro", mode: "ro" },
    { path: "/Users/o/Docs", mode: "ro" },
  ];

  it("a granted folder covers itself, what is under it and a file that does not exist yet", () => {
    expect(folderCovers(grants, "/Users/o/Projects", "ro")?.path).toBe("/Users/o/Projects");
    expect(folderCovers(grants, "/Users/o/Projects/app/src/a.ts", "rw")?.path).toBe(
      "/Users/o/Projects",
    );
  });

  it("does not cover a sibling, a parent or a lookalike prefix", () => {
    expect(folderCovers(grants, "/Users/o/Other", "ro")).toBeUndefined();
    expect(folderCovers(grants, "/Users/o", "ro")).toBeUndefined();
    expect(folderCovers(grants, "/Users/o/Projects-old", "ro")).toBeUndefined();
  });

  it("a read-only grant covers a read but not a write; the longest root decides", () => {
    expect(folderCovers(grants, "/Users/o/Docs/x", "ro")?.mode).toBe("ro");
    expect(folderCovers(grants, "/Users/o/Docs/x", "rw")).toBeUndefined();
    // A read-only folder inside a read-write one is read-only there.
    expect(folderCovers(grants, "/Users/o/Projects/ro/x", "rw")).toBeUndefined();
    expect(folderCovers(grants, "/Users/o/Projects/ro/x", "ro")?.path).toBe("/Users/o/Projects/ro");
  });
});

describe("the folder the card pre-fills", () => {
  it("a file is shown as its folder (a denied read of readme.md asks for the folder)", async () => {
    expect(await resolveRequestedFolder(join(project, "readme.md"), env)).toEqual({
      status: "ok",
      path: project,
    });
  });

  it("a file that does not exist yet is shown as the folder it would be created in", async () => {
    expect(await resolveRequestedFolder(join(project, "src/new.ts"), env)).toEqual({
      status: "ok",
      path: join(project, "src"),
    });
  });

  it("a path with no existing folder above it is left to the picker; a sensitive root stays blocked", async () => {
    expect(await resolveRequestedFolder(join(home, "nope/deeper/file.txt"), env)).toEqual({
      status: "missing",
    });
    expect((await resolveRequestedFolder(join(home, ".ssh/config"), env)).status).toBe("blocked");
  });
});

function harness() {
  const persisted: FolderGrantEntry[] = [];
  const h = makeBroker({
    folderAccess: {
      env: () => env,
      persist: async (e) => void persisted.push(e),
      remove: async (p) => {
        const before = h.broker.policy.folders?.length ?? 0;
        h.broker.setPolicy({
          ...h.broker.policy,
          folders: (h.broker.policy.folders ?? []).filter((f) => f.path !== p),
        });
        return (h.broker.policy.folders?.length ?? 0) < before;
      },
    },
  });
  return { ...h, persisted };
}

async function ask(h: ReturnType<typeof harness>, access: "ro" | "rw", threadId = "thr_a") {
  const issued = await h.broker.requestApproval({
    kind: "folder_access",
    summary: "Share a folder: ~/Projects/app",
    details: { requestedPath: "~/Projects/app", reason: "to read the notes", access },
    bindingHash: `h${Math.random()}`.replace(".", "") as never,
    grantKey: `folder_access|${access}`,
    requestedBy: { runId: "run_1", taskId: null, threadId },
    sideEffect: access === "rw" ? "write" : "read",
    surfaces: ["desktop"],
    scopesOffered: ["once", "always"],
    taint: false,
  });
  h.clock.advance(500);
  return issued;
}

const answer = (
  h: ReturnType<typeof harness>,
  issued: Awaited<ReturnType<typeof ask>>,
  scope: "once" | "always",
  folderPath: string,
  folderMode?: "ro",
) =>
  h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope,
    folderPath,
    ...(folderMode === undefined ? {} : { folderMode }),
    decidedBy: DEVICE,
  });

describe("read-only or read-write: the owner can narrow a request, never widen it", () => {
  it("a write request answered read-only grants read-only, and writes are refused", async () => {
    const h = harness();
    const done = await answer(h, await ask(h, "rw"), "once", project, "ro");
    expect(done.details.granted).toEqual({ path: project, mode: "ro" });
    const c = { threadId: "thr_a", runId: "run_1", permissionMode: "balanced", taint: false };
    const w = await h.broker.decide(
      call("write_file", "write", path(`${project}/a.txt`)),
      c as never,
    );
    expect(w.rule).toBe("folder:read_only");
  });

  it("without the narrowing, a write request is granted read-write", async () => {
    const h = harness();
    const done = await answer(h, await ask(h, "rw"), "once", project);
    expect(done.details.granted).toEqual({ path: project, mode: "rw" });
  });

  it("a read request stays read-only whatever the answer carries", async () => {
    const h = harness();
    const done = await answer(h, await ask(h, "ro"), "always", project);
    expect(done.details.granted).toEqual({ path: project, mode: "ro" });
    expect(h.persisted).toEqual([{ path: project, mode: "ro" }]);
  });
});

describe("the access list and its revoke", () => {
  const caller: Caller = {
    deviceId: "dev_mac",
    scopes: ["operator.read", "operator.admin"],
    surface: "desktop",
  };

  it("lists folders kept until revoked and folders for one chat, and revokes each at once", async () => {
    const h = harness();
    h.broker.setPolicy({ ...h.broker.policy, folders: [{ path: notes, mode: "ro" }] });
    await answer(h, await ask(h, "rw", "thr_a"), "once", project);

    const entries = await accessEntries(h.broker);
    expect(entries.map((e) => [e.type, e.scope, e.path, e.mode])).toEqual([
      ["folder", "always", notes, "ro"],
      ["folder", "conversation", project, "rw"],
    ]);
    expect(entries[1]?.threadId).toBe("thr_a");

    const c = { threadId: "thr_a", runId: "run_1", permissionMode: "balanced", taint: false };
    const read = (p: string) => h.broker.decide(call("read_file", "read", path(p)), c as never);
    expect((await read(`${notes}/a.md`)).decision).toBe("allow");
    expect((await read(`${project}/a.md`)).decision).toBe("allow");

    // Revoking takes effect on the next call, with no restart.
    expect(await revokeAccess(h.broker, entries[0]?.id ?? "")).toBe(true);
    expect(await revokeAccess(h.broker, entries[1]?.id ?? "")).toBe(true);
    expect((await read(`${notes}/a.md`)).rule).toBe("folder:not_granted");
    expect((await read(`${project}/a.md`)).rule).toBe("folder:not_granted");
    expect(await accessEntries(h.broker)).toEqual([]);
    // Already gone: nothing to revoke, no error.
    expect(await revokeAccess(h.broker, entries[0]?.id ?? "")).toBe(false);
  });

  it("the protocol methods need their scopes and refuse an unknown entry", async () => {
    const h = harness();
    const handlers = createPermissionHandlers(h.broker, h.audit);
    await expect(handlers["access.list"]({}, { ...caller, scopes: [] })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      handlers["access.revoke"](
        { entryId: "folder:always:/x" },
        { ...caller, scopes: ["operator.read"] },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(handlers["access.revoke"]({ entryId: "nonsense" }, caller)).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(await handlers["access.list"]({}, caller)).toEqual({ entries: [] });
  });
});
