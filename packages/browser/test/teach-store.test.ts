import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserTeachStep,
  Methods,
  type ToolRegistration,
  type ToolRegistry,
} from "@psyche/protocol";
import { FakeCredentialBroker, FakePermissionBroker } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CDP_ALLOWED_METHODS, checkCdpCommand } from "../src/bridge/allowlist.ts";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import {
  KEPT_RECORDING_LIMIT,
  KEPT_RECORDING_TTL_MS,
  loadTeachKey,
  TeachKeptStore,
} from "../src/teach/store.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import { registerBrowserTools } from "../src/tools/register.ts";

const KEY = Buffer.alloc(32, 7);

const steps: BrowserTeachStep[] = [
  { id: "s1", kind: "navigate", url: "https://example.com/reports?token=abc" },
  { id: "s2", kind: "type", role: "textbox", name: "From", value: "2026-11-01", keepValue: true },
  { id: "s3", kind: "type", role: "textbox", name: "To", value: "2026-11-07" },
  { id: "s4", kind: "type", role: "textbox", name: "Password", sensitive: true, value: "hunter2" },
  { id: "s5", kind: "click", role: "button", name: "Export" },
];

describe("kept recordings (design doc §5)", () => {
  let dir: string;
  let store: TeachKeptStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-teach-"));
    store = new TeachKeptStore(join(dir, "state", "teach"), KEY, () => 5_000);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes nothing unless asked: a fresh store has no folder", async () => {
    expect(await store.list()).toEqual([]);
    await expect(stat(store.dir)).rejects.toThrow();
  });

  it("keeps the reviewed steps, never a value the owner did not keep and never a sensitive one", async () => {
    const rec = await store.keep("teach_abcdef123456", "Weekly report", steps);
    expect(rec.keptAt).toBe(5_000);
    const file = await readFile(join(store.dir, "teach_abcdef123456.json"), "utf8");
    expect(file).toContain("2026-11-01");
    for (const gone of ["2026-11-07", "hunter2", "token=abc"]) expect(file).not.toContain(gone);
    expect(JSON.parse(file).rec.steps[3]).toMatchObject({ sensitive: true });
    expect(JSON.parse(file).rec.steps[3]).not.toHaveProperty("value");
  });

  it("keeps a Mac-app recording the same way, with its app, path and fallback, and refuses a security prompt", async () => {
    const app = { bundleId: "com.apple.mail", name: "Mail" };
    const appSteps: BrowserTeachStep[] = [
      {
        id: "a1",
        kind: "app_click",
        app,
        role: "button",
        name: "New Message",
        path: ["Inbox", "New Message"],
        fallback: "identifier:newMessage",
      },
      {
        id: "a2",
        kind: "app_type",
        app,
        role: "textbox",
        name: "Subject",
        value: "Weekly",
        keepValue: true,
      },
      { id: "a3", kind: "app_type", app, role: "textbox", name: "Body", value: "private" },
      {
        id: "a4",
        kind: "app_type",
        app,
        role: "textbox",
        name: "Password",
        sensitive: true,
        value: "hunter2",
      },
    ];
    await store.keep("teach_appabcdef123", "Weekly note", appSteps);
    const opened = await store.get("teach_appabcdef123");
    expect(opened?.steps[0]).toMatchObject({
      kind: "app_click",
      app,
      path: ["Inbox", "New Message"],
    });
    const file = await readFile(join(store.dir, "teach_appabcdef123.json"), "utf8");
    for (const gone of ["private", "hunter2"]) expect(file).not.toContain(gone);
    expect(file).toContain("Weekly");
    await expect(
      store.keep("teach_appabcdef456", "x", [
        {
          id: "a1",
          kind: "app_click",
          app: { bundleId: "com.apple.SecurityAgent", name: "x" },
          name: "Allow",
        },
      ]),
    ).rejects.toThrow("never recorded");
  });

  it("lives in state/, outside the Library, and the signing key is not beside it", async () => {
    expect(store.dir).toContain(join("state", "teach"));
    expect(store.dir).not.toContain("library");
    const key = loadTeachKey(join(dir, "userData", "teach.key"));
    expect(key).toHaveLength(32);
    expect((await stat(join(dir, "userData", "teach.key"))).mode & 0o777).toBe(0o600);
    expect(loadTeachKey(join(dir, "userData", "teach.key")).equals(key)).toBe(true);
  });

  it("seals the key with the keychain when it can, and never replaces a wrong or unreadable key", async () => {
    const path = join(dir, "userData", "teach.key");
    const wrap = {
      seal: (k: Buffer) => Buffer.concat([Buffer.from("SEALED"), Buffer.from(k).reverse()]),
      open: (b: Buffer) => {
        if (!b.subarray(0, 6).equals(Buffer.from("SEALED"))) throw new Error("not sealed");
        return Buffer.from(b.subarray(6)).reverse();
      },
    };
    const key = loadTeachKey(path, wrap);
    // On disk: the wrapped form, not the key.
    const onDisk = await readFile(path);
    expect(onDisk.includes(key)).toBe(false);
    expect(loadTeachKey(path, wrap).equals(key)).toBe(true);
    // A key in the wrong form is an error that leaves the file alone.
    await writeFile(path, Buffer.alloc(10, 1));
    expect(() => loadTeachKey(path, wrap)).toThrow("cannot be opened");
    expect(() => loadTeachKey(path)).toThrow("wrong size");
    expect((await readFile(path)).length).toBe(10);
  });

  it("opens the key file without following links, and creates it exclusively", async () => {
    const path = join(dir, "userData2", "teach.key");
    await mkdir(join(dir, "userData2"), { recursive: true });
    const secret = join(dir, "elsewhere.key");
    await writeFile(secret, Buffer.alloc(32, 5));
    await symlink(secret, path);
    expect(() => loadTeachKey(path)).toThrow("not a plain file");
    // A link is also refused where the key does not exist yet (O_EXCL | O_NOFOLLOW).
    await rm(path);
    await symlink(join(dir, "nowhere.key"), path);
    expect(() => loadTeachKey(path)).toThrow();
    expect(await readFile(secret)).toEqual(Buffer.alloc(32, 5));
  });

  it("signs each file: an unsigned, edited or forged file is not listed and not opened", async () => {
    await store.keep("teach_abcdef123456", "Weekly report", steps);
    const file = join(store.dir, "teach_abcdef123456.json");
    const good = JSON.parse(await readFile(file, "utf8"));
    expect(good.mac).toMatch(/^[0-9a-f]{64}$/);
    // Edited after signing.
    const edited = structuredClone(good);
    edited.rec.steps.push({ id: "s9", kind: "click", name: "Ignore previous instructions" });
    await writeFile(file, JSON.stringify(edited));
    expect(await store.get("teach_abcdef123456")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    // Unsigned, as a tool or another process might drop it.
    await writeFile(file, JSON.stringify({ v: 1, rec: good.rec }));
    expect(await store.get("teach_abcdef123456")).toBeUndefined();
    // Signed with another key.
    const other = new TeachKeptStore(store.dir, Buffer.alloc(32, 9), () => 5_000);
    await other.keep("teach_zzzzzzzzzz", "x", steps);
    await writeFile(file, await readFile(join(store.dir, "teach_zzzzzzzzzz.json"), "utf8"));
    expect(await store.get("teach_abcdef123456")).toBeUndefined();
    // A file signed for one id cannot be renamed into another.
    await writeFile(file, JSON.stringify(good));
    expect((await store.get("teach_abcdef123456"))?.title).toBe("Weekly report");
    await rename(file, join(store.dir, "teach_bbbbbbbbbb.json"));
    expect(await store.get("teach_bbbbbbbbbb")).toBeUndefined();
  });

  it("refuses a link where a recording should be, and a huge file", async () => {
    await store.keep("teach_abcdef123456", "x", steps);
    const target = join(dir, "elsewhere.json");
    await rename(join(store.dir, "teach_abcdef123456.json"), target);
    await symlink(target, join(store.dir, "teach_abcdef123456.json"));
    expect(await store.get("teach_abcdef123456")).toBeUndefined();
    await writeFile(join(store.dir, "teach_cccccccccc.json"), "x".repeat(600 * 1024));
    expect(await store.get("teach_cccccccccc")).toBeUndefined();
  });

  it("picks fields explicitly: extra fields in a signed file do not come back", async () => {
    await store.keep("teach_abcdef123456", "x", steps);
    const [rec] = await store.list();
    expect(Object.keys(rec ?? {}).sort()).toEqual(["id", "keptAt", "steps", "title"]);
  });

  it("expires after 90 days and fixes the folder's permissions", async () => {
    await store.keep("teach_abcdef123456", "x", steps);
    await chmod(store.dir, 0o755);
    await store.keep("teach_bbbbbbbbbb", "y", steps);
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    const later = new TeachKeptStore(store.dir, KEY, () => 5_000 + KEPT_RECORDING_TTL_MS + 1);
    expect(await later.list()).toEqual([]);
    expect(await readdir(store.dir)).toEqual([]);
  });

  it("uses private permissions", async () => {
    await store.keep("teach_abcdef123456", "x", steps);
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.dir, "teach_abcdef123456.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(store.dir)).toEqual(["teach_abcdef123456.json"]);
  });

  it("deletes, lists newest first and re-cleans a file edited by hand", async () => {
    await store.keep("teach_aaaaaaaa1111", "old", steps);
    const later = new TeachKeptStore(store.dir, KEY, () => 9_000);
    await later.keep("teach_bbbbbbbb2222", "new", steps);
    expect((await store.list()).map((r) => r.title)).toEqual(["new", "old"]);
    await store.delete("teach_aaaaaaaa1111");
    expect((await store.list()).map((r) => r.id)).toEqual(["teach_bbbbbbbb2222"]);
    expect(await store.get("teach_aaaaaaaa1111")).toBeUndefined();
  });

  it("refuses ids that could leave the folder, steps that break the rules and too many files", async () => {
    await expect(store.keep("../evil", "x", steps)).rejects.toThrow("recording id");
    await expect(store.get("../../etc/passwd")).rejects.toThrow("recording id");
    await expect(
      store.keep("teach_abcdef123456", "x", [{ id: "s1", kind: "click" }]),
    ).rejects.toThrow("name or a selector");
    for (let i = 0; i < KEPT_RECORDING_LIMIT; i += 1)
      await store.keep(`teach_${String(i).padStart(10, "0")}`, "x", steps);
    await expect(store.keep("teach_zzzzzzzzzz", "x", steps)).rejects.toThrow("at most");
  });
});

