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
  MemoryPermissionStore,
  type PolicyContext,
  revokeAccess,
  type SpaceFolderAdd,
  type SpaceFolderRecord,
  type SpaceFolderSource,
  spaceFolderMode,
  type ThreadSpace,
} from "../src/index.ts";
import { call, DEVICE, makeBroker, path } from "./helpers.ts";

/**
 * Spaces wave S2 (docs/design/spaces-2026.md §5.3, SR2–SR4, SR11, SR14): the third folder scope.
 * A Space folder works only in the runs of its own Space, under every folder refusal, read-only
 * for automations unless the owner turned on "Automations may change files here", fixed at each
 * run's start (`bindRun`, keyed by thread and run), and stops at once when removed or when its
 * Space is archived or deleted.
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
    "Projects/recorded",
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

  folder(spaceId: string, p: string, mode: "ro" | "rw", automationsWrite = false, real = p): void {
    const name = this.spaces.get(spaceId)?.name ?? "";
    this.rows.push({ spaceId, spaceName: name, path: p, real, mode, automationsWrite });
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

  /** The Gateway's rules: widen only, never raise a folder automations may write in. */
  add(spaceId: string, entry: { path: string; real: string; mode: "ro" | "rw" }): SpaceFolderAdd {
    const s = this.spaces.get(spaceId);
    if (s === undefined || s.archived) throw new Error("that Space is archived or gone");
    const had = this.rows.find((r) => r.spaceId === spaceId && r.path === entry.path);
    if (entry.mode === "rw" && had?.mode === "ro" && had.automationsWrite) return "not_raised";
    this.added.push({ spaceId, path: entry.path, mode: entry.mode });
    this.rows = this.rows.filter((r) => r !== had);
    this.rows.push({
      spaceId,
      spaceName: s.name,
      path: entry.path,
      real: entry.real,
      mode: had?.mode === "rw" ? "rw" : entry.mode,
      automationsWrite: had?.automationsWrite ?? false,
    });
    return "added";
  }

  remove(spaceId: string, p: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.spaceId === spaceId && r.path === p));
    return this.rows.length < before;
  }
}

let spaces: FakeSpaces;
let persisted: FolderGrantEntry[];
let store: MemoryPermissionStore;

