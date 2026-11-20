import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Requester } from "@psyche/protocol";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessEntries,
  FOLDER_FRESH_MS,
  type FolderGrantEntry,
  folderScopesOffered,
  type PolicyContext,
  revokeAccess,
  type SpaceFolderRecord,
  type SpaceFolderSource,
  spaceFolderMode,
  type ThreadSpace,
} from "../src/index.ts";
import { call, DEVICE, makeBroker, path } from "./helpers.ts";

/**
 * Spaces wave S2 (docs/design/spaces-2026.md §5.3, SR2–SR4, SR11, SR14): the third folder scope.
 * A Space folder works only in the runs of its own Space, under every folder refusal, read-only
 * for automations unless the owner turned on "Automations may change files here", fixed per run,
 * and stops at once when removed or when its Space is archived or deleted.
 */

const WIN = process.platform === "win32";

let home: string;
let projects: string;
let kitchen: string;
let jobs: string;
let env: { home: string; psycheHome: string; protectedRoots: string[] };

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psy-spf-")));
  projects = join(home, "Projects");
  kitchen = join(projects, "kitchen");
  jobs = join(projects, "jobs");
  for (const d of [
    ".ssh",
    ".psyche",
    "Projects/kitchen/plans",
    "Projects/kitchen-old",
    "Projects/kitchen2",
    "Projects/jobs",
    "Projects/elsewhere",
  ]) {
    await mkdir(join(home, d), { recursive: true });
  }
  env = { home, psycheHome: join(home, ".psyche"), protectedRoots: [join(home, ".ssh")] };
});

/** An in-memory `space_folders` with the Gateway's rules: archived Spaces have no folders. */
class FakeSpaces implements SpaceFolderSource {
  spaces = new Map<string, { name: string; archived: boolean }>([
    ["spc_kitchen", { name: "Kitchen remodel", archived: false }],
    ["spc_jobs", { name: "Job search", archived: false }],
  ]);
  threads = new Map<string, ThreadSpace | undefined>();
  rows: SpaceFolderRecord[] = [];
  added: { spaceId: string; path: string; mode: string }[] = [];
  /** Throws from `folders` / `all` (a broken store must fail closed). */
  broken = false;

  constructor() {
    this.threads.set("thr_kitchen", { spaceId: "spc_kitchen", spaceName: "Kitchen remodel" });
    this.threads.set("thr_kitchen_auto", {
      spaceId: "spc_kitchen",
      spaceName: "Kitchen remodel",
    });
    this.threads.set("thr_jobs", { spaceId: "spc_jobs", spaceName: "Job search" });
    this.threads.set("thr_sub", { parentThreadId: "thr_kitchen" });
    // The main chat and a chat outside any Space are in none.
    this.threads.set("thr_main", undefined);
    this.threads.set("thr_side", undefined);
  }

  folder(spaceId: string, p: string, mode: "ro" | "rw", automationsWrite = false): void {
    const name = this.spaces.get(spaceId)?.name ?? "";
    this.rows.push({ spaceId, spaceName: name, path: p, real: p, mode, automationsWrite });
  }

  #live(): SpaceFolderRecord[] {
    if (this.broken) throw new Error("db gone");
    return this.rows.filter((r) => this.spaces.get(r.spaceId)?.archived === false);
  }

  spaceOf(threadId: string): ThreadSpace | undefined {
    const t = this.threads.get(threadId);
    if (t === undefined || "parentThreadId" in t) return t;
    return this.spaces.get(t.spaceId)?.archived === false ? t : undefined;
  }

  folders(spaceId: string): readonly SpaceFolderRecord[] {
    return this.#live().filter((r) => r.spaceId === spaceId);
  }

  all(): readonly SpaceFolderRecord[] {
    return this.#live();
  }

  add(spaceId: string, entry: { path: string; real: string; mode: "ro" | "rw" }): void {
    const s = this.spaces.get(spaceId);
    if (s === undefined || s.archived) throw new Error("that Space is archived or gone");
    this.added.push({ spaceId, path: entry.path, mode: entry.mode });
    this.rows = this.rows.filter((r) => !(r.spaceId === spaceId && r.path === entry.path));
    this.rows.push({
      spaceId,
      spaceName: s.name,
      path: entry.path,
      real: entry.real,
      mode: entry.mode,
      automationsWrite: false,
    });
  }

  remove(spaceId: string, p: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.spaceId === spaceId && r.path === p));
    return this.rows.length < before;
  }
}

