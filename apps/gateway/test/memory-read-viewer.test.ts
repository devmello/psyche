import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryHandlers } from "@psyche/memory";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { mountMemoryHandlers } from "../src/compose/memory-chunks.ts";
import type { Call } from "../src/context.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, remoteClient, type TestClient } from "./helpers.ts";

/**
 * `memory.read` and `memory.files.list` (QA 2026-11-25, bug 8): search hides workspace files from
 * a connection that may not open Memory, so reading and listing them is held to the same rule.
 * Two lists: what such a connection is refused, and what it still gets (the persona file, which
 * `memory.persona.get` already returns). The desktop app and the Host CLI are the controls.
 */

const call = (identity: Partial<Call["identity"]>): Call => ({ identity }) as unknown as Call;
const desktop = call({ role: "client", desktopShell: true });
const hostCli = call({ role: "client", localHostCli: true });
const phone = call({ role: "client", deviceId: "dev_phone" });
const remote = call({ role: "client", deviceId: "dev_remote", localHostCli: undefined });
const helper = call({ role: "node" });

const FILES = [
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "SOUL.md",
  "memory/2026-10-18.md",
  "people/dana-whitfield.md",
].map((path) => ({ path, bytes: 10, protected: false }));

function build() {
  const handlers = {
    "memory.read": vi.fn(async (p: { path: string }) => ({
      path: p.path,
      content: `secret of ${p.path}`,
      etag: "e",
      updatedAt: "2026-10-18T00:00:00.000Z",
    })),
    "memory.files.list": vi.fn(async () => ({ files: FILES })),
  };
  const mounted = mountMemoryHandlers(
    handlers as unknown as MemoryHandlers,
    {
      getClaim: vi.fn(),
    } as never,
  );
  const run = (name: string, c: Call, params: unknown) =>
    (mounted[name] as { run: (c: Call, p: never) => Promise<unknown> }).run(c, params as never);
  return { handlers, run };
}

const REFUSED_PATHS = [
  "USER.md",
  "user.md",
  "MEMORY.md",
  "SOUL.md",
  "memory/2026-10-18.md",
  "people/dana-whitfield.md",
  "./IDENTITY.md", // another spelling of an allowed file is refused, not resolved
  "/IDENTITY.md",
  "memory/../USER.md",
  "IDENTITY.md/",
  "IDENTITY.md ",
  "notes/IDENTITY.md",
  "",
];
const ALLOWED_PATHS = ["IDENTITY.md", "identity.md", "Identity.MD"];
const OTHERS = [
  ["a paired phone", phone],
  ["a remote client", remote],
  ["a helper node", helper],
] as const;

describe("memory.read per connection (handlers)", () => {
  it.each(["USER.md", "memory/2026-10-18.md", "IDENTITY.md"])(
    "desktop app and Host CLI read %s (positive control)",
    async (path) => {
      for (const c of [desktop, hostCli]) {
        const { run } = build();
        expect(await run("memory.read", c, { path })).toMatchObject({
          content: `secret of ${path}`,
        });
      }
    },
  );

  for (const [who, c] of OTHERS) {
    it.each(REFUSED_PATHS)(`refuses %j for ${who} and never reads it`, async (path) => {
      const { run, handlers } = build();
      await expect(run("memory.read", c, { path })).rejects.toMatchObject({
        code: "forbidden",
        details: { reason: "not_desktop" },
      });
      expect(handlers["memory.read"]).not.toHaveBeenCalled();
    });
  }

  it.each(ALLOWED_PATHS)("a phone still reads the persona file as %s", async (path) => {
    const { run } = build();
    expect(await run("memory.read", phone, { path })).toMatchObject({ path });
  });

  it("a missing file is refused like an existing one (no existence oracle)", async () => {
    const { run } = build();
    const a = await run("memory.read", phone, { path: "USER.md" }).catch((e) => e);
    const b = await run("memory.read", phone, { path: "no/such/file.md" }).catch((e) => e);
    expect(a.code).toBe("forbidden");
    expect(b.code).toBe(a.code);
    expect(b.message).toBe(a.message);
  });
});

describe("memory.files.list per connection (handlers)", () => {
  it("desktop app and Host CLI list every file (positive control)", async () => {
    for (const c of [desktop, hostCli]) {
      const { run } = build();
      const r = (await run("memory.files.list", c, {})) as { files: { path: string }[] };
      expect(r.files.map((f) => f.path)).toEqual(FILES.map((f) => f.path));
    }
  });

  it.each(OTHERS)("%s sees only the persona file", async (_n, c) => {
    const { run } = build();
    const r = (await run("memory.files.list", c, {})) as { files: { path: string }[] };
    expect(r.files.map((f) => f.path)).toEqual(["IDENTITY.md"]);
    expect(JSON.stringify(r)).not.toContain("dana-whitfield");
  });
});

describe("memory.read through the composed Gateway", () => {
  let composed: ComposedGateway | null = null;
  let home = "";
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await composed?.stop("test");
    composed = null;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("the QA case: search hides USER.md from a phone and so does read; the desktop gets both", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-memread-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const desk = await adminClient(composed.gateway);
    const phoneClient = await remoteClient(composed.gateway);
    clients.push(desk, phoneClient);
    await desk.call(
      "memory.write",
      { path: "USER.md", content: "Likes oolong tea and a red kayak." },
      ik(),
    );
    // Control: the desktop reads the file it wrote.
    const d = await desk.call<{ content: string }>("memory.read", { path: "USER.md" });
    expect(d.content).toContain("oolong");
    // The phone: search gets nothing (as before) and read is refused now.
    expect(await phoneClient.call("memory.search", { query: "tea" })).toEqual({ hits: [] });
    const res = await phoneClient.request("memory.read", { path: "USER.md" });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("forbidden");
    expect(JSON.stringify(res)).not.toContain("oolong");
    // The list leaves USER.md out for the phone and keeps it for the desktop.
    const phoneList = await phoneClient.call<{ files: { path: string }[] }>(
      "memory.files.list",
      {},
    );
    const deskList = await desk.call<{ files: { path: string }[] }>("memory.files.list", {});
    expect(phoneList.files.map((f) => f.path)).not.toContain("USER.md");
    expect(deskList.files.map((f) => f.path)).toContain("USER.md");
    // What iOS keeps: the persona and the claims list still answer for the phone.
    expect((await phoneClient.request("memory.persona.get", {})).ok).toBe(true);
    expect((await phoneClient.request("memory.claims.list", {})).ok).toBe(true);
    expect((await phoneClient.request("memory.status", {})).ok).toBe(true);
  });
});
