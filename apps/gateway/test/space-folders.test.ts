import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, updateDevice } from "@psyche/db";
import { FOLDER_FRESH_MS, type PolicyContext } from "@psyche/permissions";
import { FakeModelProvider, sha256 } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { silentLogger } from "../src/log.ts";
import { spaceFolderSource, threadSpace } from "../src/spaces/folders.ts";
import {
  adminClient,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  TestClient,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Spaces wave S2 in the composed Gateway: `spaces.folders.*` and `spaces.settings.set`, the
 * Space rows of `access.list`, and the composed broker using a Space's folders only in that
 * Space's runs (docs/design/spaces-2026.md §5.3, SR2–SR4, SR14).
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON payloads read by the assertions
type Json = Record<string, any>;

/** A request whose error the assertions read. */
const ask = (c: TestClient, method: string, params?: unknown, key?: string): Promise<Json> =>
  c.request(method, params, key) as Promise<Json>;

let home = "";
let work = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
let offset = 0;
const clock = { now: () => Date.now() + offset };

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  offset = 0;
  for (const d of [home, work]) if (d) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-spf-"));
  work = realpathSync(mkdtempSync(join(tmpdir(), "psyche-spf-work-")));
  for (const d of ["kitchen/plans", "jobs", "elsewhere"])
    mkdirSync(join(work, d), { recursive: true });
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    clock,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) => {
        services = s;
        return {};
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return { owner, s: services as ComposeServices };
}

