import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolvedSecret } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { FileRecordingSink, recordingDirName } from "../src/recording/recorder.ts";
import { RecordingStore } from "../src/recording/store.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";

const SECRET = "correct horse battery";

/** The vault's post-fill hygiene, as `CredentialBroker.redact` would do it. */
const redact = (text: string) => text.replaceAll(SECRET, "•••");

describe("recording (I10)", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  let library: FsQuarantineWriter;
  let store: RecordingStore;
  const live = new Map<string, FileRecordingSink>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-s08-rec-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    library = new FsQuarantineWriter(join(dir, "library"));
    driver = new CdpBridgeDriver(await desktop.connect(), { library, downloadTimeoutMs: 5000 });
    store = new RecordingStore(join(dir, "recordings"), {
      live: (id) => {
        const s = live.get(id);
        return s === undefined || s.closed ? undefined : s;
      },
      libraryItemId: (id) => library.recordings.get(id)?.libraryItemId,
    });
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("records navigations, snapshots and actions with credential fills redacted", async () => {
    const sink = new FileRecordingSink(join(dir, "recordings"), "task_rec", {
      taskId: "task_rec",
      threadId: "thr_1",
      redact,
      minIntervalMs: 0,
    });
    live.set("task_rec", sink);
    const a = desktop.browser.origin("a");
    const s = await driver.openSession({
      taskId: "task_rec",
      policy: { devPreview: true, readWritable: [a], readOnly: [desktop.browser.origin("b")] },
      recording: sink,
    });
    const t = await driver.openTab(s.id, desktop.browser.url("a/login"));
    const snap = await driver.snapshot(t.id);
    const ref = (role: string, name: string) =>
      snap.refs.find((r) => r.role === role && r.name.includes(name))?.ref ?? "";
    await driver.type(t.id, ref("textbox", "Username"), "ada");
    const secret = new ResolvedSecret(SECRET, {
      credentialId: "cred_site_a",
      target: { kind: "origin", value: a },
    });
    await driver.fillSecret(t.id, ref("textbox", "Password"), secret, a);
    // The model is clumsy and types the secret in plain text somewhere: the vault's redact
    // keeps it out of the recording too.
    await driver.navigate(t.id, desktop.browser.url("a/search"));
    const search = await driver.snapshot(t.id);
    const q = search.refs.find((r) => r.role === "searchbox")?.ref ?? "";
    await driver.type(t.id, q, `find ${SECRET}`, { submit: true });
    await driver.wait(t.id, { kind: "text", text: "q=" }, { timeoutMs: 5000 });
    desktop.takeControl(t.id, "keyboard");
    await new Promise((r) => setTimeout(r, 20));
    desktop.release(t.id);
    await new Promise((r) => setTimeout(r, 20));
    // A live recording is readable while the task runs.
    const liveGet = await store.get("task_rec");
    expect(liveGet.recording.endedAt).toBeNull();
    expect(liveGet.events.length).toBeGreaterThan(0);
    await driver.closeSession(s.id);

    const index = sink.index;
    expect(sink.closed).toBe(true);
    expect(index.endedAt).toBeDefined();
    const kinds = index.events.map((e) => `${e.kind}:${e.action ?? ""}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "tab:",
        "navigation:",
        "snapshot:",
        "action:type",
        "fill:fill_credential",
        "action:navigate",
        "control:",
      ]),
    );
    const tab = index.events.find((e) => e.kind === "tab");
    expect(tab).toMatchObject({
      detail: { partition: "clean", reason: "not_signed_in" },
      url: desktop.browser.url("a/login"),
    });
    const typed = index.events.find((e) => e.action === "type");
    expect(typed).toMatchObject({
      element: { role: "textbox", name: "Username" },
      detail: { text: "ada", submit: false },
      summary: 'Typed into textbox "Username"',
    });
    const fill = index.events.find((e) => e.kind === "fill");
    expect(fill).toMatchObject({
      element: { role: "textbox", name: "Password" },
      detail: { credentialId: "cred_site_a", origin: a },
    });
    const clumsy = index.events.filter((e) => e.action === "type")[1];
    expect(clumsy?.detail?.text).toBe("find •••");
    expect(clumsy?.summary).toContain("and submitted");
    const snapshots = index.events.filter((e) => e.kind === "snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[0]?.snapshotFile).toBe("s000001.txt");
    // Query strings never reach the index.
    for (const e of index.events) expect(e.url ?? "").not.toContain("?");
    for (const f of index.frames) expect(f.url).not.toContain("?");
    expect(index.frames.length).toBeGreaterThan(0);
    // Nothing on disk holds the secret, and the index is what the store reads back.
    const files = await readdir(sink.dir);
    expect(files).toContain("index.json");
    for (const f of files) {
      const text = await readFile(join(sink.dir, f), "latin1");
      expect(text, f).not.toContain(SECRET);
    }
    // Finished recordings are registered in the Library.
    expect(library.recordings.get("task_rec")).toMatchObject({
      taskId: "task_rec",
      threadId: "thr_1",
      dir: sink.dir,
    });

    // The store serves list, get, frame, snapshot and delete from the files.
    const list = await store.list({ taskId: "task_rec" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "task_rec",
      taskId: "task_rec",
      threadId: "thr_1",
      frameCount: index.frames.length,
      eventCount: index.events.length,
      libraryItemId: library.recordings.get("task_rec")?.libraryItemId,
    });
    expect(list[0]?.bytes).toBeGreaterThan(0);
    expect(await store.list({ taskId: "other" })).toHaveLength(0);
    const got = await store.get("task_rec", { sinceSeq: 1, limit: 3 });
    expect(got.events).toHaveLength(3);
    expect(got.events[0]?.seq).toBe(2);
    expect(got.events[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const snapEvent = got.events.find((e) => e.kind === "snapshot") ?? index.events[2];
    const first = (await store.get("task_rec")).events.find((e) => e.kind === "snapshot");
    expect(first?.snapshotSeq).toBe(first?.seq);
    expect(snapEvent).toBeDefined();
    const text = await store.snapshot("task_rec", first?.seq ?? 0);
    expect(text.text).toContain("Sign in");
    expect(text.text).not.toContain(SECRET);
    const frame = await store.frame("task_rec", 1);
    expect(frame.mime).toBe("image/jpeg");
    expect(frame.data.length).toBeGreaterThan(0);
    await expect(store.frame("task_rec", 9999)).rejects.toMatchObject({ code: "not_found" });
    await expect(store.snapshot("task_rec", 9999)).rejects.toMatchObject({ code: "not_found" });
    await store.delete("task_rec");
    await expect(store.get("task_rec")).rejects.toMatchObject({ code: "not_found" });
    expect(await store.list()).toHaveLength(0);
  });

  it("refuses to delete a live recording, reads v1 indexes and prunes old ones", async () => {
    const sink = new FileRecordingSink(join(dir, "recordings"), "thread:live", {
      threadId: "live",
    });
    live.set("thread:live", sink);
    await sink.event({ tabId: "t", kind: "tab", summary: "Opened a tab" });
    await expect(store.delete("thread:live")).rejects.toMatchObject({ code: "conflict" });
    await sink.end();
    live.delete("thread:live");

    // An M1 (frames-only) index still lists and replays.
    const old = join(dir, "recordings", recordingDirName("task_old"));
    await mkdir(old, { recursive: true });
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await writeFile(
      join(old, "index.json"),
      JSON.stringify({
        taskId: "task_old",
        startedAt: eightDaysAgo - 1000,
        endedAt: eightDaysAgo,
        frames: [{ seq: 1, tabId: "t", file: "000001.jpg", at: eightDaysAgo, url: "https://a/" }],
      }),
    );
    const got = await store.get("task_old");
    expect(got.recording).toMatchObject({ id: "task_old", frameCount: 1, eventCount: 0 });
    expect(got.events).toEqual([]);
    const ids = (await store.list()).map((r) => r.id).sort();
    expect(ids).toEqual(["task_old", "thread:live"]);
    expect(await store.prune(7 * 24 * 60 * 60 * 1000)).toEqual(["task_old"]);
    expect((await store.list()).map((r) => r.id)).toEqual(["thread:live"]);
    await store.delete("thread:live");
  });
});
