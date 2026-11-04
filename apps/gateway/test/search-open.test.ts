import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import {
  createSearchIndex,
  defaultSourcesConfig,
  SourceIndexer,
  type SourceItem,
} from "@psyche/search";
import { afterEach, describe, expect, it } from "vitest";
import { searchOpenHandlers, VIEWER_TEXT_CHARS } from "../src/compose/search-open.ts";
import type { Call } from "../src/context.ts";

const NOW = Date.UTC(2026, 9, 18, 20, 0, 0);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "psyche-gw-open-")));
  dirs.push(d);
  return d;
};

const call = (identity: Partial<Call["identity"]>): Call => ({ identity }) as unknown as Call;
const desktop = call({ role: "client", desktopShell: true });
const phone = call({ role: "client" });
const helper = call({ role: "node" });

const item = (nativeId: string, over: Partial<SourceItem> = {}): SourceItem => ({
  nativeId,
  title: `Title ${nativeId}`,
  text: `Body of ${nativeId}`,
  createdAt: NOW - 86_400_000,
  provenance: "untrusted",
  ...over,
});

async function world(folders: string[] = []) {
  const index = createSearchIndex({ now: () => NOW });
  const config = defaultSourcesConfig();
  const indexer = new SourceIndexer(index, [], { config: () => config, now: () => NOW });
  let memoryBlocked: string | undefined;
  const granted = { list: folders };
  const h = searchOpenHandlers({
    indexer: () => indexer,
    folders: () => granted.list.map((path) => ({ path })),
    memoryBlocked: () => memoryBlocked,
  });
  const run = async (name: string, c: Call, id: string) => h[name]?.run(c, { id } as never);
  return {
    indexer,
    granted,
    run,
    blockMemory: (why: string | undefined) => (memoryBlocked = why),
  };
}

const code = async (p: unknown): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof PsycheError ? e.code : "other";
  }
};

describe("search.document", () => {
  it("returns the passage the index holds, with its source, date and which opener it has", async () => {
    const w = await world();
    await w.indexer.ingest("mail", [item("1", { openRef: "a@host.example" })]);
    await w.indexer.ingest("notes", [item("n1", { provenance: "owner" })]);
    expect(await w.run("search.document", phone, "mail:1")).toEqual({
      id: "mail:1",
      source: "mail",
      title: "Title 1",
      text: "Body of 1",
      truncated: false,
      createdAt: NOW - 86_400_000,
      provenance: "untrusted",
      open: "mail",
    });
    expect(await w.run("search.document", phone, "notes:n1")).toMatchObject({
      source: "notes",
      open: null,
    });
  });

  it("is the owner's: Messages, Contacts and Memory passages are readable by a paired client", async () => {
    const w = await world();
    await w.indexer.ingest("messages", [item("m1")]);
    await w.indexer.ingest("contacts", [item("c1")]);
    await w.indexer.ingest("memory", [item("f1")]);
    for (const [id, source] of [
      ["messages:m1", "messages"],
      ["contacts:c1", "contacts"],
      ["memory:f1", "memory"],
    ] as const)
      expect(await w.run("search.document", desktop, id), id).toMatchObject({ id, source });
  });

  it("is never the agent's: a Mac helper is refused, and the agent audience of the index gets none of the owner-only sources", async () => {
    const w = await world();
    await w.indexer.ingest("messages", [item("m1")]);
    expect(await code(w.run("search.document", helper, "messages:m1"))).toBe("forbidden");
    expect(w.indexer.document("messages:m1", "agent")).toBeUndefined();
  });

  it("is not_found for an unknown id, a document that is not a source passage and Memory while it is blocked", async () => {
    const w = await world();
    await w.indexer.ingest("memory", [item("f1")]);
    expect(await code(w.run("search.document", desktop, "mail:nope"))).toBe("not_found");
    expect(await code(w.run("search.document", desktop, "thread-1"))).toBe("not_found");
    w.blockMemory("memory is encrypted and search is not");
    expect(await code(w.run("search.document", desktop, "memory:f1"))).toBe("not_found");
    w.blockMemory(undefined);
    expect(await code(w.run("search.document", desktop, "memory:f1"))).toBeUndefined();
  });

  it("clips long text and says so", async () => {
    const w = await world();
    await w.indexer.ingest("notes", [item("big", { text: "x".repeat(VIEWER_TEXT_CHARS + 500) })]);
    const doc = (await w.run("search.document", desktop, "notes:big")) as {
      text: string;
      truncated: boolean;
    };
    expect(doc.truncated).toBe(true);
    expect(doc.text.length).toBe(VIEWER_TEXT_CHARS);
  });

  it("offers Mail only for a Message-ID of the right shape", async () => {
    const w = await world();
    // The Gateway checks the shape again when it serves a stored value (a damaged index, an
    // older build): a value that is not a Message-ID gives no opener and no target.
    await w.indexer.ingest("mail", [
      item("ok", { openRef: "a@host.example" }),
      item("none"),
      item("bad", { openRef: "x y@host.example" }),
      item("link", { openRef: "message://%3Ca@host.example%3E" }),
    ]);
    const open = async (id: string) =>
      ((await w.run("search.document", desktop, id)) as { open: unknown }).open;
    expect(await open("mail:ok")).toBe("mail");
    for (const id of ["mail:none", "mail:bad", "mail:link"]) {
      expect(await open(id), id).toBeNull();
      expect(await w.run("search.openSource", desktop, id), id).toEqual({ target: null });
    }
  });
});