/** A paired admin device that is not the Mac's desktop shell (a phone, another computer). */
async function remoteAdmin(gw: ComposedGateway["gateway"]): Promise<TestClient> {
  const key = newDeviceKey();
  const deviceId = `remote-${Math.random().toString(36).slice(2)}`;
  const first = await desktopClient(gw, key, deviceId);
  first.close();
  updateDevice(gw.context.db, deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const c = await TestClient.open(wsUrlOf(gw));
  await handshake(c, gw.origin, { key, deviceId });
  clients.push(c);
  return c;
}

const ctx = (threadId: string, over: Partial<PolicyContext> = {}): PolicyContext => ({
  threadId,
  runId: `run_${threadId}`,
  permissionMode: "balanced",
  taint: false,
  ...over,
});

/** One call of a run; the run is bound first, as the agent loop does at run start (SR3). */
function decide(s: ComposeServices, tool: string, p: string, c: PolicyContext) {
  const params = { tool, target: p };
  s.rawBroker.bindRun({ threadId: c.threadId, runId: c.runId, unattended: c.unattended === true });
  return s.rawBroker.decide(
    {
      tool,
      sideEffect: tool === "write_file" ? "write" : "read",
      target: { kind: "path", value: p },
      targetKind: "path",
      params,
      paramsHash: sha256(JSON.stringify(params)),
    },
    c,
  );
}

const passes = (d: { decision: string; rule: string }) =>
  d.decision !== "deny" && d.rule !== "folder:not_granted" && d.rule !== "folder:read_only";

async function space(owner: TestClient, name: string): Promise<string> {
  return (await owner.call<Json>("spaces.create", { name }, ik())).space.id;
}

async function chatIn(owner: TestClient, spaceId: string): Promise<string> {
  return (await owner.call<Json>("threads.create", { kind: "side", title: "t", spaceId }, ik()))
    .thread.id;
}

describe("spaces.folders.*", () => {
  it("adds the real path of a pick, refusing what Settings would refuse (SR2)", async () => {
    const { owner } = await setup();
    const id = await space(owner, "Kitchen remodel");
    for (const bad of [home, "/", homedir(), join(homedir(), ".ssh"), "relative/path"]) {
      const res = await ask(owner, "spaces.folders.add", { spaceId: id, path: bad }, ik());
      expect(res.ok, bad).toBe(false);
      expect(["forbidden", "invalid_params", "not_found"]).toContain(res.error.code);
    }
    // No pick: the owner must pick on the Mac.
    const none = await ask(owner, "spaces.folders.add", { spaceId: id }, ik());
    expect(none.error.code).toBe("invalid_params");
    // A link to the folder is stored as the folder itself.
    const link = join(work, "kitchen-link");
    symlinkSync(join(work, "kitchen"), link);
    const detail = await owner.call<Json>("spaces.folders.add", { spaceId: id, path: link }, ik());
    expect(detail.folders).toEqual([
      expect.objectContaining({
        path: join(work, "kitchen"),
        real: join(work, "kitchen"),
        mode: "ro",
        automationsWrite: false,
      }),
    ]);
  });

  it("only the Mac adds or widens; any admin device removes or narrows", async () => {
    const { owner } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const kitchen = join(work, "kitchen");
    await owner.call("spaces.folders.add", { spaceId: id, path: kitchen, mode: "rw" }, ik());
    const phone = await remoteAdmin((composed as ComposedGateway).gateway);
    const add = await ask(
      phone,
      "spaces.folders.add",
      { spaceId: id, path: join(work, "jobs") },
      ik(),
    );
    expect(add.error).toMatchObject({ code: "forbidden", details: { reason: "host_only" } });
    const widen = await ask(phone, "spaces.settings.set", {
      spaceId: id,
      automationsWrite: [{ path: kitchen, allow: true }],
    });
    expect(widen.error?.code).toBe("forbidden");
    // Narrowing from the phone works.
    const ro = await phone.call<Json>("spaces.folders.setMode", {
      spaceId: id,
      path: kitchen,
      mode: "ro",
    });
    expect(ro.folders[0].mode).toBe("ro");
    const rw = await ask(phone, "spaces.folders.setMode", {
      spaceId: id,
      path: kitchen,
      mode: "rw",
    });
    expect(rw.error?.code).toBe("forbidden");
    const gone = await phone.call<Json>("spaces.folders.remove", { spaceId: id, path: kitchen });
    expect(gone.folders).toEqual([]);
    const again = await ask(phone, "spaces.folders.remove", { spaceId: id, path: kitchen });
    expect(again.error?.code).toBe("not_found");
  });
});

describe("a Space folder works only in its own Space's runs", () => {
  it("chats of the Space read and write it; another Space, the main chat and no Space do not", async () => {
    const { owner, s } = await setup();
    const kitchenSpace = await space(owner, "Kitchen remodel");
    const jobsSpace = await space(owner, "Job search");
    const kitchen = join(work, "kitchen");
    await owner.call(
      "spaces.folders.add",
      { spaceId: kitchenSpace, path: kitchen, mode: "rw" },
      ik(),
    );
    const inKitchen = await chatIn(owner, kitchenSpace);
    const inJobs = await chatIn(owner, jobsSpace);
    const loose = (await owner.call<Json>("threads.create", { kind: "side", title: "x" }, ik()))
      .thread.id;
    const main = createThread(s.db, { kind: "main", sessionKey: "main-spf" }).id;
    // Even a main thread whose row names the Space is in none.
    s.db.sqlite.prepare("UPDATE threads SET space_id = ? WHERE id = ?").run(kitchenSpace, main);
    await s.rawBroker.foldersSettled();

    const file = join(kitchen, "plans", "tile.md");
    expect(passes(await decide(s, "read_file", file, ctx(inKitchen)))).toBe(true);
    expect(passes(await decide(s, "write_file", file, ctx(inKitchen)))).toBe(true);
    for (const t of [inJobs, loose, main]) {
      expect(await decide(s, "read_file", file, ctx(t))).toMatchObject({
        decision: "deny",
        rule: "folder:not_granted",
      });
    }
    // Siblings, the parent and lookalikes are outside it.
    for (const p of [
      join(work, "elsewhere", "a"),
      join(work, "a"),
      `${kitchen}-old/a`,
      `${kitchen}2/a`,
    ]) {
      expect((await decide(s, "read_file", p, ctx(inKitchen))).rule, p).toBe("folder:not_granted");
    }
    // The file tools see the same folders.
    expect(
      s.rawBroker.liveSessionFolders(inKitchen, `run_${inKitchen}`).map((f) => f.path),
    ).toEqual([kitchen]);
    expect(s.rawBroker.liveSessionFolders(inJobs, `run_${inJobs}`)).toEqual([]);
  });

  it("an automation reads the Space's folders and writes only where the owner allowed it (SP8)", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const kitchen = join(work, "kitchen");
    await owner.call("spaces.folders.add", { spaceId: id, path: kitchen, mode: "rw" }, ik());
    const auto = createThread(s.db, { kind: "automation", sessionKey: "auto-spf", spaceId: id }).id;
    expect(threadSpace(s.db, auto)).toEqual({ spaceId: id, spaceName: "Kitchen remodel" });
    const file = join(kitchen, "notes.md");
    const run = (n: number) => ctx(auto, { runId: `run_auto_${n}`, unattended: true });
    expect(passes(await decide(s, "read_file", file, run(1)))).toBe(true);
    expect(await decide(s, "write_file", file, run(1))).toMatchObject({
      decision: "deny",
      rule: "folder:read_only",
    });
    const detail = await owner.call<Json>("spaces.settings.set", {
      spaceId: id,
      automationsWrite: [{ path: kitchen, allow: true }],
    });
    expect(detail.folders[0].automationsWrite).toBe(true);
    expect(passes(await decide(s, "write_file", file, run(1)))).toBe(true);
    // A folder the Space does not hold is refused, and nothing changes.
    const bad = await ask(owner, "spaces.settings.set", {
      spaceId: id,
      automationsWrite: [{ path: join(work, "jobs"), allow: true }],
    });
    expect(bad.error?.code).toBe("not_found");
  });

  it("archiving stops the folders at once; restoring brings them back; deleting removes them (SR14)", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const kitchen = join(work, "kitchen");
    await owner.call("spaces.folders.add", { spaceId: id, path: kitchen }, ik());
    const chat = await chatIn(owner, id);
    const c = ctx(chat);
    const file = join(kitchen, "a.txt");
    expect(passes(await decide(s, "read_file", file, c))).toBe(true);
    await owner.call("spaces.archive", { spaceId: id }, ik());
    // The same run: stopped on its next call.
    expect((await decide(s, "read_file", file, c)).rule).toBe("folder:not_granted");
    const listed = (await owner.call<Json>("access.list", {})).entries as Json[];
    expect(listed.some((e) => e.scope === "space")).toBe(false);
    const add = await ask(
      owner,
      "spaces.folders.add",
      { spaceId: id, path: join(work, "jobs") },
      ik(),
    );
    expect(add.error?.code).toBe("conflict");
    await owner.call("spaces.restore", { spaceId: id }, ik());
    expect(passes(await decide(s, "read_file", file, ctx(chat, { runId: "run_2" })))).toBe(true);
    await owner.call("spaces.delete", { spaceId: id }, ik());
    expect((await decide(s, "read_file", file, ctx(chat, { runId: "run_2" }))).rule).toBe(
      "folder:not_granted",
    );
    expect(s.db.sqlite.prepare("SELECT count(*) AS n FROM space_folders").get()).toEqual({ n: 0 });
  });

  it("a root swapped for a link after it was added stops counting", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const root = join(work, "swap");
    mkdirSync(root);
    await owner.call("spaces.folders.add", { spaceId: id, path: root, mode: "rw" }, ik());
    const chat = await chatIn(owner, id);
    const file = join(root, "a.txt");
    expect(passes(await decide(s, "read_file", file, ctx(chat)))).toBe(true);
    rmSync(root, { recursive: true });
    symlinkSync(join(work, "elsewhere"), root);
    offset += FOLDER_FRESH_MS + 1;
    s.rawBroker.liveSessionFolders(chat, `run_${chat}`);
    await s.rawBroker.foldersSettled();
    expect((await decide(s, "read_file", file, ctx(chat))).rule).toBe("folder:not_granted");
    const row = ((await owner.call<Json>("access.list", {})).entries as Json[]).find(
      (e) => e.scope === "space",
    );
    expect(row?.refused).toBe(true);
  });
});

