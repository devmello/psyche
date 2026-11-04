import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AppleSourceDeps,
  appleAdapters,
  defaultSourcesConfig,
  messageIdFromLink,
  parseMessageId,
  resolveGrantedFile,
  SourceIndexer,
  type SourceItem,
  type ToolCall,
} from "../src/index.ts";
import { NOW, setup } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "psyche-open-")));
  dirs.push(d);
  return d;
};

describe("Message-ID shape", () => {
  it("accepts a plain msg-id, with or without one pair of brackets", () => {
    for (const ok of [
      "abc123@mail.example.com",
      "<abc123@mail.example.com>",
      "CAF=ab+cd.ef@mail.gmail.com",
      "20261001.1234.5@host_1.example-mail.net",
    ])
      expect(parseMessageId(ok), ok).toBe(ok.replace(/^<|>$/g, ""));
  });

  it("rejects anything that is not one: spaces, brackets, quotes, control characters, no host, other schemes", () => {
    const long = `${"a".repeat(260)}@example.com`;
    for (const bad of [
      "",
      "no-at-sign",
      "a@",
      "@host.com",
      "a b@host.com",
      "<<a@host.com>>",
      "<a@host.com",
      "a@host.com>",
      "a@[10.0.0.1]",
      'a"b@host.com',
      "a@host.com\n",
      "a@host.com\0",
      "a@host.com>%3Cb",
      "..a@host.com",
      "a..b@host.com",
      "message://%3Ca@host.com%3E",
      "file:///etc/passwd",
      "a@host.com/../../x",
      long,
    ])
      expect(parseMessageId(bad), JSON.stringify(bad)).toBeUndefined();
    expect(parseMessageId(42)).toBeUndefined();
    expect(parseMessageId(null)).toBeUndefined();
  });

  it("reads a message:// link back to its Message-ID, and nothing else", () => {
    expect(messageIdFromLink("message://%3Cabc%40mail.example.com%3E")).toBe(
      "abc@mail.example.com",
    );
    expect(messageIdFromLink("message://%3Cabc@mail.example.com%3E")).toBe("abc@mail.example.com");
    for (const bad of [
      "https://example.com",
      "message://",
      "message://%3Cnot a message id%3E",
      "message://%E0%A4%A",
      "message://%3Ca@b.c%3E/../x",
      "file:///x",
      undefined,
    ])
      expect(messageIdFromLink(bad), String(bad)).toBeUndefined();
  });
});

describe("resolveGrantedFile", () => {
  it("returns the real path of a file inside a granted folder", () => {
    const root = tmp();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.md"), "hello");
    const got = resolveGrantedFile(join(root, "docs", "a.md"), [root]);
    expect(got?.path).toBe(join(root, "docs", "a.md"));
    expect(got?.roots).toEqual([root]);
  });

  it("refuses a file outside every granted folder, a folder, a missing file, a relative path", () => {
    const root = tmp();
    const other = tmp();
    writeFileSync(join(other, "x.md"), "x");
    mkdirSync(join(root, "sub"));
    expect(resolveGrantedFile(join(other, "x.md"), [root])).toBeUndefined();
    expect(resolveGrantedFile(join(root, "sub"), [root])).toBeUndefined();
    expect(resolveGrantedFile(join(root, "gone.md"), [root])).toBeUndefined();
    expect(resolveGrantedFile("a.md", [root])).toBeUndefined();
    expect(resolveGrantedFile(`${join(root, "a.md")}\0`, [root])).toBeUndefined();
    expect(resolveGrantedFile(join(root, "sub"), [])).toBeUndefined();
  });

  it("refuses a sibling folder that only shares the granted folder's name as a prefix", () => {
    const base = tmp();
    mkdirSync(join(base, "docs"));
    mkdirSync(join(base, "docs-private"));
    writeFileSync(join(base, "docs-private", "s.md"), "secret");
    expect(resolveGrantedFile(join(base, "docs-private", "s.md"), [join(base, "docs")])).toBe(
      undefined,
    );
  });

  it("refuses a symlink that leaves the granted folder, and a `..` that does", () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(outside, join(root, "dir"));
    expect(resolveGrantedFile(join(root, "link.txt"), [root])).toBeUndefined();
    expect(resolveGrantedFile(join(root, "dir", "secret.txt"), [root])).toBeUndefined();
    mkdirSync(join(root, "in"));
    expect(
      resolveGrantedFile(join(root, "in", "..", "..", "x", "secret.txt"), [root]),
    ).toBeUndefined();
  });

  it("follows a symlink that stays inside, and a granted folder that is itself a link", () => {
    const root = tmp();
    const alias = join(tmp(), "alias");
    writeFileSync(join(root, "real.md"), "r");
    symlinkSync(join(root, "real.md"), join(root, "inner.md"));
    symlinkSync(root, alias);
    expect(resolveGrantedFile(join(root, "inner.md"), [root])?.path).toBe(join(root, "real.md"));
    expect(resolveGrantedFile(join(alias, "real.md"), [alias])?.path).toBe(join(root, "real.md"));
  });

  it("never treats `/` as a granted folder", () => {
    const root = tmp();
    writeFileSync(join(root, "a.md"), "a");
    expect(resolveGrantedFile(join(root, "a.md"), ["/"])).toBeUndefined();
  });
});

