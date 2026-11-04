import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
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
import { KEPT_RECORDING_LIMIT, TeachKeptStore } from "../src/teach/store.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import { registerBrowserTools } from "../src/tools/register.ts";

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
    store = new TeachKeptStore(join(dir, "library", "teach"), () => 5_000);
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
    expect(JSON.parse(file).steps[3]).toMatchObject({ sensitive: true });
    expect(JSON.parse(file).steps[3]).not.toHaveProperty("value");
  });

  it("uses private permissions", async () => {
    await store.keep("teach_abcdef123456", "x", steps);
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.dir, "teach_abcdef123456.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(store.dir)).toEqual(["teach_abcdef123456.json"]);
  });

  it("deletes, lists newest first and re-cleans a file edited by hand", async () => {
    await store.keep("teach_aaaaaaaa1111", "old", steps);
    const later = new TeachKeptStore(store.dir, () => 9_000);
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
    // reviewed steps into a skill draft. None starts a demonstration or returns one.
    const related = names.filter((n) => /teach|recording/i.test(n)).sort();
    expect(related).toEqual([
      "browser.recordings.delete",
      "browser.recordings.frame",
      "browser.recordings.get",
      "browser.recordings.list",
      "browser.recordings.snapshot",
      "skills.drafts.fromRecording",
    ]);
    expect(Methods["skills.drafts.fromRecording"].scope).toBe("operator.admin");
  });
});