describe("access.list and access.revoke", () => {
  it("lists each Space folder as its own row and revokes it", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const kitchen = join(work, "kitchen");
    await owner.call("spaces.folders.add", { spaceId: id, path: kitchen, mode: "rw" }, ik());
    const chat = await chatIn(owner, id);
    const entries = (await owner.call<Json>("access.list", {})).entries as Json[];
    const row = entries.find((e) => e.scope === "space");
    expect(row).toMatchObject({
      type: "folder",
      scope: "space",
      label: `Kitchen remodel · ${kitchen}`,
      path: kitchen,
      mode: "rw",
      spaceId: id,
      spaceName: "Kitchen remodel",
      automationsWrite: false,
    });
    expect(passes(await decide(s, "read_file", join(kitchen, "a"), ctx(chat)))).toBe(true);
    const r = await owner.call<Json>("access.revoke", { entryId: row?.id });
    expect(r.revoked).toBe(true);
    expect((await decide(s, "read_file", join(kitchen, "a"), ctx(chat))).rule).toBe(
      "folder:not_granted",
    );
    const detail = await owner.call<Json>("spaces.get", { spaceId: id });
    expect(detail.folders).toEqual([]);
    await owner.waitForEvent(
      (e) => e.event === "space.updated" && (e as Json).payload?.changed?.includes("folders"),
    );
  });

  it("stores the owner's defaults (they only ever narrow at run time)", async () => {
    const { owner } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const d = await owner.call<Json>("spaces.settings.set", {
      spaceId: id,
      defaultPermissionMode: "manual",
      connectorScope: ["google", "google"],
    });
    expect(d.space).toMatchObject({ defaultPermissionMode: "manual", connectorScope: ["google"] });
    const cleared = await owner.call<Json>("spaces.settings.set", {
      spaceId: id,
      defaultPermissionMode: null,
      connectorScope: null,
    });
    expect(cleared.space).toMatchObject({ defaultPermissionMode: null, connectorScope: null });
  });
});