const item = (nativeId: string, over: Partial<SourceItem> = {}): SourceItem => ({
  nativeId,
  title: `Title ${nativeId}`,
  text: `Body of ${nativeId}`,
  createdAt: NOW - 86_400_000,
  provenance: "untrusted",
  ...over,
});

function indexerWith(
  sources: Partial<Record<string, { enabled?: boolean; agent?: boolean }>> = {},
) {
  const { index } = setup();
  const config = defaultSourcesConfig();
  for (const [id, v] of Object.entries(sources)) {
    const s = (config.sources as Record<string, { enabled: boolean; agent: boolean }>)[id];
    if (s !== undefined) Object.assign(s, v);
  }
  const indexer = new SourceIndexer(index, [], { config: () => config, now: () => NOW });
  return { index, indexer, config };
}

describe("SourceIndexer.document", () => {
  it("returns an indexed passage with its text, date and source", async () => {
    const { indexer } = indexerWith({ notes: { enabled: true } });
    await indexer.ingest("notes", [item("n1", { provenance: "owner" })]);
    expect(indexer.document("notes:n1", "owner")).toMatchObject({
      id: "notes:n1",
      source: "notes",
      title: "Title n1",
      text: "Body of n1",
      createdAt: NOW - 86_400_000,
      provenance: "owner",
    });
  });

  it("gives the owner Messages, Contacts and Memory, and the agent none of them (owner-only sources)", async () => {
    const { indexer } = indexerWith({ messages: { enabled: true }, notes: { enabled: true } });
    await indexer.ingest("messages", [item("m1")]);
    await indexer.ingest("contacts", [item("c1")]);
    await indexer.ingest("memory", [item("f1")]);
    await indexer.ingest("notes", [item("n1")]);
    for (const id of ["messages:m1", "contacts:c1", "memory:f1"]) {
      expect(indexer.document(id, "owner")?.id, id).toBe(id);
      expect(indexer.document(id, "agent"), id).toBeUndefined();
      // The default audience is the agent's: a caller that forgets to say gets the safe answer.
      expect(indexer.document(id), id).toBeUndefined();
    }
    expect(indexer.document("notes:n1", "agent")?.id).toBe("notes:n1");
  });

  it("hides a source the owner switched off for the agent, and one flagged in the index", async () => {
    const { index, indexer, config } = indexerWith({ notes: { enabled: true } });
    await indexer.ingest("notes", [item("n1")]);
    config.sources.notes.agent = false;
    expect(indexer.document("notes:n1", "agent")).toBeUndefined();
    expect(indexer.document("notes:n1", "owner")?.id).toBe("notes:n1");
    config.sources.notes.agent = true;
    index.setAgentSearchable("connector:notes", false);
    expect(indexer.document("notes:n1", "agent")).toBeUndefined();
  });

  it("is undefined for an unknown id and for documents that are not source passages", async () => {
    const { index, indexer } = indexerWith({ notes: { enabled: true } });
    await indexer.ingest("notes", [item("n1")]);
    await index.index({
      id: "thread-1",
      kind: "thread",
      title: "A chat",
      text: "private",
      provenance: "owner",
      createdAt: NOW,
    });
    expect(indexer.document("nope", "owner")).toBeUndefined();
    expect(indexer.document("thread-1", "owner")).toBeUndefined();
  });

  it("keeps the Message-ID kept for a mail message, apart from its text, and updates it", async () => {
    const { indexer } = indexerWith({ mail: { enabled: true } });
    await indexer.ingest("mail", [item("1", { openRef: "a@host.example" })]);
    expect(indexer.document("mail:1", "owner")?.openRef).toBe("a@host.example");
    // Same text, a Message-ID that appeared later (an index made before it was kept): re-read.
    await indexer.ingest("mail", [item("2")]);
    expect(indexer.document("mail:2", "owner")?.openRef).toBeNull();
    expect(await indexer.ingest("mail", [item("2", { openRef: "b@host.example" })])).toBe(1);
    expect(indexer.document("mail:2", "owner")?.openRef).toBe("b@host.example");
    expect(await indexer.ingest("mail", [item("2", { openRef: "b@host.example" })])).toBe(0);
  });

  it("adds the column to an index made before it existed", () => {
    const { index } = setup();
    index.db.exec(
      "CREATE TABLE search_source_items (source TEXT NOT NULL, native_id TEXT NOT NULL, doc_id TEXT NOT NULL, content_hash TEXT NOT NULL, provenance TEXT NOT NULL, parties TEXT NOT NULL, chat_id TEXT, account TEXT, path TEXT, PRIMARY KEY (source, native_id)) WITHOUT ROWID",
    );
    new SourceIndexer(index, [], { config: () => defaultSourcesConfig(), now: () => NOW });
    const cols = index.db.prepare("PRAGMA table_info(search_source_items)").all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).toContain("open_ref");
  });
});