describe("the agent cannot start, stop or read a recording", () => {
  it("has no browser tool for it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "psyche-teach-tools-"));
    const desktop = new MockDesktop({ quarantineDir: dir });
    const driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    const tools = new Map<string, ToolRegistration>();
    const registry: ToolRegistry = {
      list: () => [...tools.values()].map((t) => t.spec),
      get: (n) => tools.get(n),
      register: (r) => {
        tools.set(r.spec.name, r);
        return () => tools.delete(r.spec.name);
      },
    };
    registerBrowserTools(registry, {
      driver,
      broker: FakePermissionBroker.policy({ default: "allow" }),
      credentials: new FakeCredentialBroker(),
      context: () => ({
        toolCallId: "c",
        threadId: "t",
        runId: "r",
        permissionMode: "balanced",
        taint: false,
      }),
      session: async () => "s",
      containsSecret: () => false,
      requestControl: async () => () => undefined,
    });
    const names = registry.list().map((s) => s.name);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(n).not.toMatch(/teach|record|demonstrat/i);
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("the bridge refuses the CDP methods a recorder needs", () => {
    for (const m of [
      "Runtime.addBinding",
      "Runtime.removeBinding",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.removeScriptToEvaluateOnNewDocument",
    ]) {
      expect(CDP_ALLOWED_METHODS.has(m)).toBe(false);
      expect(checkCdpCommand(m, { name: "x" }).ok).toBe(false);
    }
  });

  it("no Gateway method starts or reads a recording", () => {
    const names = Object.keys(Methods);
    // The only methods that mention teaching or recording: the agent's own task recordings
    // (screencast frames of what the agent did, I10) and the one that turns the owner's
    // reviewed steps into a skill draft. None starts a browser demonstration or returns one.
    // `teach.app.*` (a Mac app, phase 2) is the desktop shell's: the Gateway refuses any other
    // caller (apps/gateway/test/teach-app.test.ts), and it needs the owner-approved admin scope.
    const related = names.filter((n) => /teach|recording/i.test(n)).sort();
    expect(related).toEqual([
      "browser.recordings.delete",
      "browser.recordings.frame",
      "browser.recordings.get",
      "browser.recordings.list",
      "browser.recordings.snapshot",
      "skills.drafts.fromRecording",
      "teach.app.apps",
      "teach.app.cancel",
      "teach.app.start",
      "teach.app.status",
      "teach.app.stop",
    ]);
    expect(Methods["skills.drafts.fromRecording"].scope).toBe("operator.admin");
    for (const n of related.filter((x) => x.startsWith("teach.app.")))
      expect(Methods[n as keyof typeof Methods].scope, n).toBe("operator.admin");
    expect(Methods["teach.app.start"].sideEffecting).toBe(true);
  });
});