function harness() {
  persisted = [];
  store = new MemoryPermissionStore();
  return makeBroker({
    folderAccess: { env: () => env, persist: async (e) => void persisted.push(e) },
    hostProgram: { home },
    psycheHome: env.psycheHome,
    spaces,
    store,
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

/** The agent loop's run start: the run's Space is fixed here, before any call (`bindRun`). */
function start(
  threadId: string,
  over: Partial<PolicyContext> & { requester?: Requester } = {},
  parent?: PolicyContext,
): PolicyContext {
  const c = ctx(threadId, over);
  h.broker.bindRun({
    threadId: c.threadId,
    runId: c.runId,
    unattended: c.unattended === true,
    ...(c.requester === undefined ? {} : { requester: c.requester }),
    ...(parent === undefined ? {} : { parent: { threadId: parent.threadId, runId: parent.runId } }),
  });
  return c;
}

const read = (p: string, c: PolicyContext) =>
  h.broker.decide(call("read_file", "read", path(p)), c);
const write = (p: string, c: PolicyContext) =>
  h.broker.decide(call("write_file", "write", path(p)), c);
/** A widget's "asks first" marker: `widgets.preview` → `loop.previewCall` (no run, no flags). */
const widgetPreview = async (p: string, threadId: string) => {
  const [r] = await h.broker.preview([call("write_file", "write", path(p))], {
    threadId,
    runId: "widget:preview",
    permissionMode: "balanced",
    taint: false,
  });
  if (r === undefined) throw new Error("no preview");
  return r;
};

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
      () => read(join(kitchen, "a.txt"), start("thr_kitchen")),
    ],
    [
      "a chat in the Space reads deep inside it",
      () => read(join(kitchen, "plans", "tile.pdf"), start("thr_kitchen")),
    ],
    [
      "a chat in the Space writes in a read & write folder",
      () => write(join(kitchen, "notes.md"), start("thr_kitchen")),
    ],
    [
      "the Space's automation reads the folder",
      () => read(join(kitchen, "a.txt"), start("thr_kitchen_auto", { unattended: true })),
    ],
    [
      "a subagent of the Space's chat reads the folder",
      () => read(join(kitchen, "a.txt"), start("thr_sub", {}, start("thr_kitchen"))),
    ],
    ["another Space reads its own folder", () => read(join(jobs, "cv.pdf"), start("thr_jobs"))],
  ];

  const NEAR_MISSES: [string, () => Promise<{ decision: string; rule: string }>, string][] = [
    [
      "another Space's run",
      () => read(join(kitchen, "a.txt"), start("thr_jobs")),
      "folder:not_granted",
    ],
    ["the main chat", () => read(join(kitchen, "a.txt"), start("thr_main")), "folder:not_granted"],
    [
      "a chat in no Space",
      () => read(join(kitchen, "a.txt"), start("thr_side")),
      "folder:not_granted",
    ],
    [
      "an unknown thread",
      () => read(join(kitchen, "a.txt"), start("thr_nobody")),
      "folder:not_granted",
    ],
    [
      "a call on the Space's chat from a run that was never bound (a webhook's decide)",
      () => read(join(kitchen, "a.txt"), ctx("thr_kitchen", { runId: "auto_run_webhook" })),
      "folder:not_granted",
    ],
    [
      "a widget preview on the Space's chat",
      () => widgetPreview(join(kitchen, "a.txt"), "thr_kitchen"),
      "folder:not_granted",
    ],
    [
      "an automation writing without the flag",
      () => write(join(kitchen, "a.txt"), start("thr_kitchen_auto", { unattended: true })),
      "folder:read_only",
    ],
    [
      "a chat writing in a read-only Space folder",
      () => write(join(jobs, "cv.pdf"), start("thr_jobs")),
      "folder:read_only",
    ],
    [
      "a sibling folder",
      () => read(join(projects, "elsewhere", "a.txt"), start("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "the parent folder",
      () => read(join(projects, "a.txt"), start("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a lookalike prefix (kitchen-old)",
      () => read(join(projects, "kitchen-old", "a.txt"), start("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a lookalike suffix (kitchen2)",
      () => read(join(projects, "kitchen2", "a.txt"), start("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a lookalike letter (Cyrillic о in kitchen)",
      () => read(join(projects, "kitchеn", "a.txt"), start("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a dot-dot escape from the folder",
      () => read(`${kitchen}/../elsewhere/a.txt`, start("thr_kitchen")),
      "folder:not_granted",
    ],
    [
      "a subagent whose parent works in no Space",
      () => {
        spaces.threads.set("thr_sub2", { parentThreadId: "thr_main" });
        return read(join(kitchen, "a.txt"), start("thr_sub2", {}, start("thr_main")));
      },
      "folder:not_granted",
    ],
    [
      "a subagent bound without its parent run",
      () => read(join(kitchen, "a.txt"), start("thr_sub")),
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
    const peer = start("thr_kitchen", {
      requester: { role: "allowed", channel: "oldchat", senderId: "42" },
    });
    expect((await read(join(kitchen, "a.txt"), peer)).decision).toBe("deny");
    expect(h.broker.runSpace("thr_kitchen", peer.runId)).toBeUndefined();
    expect(h.broker.liveSessionFolders("thr_kitchen", peer.runId)).toEqual([]);
  });

  it("an automation writes where the owner turned on Automations may change files here", async () => {
    spaces.rows = spaces.rows.map((r) =>
      r.path === kitchen ? { ...r, automationsWrite: true } : r,
    );
    const d = await write(join(kitchen, "a.txt"), start("thr_kitchen_auto", { unattended: true }));
    expect(passesFolders(d)).toBe(true);
  });

  it("a subagent of the Space's automation is read-only there too", async () => {
    spaces.threads.set("thr_auto_sub", { parentThreadId: "thr_kitchen_auto" });
    const parent = start("thr_kitchen_auto", { unattended: true });
    const d = await write(join(kitchen, "a.txt"), start("thr_auto_sub", {}, parent));
    expect(d).toMatchObject({ decision: "deny", rule: "folder:read_only" });
  });

  it("the file tools see the same folders as the engine (liveSessionFolders)", () => {
    const k = start("thr_kitchen");
    const j = start("thr_jobs");
    const m = start("thr_main");
    const a = start("thr_kitchen_auto", { unattended: true });
    expect(h.broker.liveSessionFolders("thr_kitchen", k.runId)).toEqual([
      { path: kitchen, mode: "rw", real: kitchen },
    ]);
    expect(h.broker.liveSessionFolders("thr_jobs", j.runId)).toEqual([
      { path: jobs, mode: "ro", real: jobs },
    ]);
    expect(h.broker.liveSessionFolders("thr_main", m.runId)).toEqual([]);
    expect(h.broker.liveSessionFolders("thr_kitchen_auto", a.runId)).toEqual([
      { path: kitchen, mode: "ro", real: kitchen },
    ]);
    // Without a run (the chat's share button) or for a run never bound: no Space folders.
    expect(h.broker.liveSessionFolders("thr_kitchen")).toEqual([]);
    expect(h.broker.liveSessionFolders("thr_kitchen", "widget:preview")).toEqual([]);
  });

  it("a Space folder only adds: a Settings folder that covers it keeps its own mode", async () => {
    h.broker.setPolicy({ ...h.broker.policy, folders: [{ path: projects, mode: "rw" }] });
    await h.broker.foldersSettled();
    // The automation's read-only view of the kitchen does not narrow the owner's own grant.
    const a = start("thr_kitchen_auto", { unattended: true });
    expect(passesFolders(await write(join(kitchen, "a.txt"), a))).toBe(true);
    expect(h.broker.liveSessionFolders("thr_kitchen_auto", a.runId)).toEqual([]);
  });

  it("a store that throws gives no Space folders (fail closed)", async () => {
    const c = start("thr_kitchen");
    spaces.broken = true;
    expect(await read(join(kitchen, "a.txt"), c)).toMatchObject({
      decision: "deny",
      rule: "folder:not_granted",
    });
  });
});

describe("the Space is fixed at the run's start (SR3)", () => {
  it("a chat moved to another Space keeps its run's folders until its next run", async () => {
    const run1 = start("thr_kitchen", { runId: "run_1" });
    expect(passesFolders(await read(join(kitchen, "a.txt"), run1))).toBe(true);
    spaces.threads.set("thr_kitchen", { spaceId: "spc_jobs", spaceName: "Job search" });
    // Same run: still the kitchen, never the new Space's folders.
    expect(passesFolders(await read(join(kitchen, "a.txt"), run1))).toBe(true);
    expect((await read(join(jobs, "a.txt"), run1)).rule).toBe("folder:not_granted");
    // Next run: the new Space only.
    const run2 = start("thr_kitchen", { runId: "run_2" });
    expect((await read(join(kitchen, "a.txt"), run2)).rule).toBe("folder:not_granted");
    expect(passesFolders(await read(join(jobs, "a.txt"), run2))).toBe(true);
    // Both runs keep their own Space side by side.
    expect(h.broker.runSpace("thr_kitchen", "run_1")?.spaceId).toBe("spc_kitchen");
    expect(h.broker.runSpace("thr_kitchen", "run_2")?.spaceId).toBe("spc_jobs");
  });

  it("a chat moved into a Space mid-run gets nothing from it until its next run", async () => {
    const run1 = start("thr_side", { runId: "run_1" });
    spaces.threads.set("thr_side", { spaceId: "spc_kitchen", spaceName: "Kitchen remodel" });
    expect((await write(join(kitchen, "a.txt"), run1)).rule).toBe("folder:not_granted");
    const run2 = start("thr_side", { runId: "run_2" });
    expect(passesFolders(await write(join(kitchen, "a.txt"), run2))).toBe(true);
  });

  it("is bound before the run's first call: a move between run start and that call changes nothing", async () => {
    const run1 = start("thr_kitchen", { runId: "run_1" });
    spaces.threads.set("thr_kitchen", { spaceId: "spc_jobs", spaceName: "Job search" });
    expect(passesFolders(await read(join(kitchen, "a.txt"), run1))).toBe(true);
    expect((await read(join(jobs, "a.txt"), run1)).rule).toBe("folder:not_granted");
  });

  it("binding a run again keeps its first binding", async () => {
    const run1 = start("thr_kitchen", { runId: "run_1" });
    spaces.threads.set("thr_kitchen", { spaceId: "spc_jobs", spaceName: "Job search" });
    start("thr_kitchen", { runId: "run_1" });
    expect(passesFolders(await read(join(kitchen, "a.txt"), run1))).toBe(true);
    expect((await read(join(jobs, "a.txt"), run1)).rule).toBe("folder:not_granted");
  });

  // r2 finding 1: the loop's Space is a hint the broker cross-checks against the thread.
  it("takes the loop's run-start Space only when it is the thread's own", async () => {
    const own = ctx("thr_kitchen", { runId: "run_own" });
    h.broker.bindRun({
      threadId: own.threadId,
      runId: own.runId,
      unattended: false,
      space: { id: "spc_kitchen", name: "Kitchen remodel" },
    });
    expect(passesFolders(await read(join(kitchen, "a.txt"), own))).toBe(true);
    const none = ctx("thr_kitchen", { runId: "run_none" });
    h.broker.bindRun({
      threadId: none.threadId,
      runId: none.runId,
      unattended: false,
      space: null,
    });
    expect((await read(join(kitchen, "a.txt"), none)).rule).toBe("folder:not_granted");
  });

  it.each([
    ["the main chat", "thr_main"],
    ["a chat in no Space", "thr_side"],
    ["a chat in another Space", "thr_jobs"],
  ])("a caller's Space is ignored for %s", async (_label, threadId) => {
    const c = ctx(threadId, { runId: `run_${threadId}` });
    h.broker.bindRun({
      threadId,
      runId: c.runId,
      unattended: false,
      space: { id: "spc_kitchen", name: "Kitchen remodel" },
    });
    expect((await read(join(kitchen, "a.txt"), c)).rule).toBe("folder:not_granted");
    expect(h.broker.runSpace(threadId, c.runId)?.spaceId).not.toBe("spc_kitchen");
  });

  it("a caller's Space is ignored for an archived Space", async () => {
    const c = ctx("thr_kitchen", { runId: "run_arch" });
    const archived = spaces.spaces.get("spc_kitchen");
    if (archived !== undefined) archived.archived = true;
    h.broker.bindRun({
      threadId: "thr_kitchen",
      runId: c.runId,
      unattended: false,
      space: { id: "spc_kitchen", name: "Kitchen remodel" },
    });
    expect(h.broker.runSpace("thr_kitchen", c.runId)).toBeUndefined();
  });

  it("a specialist job (subagent thread) takes its parent thread's Space through the hint", async () => {
    spaces.threads.set("thr_job", { parentThreadId: "thr_kitchen" });
    const job = ctx("thr_job", { runId: "run_job" });
    h.broker.bindRun({
      threadId: "thr_job",
      runId: job.runId,
      unattended: false,
      space: { id: "spc_kitchen", name: "Kitchen remodel" },
    });
    expect(passesFolders(await read(join(kitchen, "a.txt"), job))).toBe(true);
    // Another Space's id is not the parent's: none.
    const other = ctx("thr_job", { runId: "run_job2" });
    h.broker.bindRun({
      threadId: "thr_job",
      runId: other.runId,
      unattended: false,
      space: { id: "spc_jobs", name: "Job search" },
    });
    expect(h.broker.runSpace("thr_job", other.runId)).toBeUndefined();
    // A job whose parent is in no Space gets none, hint or not.
    spaces.threads.set("thr_job_main", { parentThreadId: "thr_main" });
    h.broker.bindRun({
      threadId: "thr_job_main",
      runId: "run_jm",
      unattended: false,
      space: { id: "spc_kitchen", name: "Kitchen remodel" },
    });
    expect(h.broker.runSpace("thr_job_main", "run_jm")).toBeUndefined();
  });

  it("P1: a widget preview between an automation's calls changes neither its folders nor its unattended flag", async () => {
    const auto = start("thr_kitchen_auto", { runId: "run_auto", unattended: true });
    expect(passesFolders(await read(join(kitchen, "a.txt"), auto))).toBe(true);
    expect(h.broker.liveSessionFolders("thr_kitchen_auto", "run_auto")).toEqual([
      { path: kitchen, mode: "ro", real: kitchen },
    ]);
    const p = await widgetPreview(join(kitchen, "a.txt"), "thr_kitchen_auto");
    expect(p).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
    expect(h.broker.liveSessionFolders("thr_kitchen_auto", "run_auto")).toEqual([
      { path: kitchen, mode: "ro", real: kitchen },
    ]);
    expect(h.broker.runSpace("thr_kitchen_auto", "run_auto")).toMatchObject({
      spaceId: "spc_kitchen",
      unattended: true,
    });
    // The preview stored nothing.
    expect(h.broker.runSpace("thr_kitchen_auto", "widget:preview")).toBeUndefined();
  });

  it("P2: a preview during an unattended write still leaves the write read-only", async () => {
    const auto = start("thr_kitchen_auto", { runId: "run_auto", unattended: true });
    const pending = write(join(kitchen, "a.txt"), auto);
    const preview = widgetPreview(join(kitchen, "a.txt"), "thr_kitchen_auto");
    expect(await pending).toMatchObject({ decision: "deny", rule: "folder:read_only" });
    await preview;
    // And after it, the same.
    expect(await write(join(kitchen, "a.txt"), auto)).toMatchObject({
      decision: "deny",
      rule: "folder:read_only",
    });
  });

  it("P3: a move and then a preview mid-run do not switch the run's Space", async () => {
    const run1 = start("thr_kitchen", { runId: "run_1" });
    expect(passesFolders(await read(join(kitchen, "a.txt"), run1))).toBe(true);
    spaces.threads.set("thr_kitchen", { spaceId: "spc_jobs", spaceName: "Job search" });
    await widgetPreview(join(jobs, "a.txt"), "thr_kitchen");
    await read(join(jobs, "a.txt"), ctx("thr_kitchen", { runId: "auto_run_webhook" }));
    expect((await read(join(jobs, "a.txt"), run1)).rule).toBe("folder:not_granted");
    expect(passesFolders(await read(join(kitchen, "a.txt"), run1))).toBe(true);
  });

  it("a background run on the same thread keeps its own Space and flag", async () => {
    const chat = start("thr_kitchen", { runId: "run_chat" });
    const task = start("thr_kitchen", { runId: "run_task", unattended: true });
    expect(passesFolders(await write(join(kitchen, "a.txt"), chat))).toBe(true);
    expect((await write(join(kitchen, "a.txt"), task)).rule).toBe("folder:read_only");
    expect(passesFolders(await write(join(kitchen, "a.txt"), chat))).toBe(true);
  });

  it("only the run's own end drops its binding; other runs never evict a live one", async () => {
    const live = start("thr_kitchen", { runId: "run_live" });
    for (let i = 0; i < 3_000; i++) {
      const c = start(`thr_other_${i}`, { runId: `run_${i}` });
      h.broker.endRun(c.threadId, c.runId);
    }
    for (let i = 0; i < 2_500; i++) start("thr_kitchen", { runId: `run_more_${i}` });
    expect(h.broker.runSpace("thr_kitchen", "run_live")?.spaceId).toBe("spc_kitchen");
    expect(passesFolders(await read(join(kitchen, "a.txt"), live))).toBe(true);
    h.broker.endRun("thr_kitchen", "run_live");
    expect(h.broker.runSpace("thr_kitchen", "run_live")).toBeUndefined();
    expect((await read(join(kitchen, "a.txt"), live)).rule).toBe("folder:not_granted");
  });
});

describe("revoked at once (SR14)", () => {
  it("removing the folder stops it on the next call of the same run", async () => {
    const c = start("thr_kitchen");
    expect(passesFolders(await read(join(kitchen, "a.txt"), c))).toBe(true);
    expect(await h.broker.revokeSpaceFolder("spc_kitchen", kitchen)).toBe(true);
    expect((await read(join(kitchen, "a.txt"), c)).rule).toBe("folder:not_granted");
    expect(h.broker.liveSessionFolders("thr_kitchen", c.runId)).toEqual([]);
  });

  it("archiving the Space stops its folders in a running run", async () => {
    const c = start("thr_kitchen");
    expect(passesFolders(await read(join(kitchen, "a.txt"), c))).toBe(true);
    const k = spaces.spaces.get("spc_kitchen");
    if (k !== undefined) k.archived = true;
    h.broker.spaceFoldersChanged();
    expect((await read(join(kitchen, "a.txt"), c)).rule).toBe("folder:not_granted");
    expect(h.broker.liveSessionFolders("thr_kitchen", c.runId)).toEqual([]);
    expect(h.broker.allSpaceFolders().some((f) => f.spaceId === "spc_kitchen")).toBe(false);
    // The next run of the chat is in no Space at all.
    expect(h.broker.runSpace("thr_kitchen", c.runId)?.spaceId).toBe("spc_kitchen");
    const next = start("thr_kitchen", { runId: "run_next" });
    expect(h.broker.runSpace("thr_kitchen", next.runId)).toBeUndefined();
  });

  it("deleting the Space stops its folders", async () => {
    const c = start("thr_kitchen");
    spaces.spaces.delete("spc_kitchen");
    spaces.rows = spaces.rows.filter((r) => r.spaceId !== "spc_kitchen");
    expect((await read(join(kitchen, "a.txt"), c)).rule).toBe("folder:not_granted");
  });
});

describe.skipIf(WIN)("refusals hold for Space folders (SR2)", () => {
  /** Lets the broker look at the disk again, as it does once a look is stale. */
  async function lookAgain(c: PolicyContext) {
    h.clock.advance(FOLDER_FRESH_MS + 1);
    h.broker.liveSessionFolders(c.threadId, c.runId);
    await h.broker.foldersSettled();
  }

  it("a root swapped for a link after the grant is refused by the next look", async () => {
    const root = join(projects, "swap-root");
    await mkdir(root, { recursive: true });
    spaces.folder("spc_kitchen", root, "rw");
    const c = start("thr_kitchen");
    expect(passesFolders(await read(join(root, "a.txt"), c))).toBe(true);
    await rm(root, { recursive: true });
    await symlink(join(projects, "elsewhere"), root);
    await lookAgain(c);
    expect(await read(join(root, "a.txt"), c)).toMatchObject({
      decision: "deny",
      rule: "folder:not_granted",
    });
    expect(h.broker.allSpaceFolders().find((f) => f.path === root)?.refused).toBe(true);
    // A link to a sensitive root is refused the same way.
    await rm(root);
    await symlink(join(home, ".ssh"), root);
    await lookAgain(c);
    expect((await read(join(root, "id_ed25519"), c)).rule).toBe("folder:not_granted");
  });

  it("a parent swapped for a link (the root's real path moved) is refused", async () => {
    const parent = join(home, "Swapped");
    const root = join(parent, "proj");
    await mkdir(root, { recursive: true });
    await mkdir(join(home, "Decoy", "proj"), { recursive: true });
    spaces.folder("spc_kitchen", root, "rw");
    const c = start("thr_kitchen");
    expect(passesFolders(await read(join(root, "a.txt"), c))).toBe(true);
    await rename(parent, join(home, "Swapped-orig"));
    await symlink(join(home, "Decoy"), parent);
    await lookAgain(c);
    expect((await read(join(root, "a.txt"), c)).rule).toBe("folder:not_granted");
  });

  it("a folder whose real path is not the one recorded when it was added is refused, look after look", async () => {
    // The path is a plain folder today, so nothing about the path alone refuses it: only the
    // recorded real path (`space_folders.real`) shows it is not the folder the owner added.
    const recorded = join(projects, "recorded");
    spaces.folder("spc_kitchen", recorded, "rw", false, join(projects, "elsewhere"));
    const c = start("thr_kitchen");
    expect((await read(join(recorded, "a.txt"), c)).rule).toBe("folder:not_granted");
    await lookAgain(c);
    expect((await read(join(recorded, "a.txt"), c)).rule).toBe("folder:not_granted");
    await lookAgain(c);
    expect((await read(join(recorded, "a.txt"), c)).rule).toBe("folder:not_granted");
    expect(h.broker.allSpaceFolders().find((f) => f.path === recorded)?.refused).toBe(true);
  });

  it("a stored Space folder at a sensitive root covers nothing", async () => {
    spaces.folder("spc_kitchen", join(home, ".ssh"), "ro");
    spaces.folder("spc_kitchen", home, "ro");
    const c = start("thr_kitchen");
    expect((await read(join(home, ".ssh", "id_ed25519"), c)).rule).toBe("folder:not_granted");
    expect((await read(join(home, "notes.txt"), c)).rule).toBe("folder:not_granted");
  });
});

describe('the "Allow in this Space" card', () => {
  async function ask(
    c: PolicyContext,
    over: { details?: Record<string, unknown>; access?: "ro" | "rw" } = {},
  ) {
    const issued = await h.broker.requestApproval({
      kind: "folder_access",
      summary: "Share a folder: ~/Projects/elsewhere",
      details: {
        requestedPath: "~/Projects/elsewhere",
        resolvedPath: join(projects, "elsewhere"),
        reason: "plans",
        access: over.access ?? "rw",
        ...over.details,
      },
      bindingHash: `h${Math.random()}`.replace(".", "") as never,
      grantKey: `folder_access|${over.access ?? "rw"}`,
      requestedBy: { runId: c.runId, taskId: null, threadId: c.threadId },
      sideEffect: over.access === "ro" ? "read" : "write",
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

  it("is offered on an untainted card of a run in a Space, naming the Space", async () => {
    const issued = await ask(start("thr_kitchen"));
    expect(issued.approval.scopesOffered).toEqual(["once", "always"]);
    expect(issued.approval.details.space).toEqual({
      id: "spc_kitchen",
      name: "Kitchen remodel",
      automationsWrite: false,
    });
  });

  it("says when the Space's automations already write in the folder", async () => {
    spaces.folder("spc_kitchen", projects, "rw", true);
    const issued = await ask(start("thr_kitchen"));
    expect(issued.approval.details.space).toMatchObject({ automationsWrite: true });
  });

  it.each([
    ["the main chat", () => start("thr_main")],
    ["a chat in no Space", () => start("thr_side")],
    [
      "a tainted turn in the Space",
      () => start("thr_kitchen", { taint: true, taintSources: [{ sourceKind: "web" }] }),
    ],
    [
      "a channel contact in the Space's chat",
      () =>
        start("thr_kitchen", {
          requester: { role: "allowed", channel: "oldchat", senderId: "42" },
        }),
    ],
    ["a run on the Space's chat that was never bound", () => ctx("thr_kitchen")],
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
    const issued = await ask(start("thr_main"), {
      details: { space: { id: "spc_kitchen", name: "Kitchen remodel" } },
    });
    expect(issued.approval.details.space).toBeUndefined();
    await expect(answer(issued, { inSpace: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("a tainted card is refused even when its row carries an offer", async () => {
    const issued = await ask(start("thr_kitchen"));
    // A row forged (or left over) with both: the answer checks the card's taint itself.
    const rec = store.getApproval(issued.approval.id);
    if (rec === undefined) throw new Error("no card");
    rec.approval.taint = true;
    store.updateApproval(rec);
    expect(rec.approval.details.space).toBeDefined();
    await expect(answer(issued, { inSpace: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(spaces.added).toEqual([]);
  });

  it("is answered with scope once only", async () => {
    const issued = await ask(start("thr_kitchen"));
    await expect(answer(issued, { scope: "always", inSpace: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("adds the pick to the Space: its runs use it, other runs and Settings do not", async () => {
    const c = start("thr_kitchen");
    const target = join(projects, "elsewhere", "plan.md");
    expect((await read(target, c)).rule).toBe("folder:not_granted");
    const done = await answer(await ask(c), { inSpace: true });
    expect(done.status).toBe("approved");
    expect(done.details.granted).toEqual({
      path: join(projects, "elsewhere"),
      mode: "rw",
      spaceId: "spc_kitchen",
    });
    expect(store.getApproval(done.id)?.approval.details.granted).toMatchObject({
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
    expect(passesFolders(await read(target, start("thr_kitchen_auto", { unattended: true })))).toBe(
      true,
    );
    expect((await read(target, start("thr_jobs"))).rule).toBe("folder:not_granted");
    expect((await read(target, start("thr_main"))).rule).toBe("folder:not_granted");
  });

  it("raises a read-only Space folder to read & write where automations may not write there", async () => {
    spaces.folder("spc_kitchen", join(projects, "elsewhere"), "ro");
    const c = start("thr_kitchen");
    const done = await answer(await ask(c), { inSpace: true });
    expect(done.details.granted).toMatchObject({ mode: "rw", spaceId: "spc_kitchen" });
    expect(spaces.rows.find((r) => r.path === join(projects, "elsewhere"))?.mode).toBe("rw");
  });

  it("never raises to read & write a folder the Space's automations may write in", async () => {
    spaces.folder("spc_kitchen", join(projects, "elsewhere"), "ro", true);
    const c = start("thr_kitchen");
    const done = await answer(await ask(c), { inSpace: true });
    expect(done.status).toBe("approved");
    // The Space keeps it read-only; the read & write pick works in this conversation only.
    expect(spaces.rows.find((r) => r.path === join(projects, "elsewhere"))).toMatchObject({
      mode: "ro",
      automationsWrite: true,
    });
    expect(spaces.added).toEqual([]);
    expect((done.details.granted as { spaceId?: string }).spaceId).toBeUndefined();
    expect(h.broker.sessionFolders("thr_kitchen")).toEqual([
      { path: join(projects, "elsewhere"), mode: "rw" },
    ]);
    const auto = start("thr_kitchen_auto", { unattended: true });
    expect(await write(join(projects, "elsewhere", "a.txt"), auto)).toMatchObject({
      decision: "deny",
      rule: "folder:read_only",
    });
  });

  it("listed as its own row in the access list, and revoked from there", async () => {
    const c = start("thr_kitchen");
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
    const c = start("thr_kitchen");
    const issued = await ask(c);
    const k = spaces.spaces.get("spc_kitchen");
    if (k !== undefined) k.archived = true;
    const done = await answer(issued, { inSpace: true });
    expect(done.status).toBe("approved");
    expect(spaces.added).toEqual([]);
    // The record says this conversation, never the Space.
    expect((done.details.granted as { spaceId?: string }).spaceId).toBeUndefined();
    expect(store.getApproval(done.id)?.approval.details.granted).toEqual({
      path: join(projects, "elsewhere"),
      mode: "rw",
    });
    expect(h.broker.sessionFolders("thr_kitchen").map((f) => f.path)).toEqual([
      join(projects, "elsewhere"),
    ]);
  });

  it("applies to the card's Space only: a thread moved since gets the folder for this conversation", async () => {
    const c = start("thr_kitchen");
    const issued = await ask(c);
    spaces.threads.set("thr_kitchen", { spaceId: "spc_jobs", spaceName: "Job search" });
    const done = await answer(issued, { inSpace: true });
    expect(done.status).toBe("approved");
    expect(spaces.added).toEqual([]);
    expect((done.details.granted as { spaceId?: string }).spaceId).toBeUndefined();
    expect(h.broker.sessionFolders("thr_kitchen").map((f) => f.path)).toEqual([
      join(projects, "elsewhere"),
    ]);
  });

  it("refuses a sensitive pick as any folder card does", async () => {
    const issued = await ask(start("thr_kitchen"));
    await expect(
      answer(issued, { inSpace: true, folderPath: join(home, ".ssh") }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(spaces.added).toEqual([]);
  });
});