describe("the Mail source keeps the Message-ID from the connector's link, not from the text", () => {
  it("stores a well-formed link and ignores a malformed one or one planted in the body", async () => {
    const day = new Date(NOW - 86_400_000).toISOString();
    const rows = [
      {
        id: "1",
        subject: "One",
        from: "a@x.com",
        date: day,
        link: "message://%3Cone%40host.example%3E",
      },
      { id: "2", subject: "Two", from: "a@x.com", date: day, link: "message://%3Cnot valid%3E" },
      { id: "3", subject: "Three", from: "a@x.com", date: day },
    ];
    const call: ToolCall = async (tool, p) => {
      if (tool === "mail_search")
        return {
          messages:
            p.until !== undefined && Date.parse(String(p.until)) < Date.parse(day) ? [] : rows,
        };
      // A body that carries a message:// link of its own: never used.
      return { body: "see message://%3Cplanted%40evil.example%3E" };
    };
    const deps: AppleSourceDeps = {
      call: () => call,
      helper: () => undefined,
      ownAddresses: () => [],
      now: () => NOW,
    };
    const { index } = setup();
    const config = defaultSourcesConfig();
    config.sources.mail.enabled = true;
    const indexer = new SourceIndexer(index, appleAdapters(deps), {
      config: () => config,
      now: () => NOW,
      pauseMs: 0,
    });
    for (let i = 0; i < 40; i++) await indexer.tick();
    expect(indexer.document("mail:1", "owner")?.openRef).toBe("one@host.example");
    expect(indexer.document("mail:2", "owner")?.openRef).toBeNull();
    expect(indexer.document("mail:3", "owner")?.openRef).toBeNull();
  });
});