describe("search.openSource", () => {
  it("answers the desktop app only: a phone, another paired device and the Mac helper are refused", async () => {
    const w = await world();
    await w.indexer.ingest("mail", [item("1", { openRef: "a@host.example" })]);
    expect(await code(w.run("search.openSource", phone, "mail:1"))).toBe("forbidden");
    expect(await code(w.run("search.openSource", helper, "mail:1"))).toBe("forbidden");
    expect(await w.run("search.openSource", desktop, "mail:1")).toEqual({
      target: { kind: "mail", messageId: "a@host.example" },
    });
  });

  it("has no target for a mail message without a Message-ID, nor for sources with no safe link", async () => {
    const w = await world();
    await w.indexer.ingest("mail", [item("1")]);
    await w.indexer.ingest("messages", [item("m1")]);
    await w.indexer.ingest("notes", [item("n1")]);
    await w.indexer.ingest("calendar", [item("e1")]);
    await w.indexer.ingest("reminders", [item("r1")]);
    await w.indexer.ingest("contacts", [item("c1")]);
    for (const id of [
      "mail:1",
      "messages:m1",
      "notes:n1",
      "calendar:e1",
      "reminders:r1",
      "contacts:c1",
    ])
      expect(await w.run("search.openSource", desktop, id), id).toEqual({ target: null });
  });

  it("takes the target from the index, never from the caller: a path or Message-ID in the id gets nothing", async () => {
    const w = await world();
    await w.indexer.ingest("mail", [item("1", { openRef: "a@host.example" })]);
    for (const id of [
      "message://%3Cevil%40x.example%3E",
      "file:///etc/passwd",
      "/etc/passwd",
      "evil@x.example",
    ])
      expect(await code(w.run("search.openSource", desktop, id)), id).toBe("not_found");
  });

  describe("files", () => {
    it("reveals a file inside a folder granted now, as its real path with the real roots", async () => {
      const root = tmp();
      writeFileSync(join(root, "plan.md"), "the plan");
      const w = await world([root]);
      const path = join(root, "plan.md");
      await w.indexer.ingest("files", [item(path, { path, provenance: "owner" })]);
      expect(await w.run("search.openSource", desktop, `files:${path}`)).toEqual({
        target: { kind: "file", path, roots: [root] },
      });
      expect(
        ((await w.run("search.document", desktop, `files:${path}`)) as { open: unknown }).open,
      ).toBe("file");
    });

    it("has no target once the folder is no longer granted", async () => {
      const root = tmp();
      writeFileSync(join(root, "plan.md"), "the plan");
      const w = await world([root]);
      const path = join(root, "plan.md");
      await w.indexer.ingest("files", [item(path, { path })]);
      w.granted.list = [];
      expect(await w.run("search.openSource", desktop, `files:${path}`)).toEqual({ target: null });
      expect(
        ((await w.run("search.document", desktop, `files:${path}`)) as { open: unknown }).open,
      ).toBeNull();
    });

    it("has no target for a file that now resolves outside the granted folder (symlink swapped in after indexing)", async () => {
      const root = tmp();
      const outside = tmp();
      writeFileSync(join(outside, "secret.txt"), "secret");
      const path = join(root, "plan.md");
      writeFileSync(path, "the plan");
      const w = await world([root]);
      await w.indexer.ingest("files", [item(path, { path })]);
      rmSync(path);
      symlinkSync(join(outside, "secret.txt"), path);
      expect(await w.run("search.openSource", desktop, `files:${path}`)).toEqual({ target: null });
    });

    it("has no target for a file that is gone or a path outside every granted folder", async () => {
      const root = tmp();
      mkdirSync(join(root, "sub"));
      const w = await world([root]);
      const gone = join(root, "gone.md");
      await w.indexer.ingest("files", [
        item(gone, { path: gone }),
        item("/etc/hosts", { path: "/etc/hosts" }),
      ]);
      expect(await w.run("search.openSource", desktop, `files:${gone}`)).toEqual({ target: null });
      expect(await w.run("search.openSource", desktop, "files:/etc/hosts")).toEqual({
        target: null,
      });
    });
  });
});