describe("r2 follow-ups: specialists, the loop's hint and the share check", () => {
  it("a specialist job inherits the Space's folders through the cross-checked hint; a main thread does not", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const kitchen = join(work, "kitchen");
    await owner.call("spaces.folders.add", { spaceId: id, path: kitchen, mode: "rw" }, ik());
    const chat = await chatIn(owner, id);
    const job = createThread(s.db, {
      kind: "subagent",
      sessionKey: "specialist:r:1",
      parentThreadId: chat,
    }).id;
    const main = createThread(s.db, { kind: "main", sessionKey: "main-hint" }).id;
    await s.rawBroker.foldersSettled();
    const file = join(kitchen, "plans", "tile.md");
    const bind = (threadId: string) =>
      s.rawBroker.bindRun({
        threadId,
        runId: `run_${threadId}`,
        unattended: false,
        space: { id, name: "Kitchen remodel" },
      });
    const call = (threadId: string) => {
      const params = { tool: "read_file", target: file };
      return s.rawBroker.decide(
        {
          tool: "read_file",
          sideEffect: "read",
          target: { kind: "path", value: file },
          targetKind: "path",
          params,
          paramsHash: sha256(JSON.stringify(params)),
        },
        ctx(threadId),
      );
    };
    bind(job);
    expect(passes(await call(job))).toBe(true);
    // A caller naming the Space for the main chat gets nothing.
    bind(main);
    expect(await call(main)).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
  });

  it("a pick a row of the same Space already covers adds no narrower row (PB, PC)", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const src = spaceFolderSource(s.db);
    const kitchen = join(work, "kitchen");
    const plans = join(kitchen, "plans");
    expect(src.add(id, { path: kitchen, real: kitchen, mode: "rw" }, {})).toBe("added");
    s.db.sqlite.prepare("UPDATE space_folders SET automations_write = 1").run();
    expect(src.add(id, { path: plans, real: plans, mode: "ro" }, {})).toBe("added");
    expect(src.add(id, { path: plans, real: plans, mode: "rw" }, {})).toBe("added");
    expect(src.folders(id).map((f) => f.path)).toEqual([kitchen]);
    // A read-only parent does not cover a read & write pick: that one is a real row.
    const jobs = join(work, "jobs");
    const sub = join(jobs, "x");
    src.add(id, { path: jobs, real: jobs, mode: "ro" }, {});
    src.add(id, { path: sub, real: sub, mode: "rw" }, {});
    expect(src.folders(id).map((f) => f.path)).toContain(sub);
  });

  it("the share check counts the thread's current Space folders, storing nothing", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const kitchen = join(work, "kitchen");
    await owner.call("spaces.folders.add", { spaceId: id, path: kitchen, mode: "rw" }, ik());
    const chat = await chatIn(owner, id);
    const loose = (await owner.call<Json>("threads.create", { kind: "side", title: "x" }, ik()))
      .thread.id;
    await s.rawBroker.foldersSettled();
    expect(s.rawBroker.spaceFoldersOfThread(chat).map((f) => f.path)).toEqual([kitchen]);
    expect(s.rawBroker.spaceFoldersOfThread(loose)).toEqual([]);
    expect(s.rawBroker.liveSessionFolders(chat)).toEqual([]);
  });
});