let spaces: FakeSpaces;
let persisted: FolderGrantEntry[];

function harness() {
  persisted = [];
  return makeBroker({
    folderAccess: { env: () => env, persist: async (e) => void persisted.push(e) },
    hostProgram: { home },
    psycheHome: env.psycheHome,
    spaces,
  });
}

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  spaces = new FakeSpaces();
  spaces.folder("spc_kitchen", kitchen, "rw");
  spaces.folder("spc_jobs", jobs, "ro");
  h = harness();
  await h.broker.foldersSettled();
});

const ctx = (
  threadId: string,
  over: Partial<PolicyContext> & { requester?: Requester } = {},
): PolicyContext => ({
  threadId,
  runId: `run_${threadId}`,
  permissionMode: "balanced",
  taint: false,
  ...over,
});

const read = (p: string, c: PolicyContext) =>
  h.broker.decide(call("read_file", "read", path(p)), c);
const write = (p: string, c: PolicyContext) =>
  h.broker.decide(call("write_file", "write", path(p)), c);

/** Whether the folder rules let the call through (it may still ask for the mode's own reasons). */
const passesFolders = (d: { decision: string; rule: string }) =>
  d.decision !== "deny" &&
  !d.rule.startsWith("folder:not_granted") &&
  d.rule !== "folder:read_only";

describe("spaceFolderMode: what an automation may do in a Space folder (SP8)", () => {
  it.each([
    ["chat, rw folder", "rw", false, false, "rw"],
    ["chat, ro folder", "ro", false, false, "ro"],
    ["chat, rw folder, flag on", "rw", true, false, "rw"],
    ["automation, rw folder, flag off", "rw", false, true, "ro"],
    ["automation, rw folder, flag on", "rw", true, true, "rw"],
    // The flag never widens a read-only folder.
    ["automation, ro folder, flag on", "ro", true, true, "ro"],
    ["chat, ro folder, flag on", "ro", true, false, "ro"],
  ] as const)("%s", (_l, mode, automationsWrite, unattended, want) => {
    expect(spaceFolderMode({ mode, automationsWrite }, unattended)).toBe(want);
  });
});

