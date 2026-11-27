import { createHash } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

const sha = (n: number) => n.toString(16).padStart(64, "0");

describe("rescan (G7)", () => {
  it("finds an edit the watcher never reported, on the next rescan", async () => {
    env = await makeEnv();
    // Written before the watcher starts, so no event ever reaches it: only the rescan can see it.
    writeFileSync(join(env.workspace, "missed.md"), "rescan heron");
    env.store.watch({ debounceMs: 20, rescanMs: 50 });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await env.store.search("heron")).length === 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await env.store.search("heron")).length).toBe(1);
  });

  it("does not re-read the provenance sidecar directory while its mtime is unchanged", async () => {
    env = await makeEnv();
    const dir = join(env.workspace, ".psyche", "provenance");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "aaaaaaaaaaaaaaaa.json"),
      JSON.stringify({
        version: 2,
        files: { "notes.md": { provenance: "untrusted", sha256: sha(1) } },
      }),
    );
    const before = env.store.sidecarReads;
    await env.store.sync();
    expect(env.store.sidecarReads).toBe(before + 1);
    await env.store.sync();
    await env.store.sync();
    expect(env.store.sidecarReads).toBe(before + 1);

    // A new sidecar lands by rename, which moves the directory mtime: it is read again.
    writeFileSync(join(dir, "bbbbbbbbbbbbbbbb.json"), JSON.stringify({ version: 2, files: {} }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(dir, later, later);
    await env.store.sync();
    expect(env.store.sidecarReads).toBe(before + 2);
  });

  it("applies sidecar provenance to a file that arrived with it", async () => {
    env = await makeEnv();
    writeFileSync(join(env.workspace, "pulled.md"), "pulled otter");
    const dir = join(env.workspace, ".psyche", "provenance");
    mkdirSync(dir, { recursive: true });
    const digest = createHash("sha256").update("pulled otter").digest("hex");
    writeFileSync(
      join(dir, "cccccccccccccccc.json"),
      JSON.stringify({
        version: 2,
        files: { "pulled.md": { provenance: "untrusted", sha256: digest } },
      }),
    );
    await env.store.sync();
    expect(env.store.contentProvenance("pulled.md")).toBe("untrusted");
  });
});

describe("armed boot (G12)", () => {
  it("does not sync until the boot runs, and an early read waits for the first sync", async () => {
    env = await makeEnv({ init: false });
    writeFileSync(join(env.workspace, "boot.md"), "boot walrus");
    env.store.armBoot();
    const syncSpy = vi.spyOn(env.store, "sync");

    let answered = false;
    const early = env.store.search("walrus").then((hits) => {
      answered = true;
      return hits;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(syncSpy).not.toHaveBeenCalled();
    expect(answered).toBe(false);

    const booted = env.store.runBoot();
    const hits = await early;
    await booted;
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(hits.map((h) => h.chunk.source)).toContain("boot.md");
  });

  it("runs the plain init when nothing was armed", async () => {
    env = await makeEnv({ init: false });
    await env.store.runBoot();
    expect((await env.store.readFile("USER.md"))?.content).toBeDefined();
  });
});