describe("spaceFolderSource (the broker's view)", () => {
  it("a pick widens a folder to read & write, never narrows it, and refuses an archived Space", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const src = spaceFolderSource(s.db);
    const kitchen = join(work, "kitchen");
    src.add(id, { path: kitchen, real: kitchen, mode: "rw" }, { deviceId: "dev_mac" });
    src.add(id, { path: kitchen, real: kitchen, mode: "ro" }, {});
    expect(src.folders(id).map((f) => f.mode)).toEqual(["rw"]);
    await owner.call("spaces.archive", { spaceId: id }, ik());
    expect(src.folders(id)).toEqual([]);
    expect(src.all()).toEqual([]);
    expect(() => src.add(id, { path: kitchen, real: kitchen, mode: "ro" }, {})).toThrow();
  });

  it("a card never raises to read & write a folder automations may write in (SP8)", async () => {
    const { owner, s } = await setup();
    const id = await space(owner, "Kitchen remodel");
    const src = spaceFolderSource(s.db);
    const kitchen = join(work, "kitchen");
    const jobs = join(work, "jobs");
    expect(src.add(id, { path: kitchen, real: kitchen, mode: "ro" }, {})).toBe("added");
    expect(src.add(id, { path: jobs, real: jobs, mode: "ro" }, {})).toBe("added");
    s.db.sqlite
      .prepare("UPDATE space_folders SET automations_write = 1 WHERE path = ?")
      .run(kitchen);
    expect(src.add(id, { path: kitchen, real: kitchen, mode: "rw" }, {})).toBe("not_raised");
    // Without the flag a card may raise it; a new folder never gets the flag.
    expect(src.add(id, { path: jobs, real: jobs, mode: "rw" }, {})).toBe("added");
    const byPath = new Map(src.folders(id).map((f) => [f.path, f]));
    expect(byPath.get(kitchen)).toMatchObject({ mode: "ro", automationsWrite: true });
    expect(byPath.get(jobs)).toMatchObject({ mode: "rw", automationsWrite: false });
  });
});