describe("who may use a Space folder (table)", () => {
  const MUST_ALLOW: [string, () => Promise<{ decision: string; rule: string }>][] = [
    [
      "a chat in the Space reads the folder",
      () => read(join(kitchen, "a.txt"), ctx("thr_kitchen")),
    ],
    [
      "a chat in the Space reads deep inside it",
      () => read(join(kitchen, "plans", "tile.pdf"), ctx("thr_kitchen")),
    ],
    [
      "a chat in the Space writes in a read & write folder",
      () => write(join(kitchen, "notes.md"), ctx("thr_kitchen")),
    ],
    [
      "the Space's automation reads the folder",
      () => read(join(kitchen, "a.txt"), ctx("thr_kitchen_auto", { unattended: true })),
    ],
    [
      "a subagent of the Space's chat reads the folder",
      async () => {
        await read(join(kitchen, "a.txt"), ctx("thr_kitchen"));
        return read(join(kitchen, "a.txt"), ctx("thr_sub"));
      },
    ],
    ["another Space reads its own folder", () => read(join(jobs, "cv.pdf"), ctx("thr_jobs"))],
  ];

  const NEAR_MISSES: [string, () => Promise<{ decision: string; rule: string }>, string][] = [
    [
      "another Space's run",
      () => read(join(kitchen, "a.txt"), ctx("thr_jobs")),
      "folder:not_granted",
    ],
    ["the main chat", () => read(join(kitchen, "a.txt"), ctx("thr_main")), "folder:not_granted"],
    [
      "a chat in no Space",
      () => read(join(kitchen, "a.txt"), ctx("thr_side")),
      "folder:not_granted",
    ],
    [
      "an unknown thread",
      () => read(join(kitchen, "a.txt"), ctx("thr_nobody")),
      "folder:not_granted",
    ],
    [
      "an automation writing without the flag",
      () => write(join(kitchen, "a.txt"), ctx("thr_kitchen_auto", { unattended: true })),
      "folder:read_only",
    ],
    [
      "a chat writing in a read-only Space folder",
      () => write(join(jobs, "cv.pdf"), ctx("thr_jobs")),
      "folder:read_only",
    ],
    [
      "a sibling folder",
      () => read(join(projects, "elsewhere", "a.txt"), ctx("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "the parent folder",
      () => read(join(projects, "a.txt"), ctx("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a lookalike prefix (kitchen-old)",
      () => read(join(projects, "kitchen-old", "a.txt"), ctx("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a lookalike suffix (kitchen2)",
      () => read(join(projects, "kitchen2", "a.txt"), ctx("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a lookalike letter (Cyrillic о in kitchen)",
      () => read(join(projects, "kitchеn", "a.txt"), ctx("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a dot-dot escape from the folder",
      () => read(`${kitchen}/../elsewhere/a.txt`, ctx("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a subagent whose parent works in no Space",
      async () => {
        spaces.threads.set("thr_sub2", { parentThreadId: "thr_main" });
        await read(join(kitchen, "a.txt"), ctx("thr_main"));
        return read(join(kitchen, "a.txt"), ctx("thr_sub2"));
      },
      "folder:not_granted",
    ],
  ];

  it.each(MUST_ALLOW)("allows: %s", async (_label, run) => {
    expect(passesFolders(await run())).toBe(true);
  });

  it.each(NEAR_MISSES)("refuses: %s", async (_label, run, rule) => {
    expect(await run()).toMatchObject({ decision: "deny", rule });
  });

  it("a channel contact in the Space's chat gets no Space and no Space folders (SR11)", async () => {
    const peer = ctx("thr_kitchen", {
      requester: { role: "allowed", channel: "telegram", senderId: "42" },
    });
    expect((await read(join(kitchen, "a.txt"), peer)).decision).toBe("deny");
    expect(h.broker.runSpace("thr_kitchen")).toBeUndefined();
    expect(h.broker.liveSessionFolders("thr_kitchen")).toEqual([]);
  });

  it("an automation writes where the owner turned on Automations may change files here", async () => {
    spaces.rows = spaces.rows.map((r) =>
      r.path === kitchen ? { ...r, automationsWrite: true } : r,
    );
    const d = await write(join(kitchen, "a.txt"), ctx("thr_kitchen_auto", { unattended: true }));
    expect(passesFolders(d)).toBe(true);
  });

  it("a subagent of the Space's automation is read-only there too", async () => {
    spaces.threads.set("thr_auto_sub", { parentThreadId: "thr_kitchen_auto" });
    await read(join(kitchen, "a.txt"), ctx("thr_kitchen_auto", { unattended: true }));
    const d = await write(join(kitchen, "a.txt"), ctx("thr_auto_sub"));
    expect(d).toMatchObject({ decision: "deny", rule: "folder:read_only" });
  });

  it("the file tools see the same folders as the engine (liveSessionFolders)", async () => {
    await read(join(kitchen, "a.txt"), ctx("thr_kitchen"));
    await read(join(kitchen, "a.txt"), ctx("thr_jobs"));
    await read(join(kitchen, "a.txt"), ctx("thr_main"));
    await read(join(kitchen, "a.txt"), ctx("thr_kitchen_auto", { unattended: true }));
    expect(h.broker.liveSessionFolders("thr_kitchen")).toEqual([
      { path: kitchen, mode: "rw", real: kitchen },
    ]);
    expect(h.broker.liveSessionFolders("thr_jobs")).toEqual([
      { path: jobs, mode: "ro", real: jobs },
    ]);
    expect(h.broker.liveSessionFolders("thr_main")).toEqual([]);
    expect(h.broker.liveSessionFolders("thr_kitchen_auto")).toEqual([
      { path: kitchen, mode: "ro", real: kitchen },
    ]);
  });

  it("a Space folder only adds: a Settings folder that covers it keeps its own mode", async () => {
    h.broker.setPolicy({ ...h.broker.policy, folders: [{ path: projects, mode: "rw" }] });
    await h.broker.foldersSettled();
    // The automation's read-only view of the kitchen does not narrow the owner's own grant.
    const d = await write(join(kitchen, "a.txt"), ctx("thr_kitchen_auto", { unattended: true }));
    expect(passesFolders(d)).toBe(true);
    expect(h.broker.liveSessionFolders("thr_kitchen_auto")).toEqual([]);
  });

  it("a store that throws gives no Space folders (fail closed)", async () => {
    spaces.broken = true;
    expect(await read(join(kitchen, "a.txt"), ctx("thr_kitchen"))).toMatchObject({
      decision: "deny",
      rule: "folder:not_granted",
    });
  });
});

describe("the Space is fixed per run (SR3)", () => {
  it("a chat moved to another Space keeps its run's folders until its next run", async () => {
    const run1 = ctx("thr_kitchen", { runId: "run_1" });
    expect(passesFolders(await read(join(kitchen, "a.txt"), run1))).toBe(true);
    spaces.threads.set("thr_kitchen", { spaceId: "spc_jobs", spaceName: "Job search" });
    // Same run: still the kitchen, never the new Space's folders.
    expect(passesFolders(await read(join(kitchen, "a.txt"), run1))).toBe(true);
    expect((await read(join(jobs, "a.txt"), run1)).rule).toBe("folder:not_granted");
    // Next run: the new Space only.
    const run2 = ctx("thr_kitchen", { runId: "run_2" });
    expect((await read(join(kitchen, "a.txt"), run2)).rule).toBe("folder:not_granted");
    expect(passesFolders(await read(join(jobs, "a.txt"), run2))).toBe(true);
  });

  it("a chat moved into a Space mid-run gets nothing from it until its next run", async () => {
    const run1 = ctx("thr_side", { runId: "run_1" });
    await read(join(kitchen, "a.txt"), run1);
    spaces.threads.set("thr_side", { spaceId: "spc_kitchen", spaceName: "Kitchen remodel" });
    expect((await write(join(kitchen, "a.txt"), run1)).rule).toBe("folder:not_granted");
    const run2 = ctx("thr_side", { runId: "run_2" });
    expect(passesFolders(await write(join(kitchen, "a.txt"), run2))).toBe(true);
  });
});

describe("revoked at once (SR14)", () => {
  it("removing the folder stops it on the next call of the same run", async () => {
    const c = ctx("thr_kitchen");
    expect(passesFolders(await read(join(kitchen, "a.txt"), c))).toBe(true);
    expect(await h.broker.revokeSpaceFolder("spc_kitchen", kitchen)).toBe(true);
    expect((await read(join(kitchen, "a.txt"), c)).rule).toBe("folder:not_granted");
    expect(h.broker.liveSessionFolders("thr_kitchen")).toEqual([]);
  });

  it("archiving the Space stops its folders in a running run", async () => {
    const c = ctx("thr_kitchen");
    expect(passesFolders(await read(join(kitchen, "a.txt"), c))).toBe(true);
    const k = spaces.spaces.get("spc_kitchen");
    if (k !== undefined) k.archived = true;
    h.broker.spaceFoldersChanged();
    expect((await read(join(kitchen, "a.txt"), c)).rule).toBe("folder:not_granted");
    expect(h.broker.liveSessionFolders("thr_kitchen")).toEqual([]);
    expect(h.broker.allSpaceFolders().some((f) => f.spaceId === "spc_kitchen")).toBe(false);
    // The next run of the chat is in no Space at all.
    expect(h.broker.runSpace("thr_kitchen")?.spaceId).toBe("spc_kitchen");
    await read(join(kitchen, "a.txt"), ctx("thr_kitchen", { runId: "run_next" }));
    expect(h.broker.runSpace("thr_kitchen")).toBeUndefined();
  });

  it("deleting the Space stops its folders", async () => {
    const c = ctx("thr_kitchen");
    await read(join(kitchen, "a.txt"), c);
    spaces.spaces.delete("spc_kitchen");
    spaces.rows = spaces.rows.filter((r) => r.spaceId !== "spc_kitchen");
    expect((await read(join(kitchen, "a.txt"), c)).rule).toBe("folder:not_granted");
  });
});

describe.skipIf(WIN)("refusals hold for Space folders (SR2)", () => {
  it("a root swapped for a link after the grant is refused by the next look", async () => {
    const root = join(projects, "swap-root");
    await mkdir(root, { recursive: true });
    spaces.folder("spc_kitchen", root, "rw");
    const c = ctx("thr_kitchen");
    expect(passesFolders(await read(join(root, "a.txt"), c))).toBe(true);
    await rm(root, { recursive: true });
    await symlink(join(projects, "elsewhere"), root);
    h.clock.advance(FOLDER_FRESH_MS + 1);
    h.broker.liveSessionFolders("thr_kitchen");
    await h.broker.foldersSettled();
    expect(await read(join(root, "a.txt"), c)).toMatchObject({
      decision: "deny",
      rule: "folder:not_granted",
    });
    expect(h.broker.allSpaceFolders().find((f) => f.path === root)?.refused).toBe(true);
    // A link to a sensitive root is refused the same way.
    await rm(root);
    await symlink(join(home, ".ssh"), root);
    h.clock.advance(FOLDER_FRESH_MS + 1);
    h.broker.liveSessionFolders("thr_kitchen");
    await h.broker.foldersSettled();
    expect((await read(join(root, "id_ed25519"), c)).rule).toBe("folder:not_granted");
  });

  it("a parent swapped for a link (the root's real path moved) is refused", async () => {
    const parent = join(home, "Swapped");
    const root = join(parent, "proj");
    await mkdir(root, { recursive: true });
    await mkdir(join(home, "Decoy", "proj"), { recursive: true });
    spaces.folder("spc_kitchen", root, "rw");
    const c = ctx("thr_kitchen");
    expect(passesFolders(await read(join(root, "a.txt"), c))).toBe(true);
    await rename(parent, join(home, "Swapped-orig"));
    await symlink(join(home, "Decoy"), parent);
    h.clock.advance(FOLDER_FRESH_MS + 1);
    h.broker.liveSessionFolders("thr_kitchen");
    await h.broker.foldersSettled();
    expect((await read(join(root, "a.txt"), c)).rule).toBe("folder:not_granted");
  });

  it("a stored Space folder at a sensitive root covers nothing", async () => {
    spaces.folder("spc_kitchen", join(home, ".ssh"), "ro");
    spaces.folder("spc_kitchen", home, "ro");
    const c = ctx("thr_kitchen");
    expect((await read(join(home, ".ssh", "id_ed25519"), c)).rule).toBe("folder:not_granted");
    expect((await read(join(home, "notes.txt"), c)).rule).toBe("folder:not_granted");
  });
});

describe('the "Allow in this Space" card', () => {
  async function ask(c: PolicyContext, over: { details?: Record<string, unknown> } = {}) {
    // The run's first call binds its Space, as the loop's tool calls do.
    await read(join(kitchen, "a.txt"), c);
    const issued = await h.broker.requestApproval({
      kind: "folder_access",
      summary: "Share a folder: ~/Projects/elsewhere",
      details: {
        requestedPath: "~/Projects/elsewhere",
        reason: "plans",
        access: "rw",
        ...over.details,
      },
      bindingHash: `h${Math.random()}`.replace(".", "") as never,
      grantKey: "folder_access|rw",
      requestedBy: { runId: c.runId, taskId: null, threadId: c.threadId },
      sideEffect: "write",
      surfaces: ["desktop"],
      scopesOffered: folderScopesOffered(c.taint),
      taint: c.taint,
      context: c,
    });
    h.clock.advance(500);
    return issued;
  }

  const answer = (
    issued: Awaited<ReturnType<typeof ask>>,
    extra: { scope?: "once" | "always"; inSpace?: true; folderPath?: string } = {},
  ) =>
    h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: extra.scope ?? "once",
      folderPath: extra.folderPath ?? join(projects, "elsewhere"),
      ...(extra.inSpace === undefined ? {} : { inSpace: extra.inSpace }),
      decidedBy: DEVICE,
    });

  it("is offered on an untainted card of a run in a Space, beside once and always", async () => {
    const issued = await ask(ctx("thr_kitchen"));
    expect(issued.approval.scopesOffered).toEqual(["once", "always"]);
    expect(issued.approval.details.space).toEqual({ id: "spc_kitchen", name: "Kitchen remodel" });
  });

  it.each([
    ["the main chat", () => ctx("thr_main")],
    ["a chat in no Space", () => ctx("thr_side")],
    [
      "a tainted turn in the Space",
      () => ctx("thr_kitchen", { taint: true, taintSources: [{ sourceKind: "web" }] }),
    ],
    [
      "a channel contact in the Space's chat",
      () =>
        ctx("thr_kitchen", { requester: { role: "allowed", channel: "telegram", senderId: "42" } }),
    ],
  ] as const)("is not offered in %s, and an inSpace answer is refused", async (_l, make) => {
    const c = make();
    const issued = await ask(c);
    expect(issued.approval.details.space).toBeUndefined();
    if (c.taint) expect(issued.approval.scopesOffered).toEqual(["once"]);
    await expect(answer(issued, { inSpace: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(spaces.added).toEqual([]);
  });

  it("a caller's own details.space is dropped", async () => {
    const issued = await ask(ctx("thr_main"), {
      details: { space: { id: "spc_kitchen", name: "Kitchen remodel" } },
    });
    expect(issued.approval.details.space).toBeUndefined();
    await expect(answer(issued, { inSpace: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("is answered with scope once only", async () => {
    const issued = await ask(ctx("thr_kitchen"));
    await expect(answer(issued, { scope: "always", inSpace: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("adds the pick to the Space: its runs use it, other runs and Settings do not", async () => {
    const c = ctx("thr_kitchen");
    const target = join(projects, "elsewhere", "plan.md");
    expect((await read(target, c)).rule).toBe("folder:not_granted");
    const done = await answer(await ask(c), { inSpace: true });
    expect(done.status).toBe("approved");
    expect(done.details.granted).toEqual({
      path: join(projects, "elsewhere"),
      mode: "rw",
      spaceId: "spc_kitchen",
    });
    expect(spaces.added).toEqual([
      { spaceId: "spc_kitchen", path: join(projects, "elsewhere"), mode: "rw" },
    ]);
    // Nothing in Settings and nothing kept for the conversation alone.
    expect(persisted).toEqual([]);
    expect(h.broker.sessionFolders("thr_kitchen")).toEqual([]);
    expect(passesFolders(await read(target, c))).toBe(true);
    // The Space's automation and its next chat runs see it; another Space and the main chat do not.
    expect(passesFolders(await read(target, ctx("thr_kitchen_auto", { unattended: true })))).toBe(
      true,
    );
    expect((await read(target, ctx("thr_jobs"))).rule).toBe("folder:not_granted");
    expect((await read(target, ctx("thr_main"))).rule).toBe("folder:not_granted");
  });

  it("listed as its own row in the access list, and revoked from there", async () => {
    const c = ctx("thr_kitchen");
    await answer(await ask(c), { inSpace: true });
    const rows = (await accessEntries(h.broker)).filter((e) => e.scope === "space");
    const row = rows.find((r) => r.path === join(projects, "elsewhere"));
    expect(row).toMatchObject({
      type: "folder",
      scope: "space",
      label: `Kitchen remodel · ${join(projects, "elsewhere")}`,
      mode: "rw",
      spaceId: "spc_kitchen",
      spaceName: "Kitchen remodel",
      automationsWrite: false,
    });
    expect(rows.map((r) => r.spaceId).sort()).toEqual(["spc_jobs", "spc_kitchen", "spc_kitchen"]);
    expect(await revokeAccess(h.broker, row?.id ?? "")).toBe(true);
    expect((await read(join(projects, "elsewhere", "a"), c)).rule).toBe("folder:not_granted");
    expect(await revokeAccess(h.broker, row?.id ?? "")).toBe(false);
  });

  it("falls back to this conversation when the Space was archived before the answer", async () => {
    const c = ctx("thr_kitchen");
    const issued = await ask(c);
    const k = spaces.spaces.get("spc_kitchen");
    if (k !== undefined) k.archived = true;
    const done = await answer(issued, { inSpace: true });
    expect(done.status).toBe("approved");
    expect(spaces.added).toEqual([]);
    expect(h.broker.sessionFolders("thr_kitchen").map((f) => f.path)).toEqual([
      join(projects, "elsewhere"),
    ]);
  });

  it("refuses a sensitive pick as any folder card does", async () => {
    const issued = await ask(ctx("thr_kitchen"));
    await expect(
      answer(issued, { inSpace: true, folderPath: join(home, ".ssh") }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(spaces.added).toEqual([]);
  });
});
