import {
  createSearchIndex,
  defaultSourcesConfig,
  SourceIndexer,
  type SourceItem,
} from "@psyche/search";
import { describe, expect, it } from "vitest";
import { attachGistSources, type GistSources } from "../src/compose/people.ts";
import {
  canOpenGistSource,
  MAX_DOC_ID_CHARS,
  scrubCitations,
  scrubWorkHistory,
} from "../src/compose/search-open.ts";
import type { Call } from "../src/context.ts";

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
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

async function world() {
  const index = createSearchIndex({ now: () => NOW });
  const config = defaultSourcesConfig();
  const indexer = new SourceIndexer(index, [], { config: () => config, now: () => NOW });
  await indexer.ingest("mail", [item("1", { openRef: "a@host.example" })]);
  await indexer.ingest("messages", [item("chat1|2026-11-03|9", { chatId: "chat1" })]);
  await indexer.ingest("calendar", [item("ev1")]);
  await indexer.ingest("notes", [item("n1")]);
  await indexer.ingest("memory", [item("f1")]);
  config.sources.mail.enabled = true;
  config.sources.messages.enabled = true;
  config.sources.calendar.enabled = true;
  return { indexer };
}

describe("which sources a connection may open from a chip", () => {
  it("lets any paired client open a mail or calendar source, and refuses a helper", async () => {
    const w = await world();
    const deps = { indexer: () => w.indexer };
    expect(canOpenGistSource(deps, phone, "mail:1")).toBe(true);
    expect(canOpenGistSource(deps, desktop, "mail:1")).toBe(true);
    expect(canOpenGistSource(deps, phone, "calendar:ev1")).toBe(true);
    expect(canOpenGistSource(deps, helper, "mail:1")).toBe(false);
  });

  it("keeps Messages to the desktop app on this Mac: a remote client gets no chip", async () => {
    const w = await world();
    const deps = { indexer: () => w.indexer };
    const id = "messages:chat1|2026-11-03|9";
    expect(canOpenGistSource(deps, desktop, id)).toBe(true);
    expect(canOpenGistSource(deps, phone, id)).toBe(false);
    expect(canOpenGistSource(deps, helper, id)).toBe(false);
  });

  it("refuses a source the chip never comes from, a missing passage, a too-long id and no index", async () => {
    const w = await world();
    const deps = { indexer: () => w.indexer };
    expect(canOpenGistSource(deps, desktop, "notes:n1")).toBe(false);
    expect(canOpenGistSource(deps, desktop, "memory:f1")).toBe(false);
    expect(canOpenGistSource(deps, desktop, "mail:gone")).toBe(false);
    expect(canOpenGistSource(deps, desktop, `mail:${"x".repeat(MAX_DOC_ID_CHARS)}`)).toBe(false);
    expect(canOpenGistSource({ indexer: () => undefined }, desktop, "mail:1")).toBe(false);
  });
});

describe("what the people methods send", () => {
  const gate = (w: { indexer: SourceIndexer }): GistSources => ({
    docIdFor: (ref) => w.indexer.docIdFor(ref),
    canOpen: (c, id) => canOpenGistSource({ indexer: () => w.indexer }, c, id),
  });
  const refs: Record<string, string> = {
    a: "a@host.example",
    b: "chat1:2026-11-03",
    c: "n1",
    d: "a@host.example",
    e: "ev1",
  };
  type Row = { id: string; kind: string; gist: string | null; gistDocId?: string };
  const row = (
    id: string,
    kind: string,
    gist: string | null = "Talked about the Lisbon dates",
  ): Row => ({
    id,
    kind,
    gist,
  });
  const attach = (c: Call, sources: GistSources | undefined, rows: ReturnType<typeof row>[]) =>
    attachGistSources(c, sources, (id) => refs[id], rows);

  it("resolves the source now, and sends it only to a connection that may open it", async () => {
    const w = await world();
    const rows = [row("a", "mail"), row("b", "message"), row("e", "meeting"), row("c", "note")];
    expect(attach(desktop, gate(w), rows).map((r) => r.gistDocId)).toEqual([
      "mail:1",
      "messages:chat1|2026-11-03|9",
      "calendar:ev1",
      undefined,
    ]);
    // A remote client: mail and calendar, not Messages.
    expect(attach(phone, gate(w), rows).map((r) => r.gistDocId)).toEqual([
      "mail:1",
      undefined,
      "calendar:ev1",
      undefined,
    ]);
    expect(attach(helper, gate(w), rows).every((r) => r.gistDocId === undefined)).toBe(true);
  });

  it("shows no chip without a gist, and drops a reference a client sent or a store held", async () => {
    const w = await world();
    const stale = { ...row("a", "mail", null), gistDocId: "mail:1" };
    const out = attachGistSources(desktop, gate(w), (id) => refs[id], [stale]);
    expect(out[0]).not.toHaveProperty("gistDocId");
    expect(out[0]?.gist).toBeNull();
  });

  it("shows no chip when a document id was re-pointed to another message", async () => {
    const w = await world();
    expect(attach(desktop, gate(w), [row("a", "mail")])[0]?.gistDocId).toBe("mail:1");
    // Mail.app reuses the id `1` for a different message: the old conversation finds nothing.
    await w.indexer.ingest("mail", [
      item("1", { openRef: "other@host.example", text: "A different message" }),
    ]);
    expect(attach(desktop, gate(w), [row("a", "mail")])[0]).not.toHaveProperty("gistDocId");
    expect(attach(desktop, gate(w), [row("d", "mail")])[0]).not.toHaveProperty("gistDocId");
  });

  it("drops every reference until Search is bound, when the check throws and for a too-long id", async () => {
    expect(attach(desktop, undefined, [row("a", "mail")])[0]).not.toHaveProperty("gistDocId");
    const broken: GistSources = {
      docIdFor: () => "mail:1",
      canOpen: () => {
        throw new Error("index locked");
      },
    };
    expect(attach(desktop, broken, [row("a", "mail")])[0]).not.toHaveProperty("gistDocId");
    const long: GistSources = {
      docIdFor: () => `mail:${"x".repeat(MAX_DOC_ID_CHARS)}`,
      canOpen: () => true,
    };
    expect(attach(desktop, long, [row("a", "mail")])[0]).not.toHaveProperty("gistDocId");
  });

  it("finds the passage a conversation came from", async () => {
    const w = await world();
    expect(w.indexer.docIdFor({ kind: "mail", externalRef: "a@host.example" })).toBe("mail:1");
    expect(w.indexer.docIdFor({ kind: "message", externalRef: "chat1:2026-11-03" })).toBe(
      "messages:chat1|2026-11-03|9",
    );
    expect(w.indexer.docIdFor({ kind: "meeting", externalRef: "ev1" })).toBe("calendar:ev1");
    expect(
      w.indexer.docIdFor({ kind: "mail", externalRef: "nobody@host.example" }),
    ).toBeUndefined();
  });
});

describe("a Messages day", () => {
  async function chats() {
    const index = createSearchIndex({ now: () => NOW });
    const config = defaultSourcesConfig();
    const indexer = new SourceIndexer(index, [], { config: () => config, now: () => NOW });
    config.sources.messages.enabled = true;
    const at = (iso: string) => Date.parse(iso);
    await indexer.ingest("messages", [
      // The same day, two pages: `|1000` sorts before `|999` as text, but `|999` is the first page.
      item("chat2|2026-11-03|1000", { chatId: "chat2", createdAt: at("2026-11-03T18:00:00Z") }),
      item("chat2|2026-11-03|999", { chatId: "chat2", createdAt: at("2026-11-03T09:00:00Z") }),
      item("chat2|2026-11-02|4", { chatId: "chat2", createdAt: at("2026-11-02T09:00:00Z") }),
      item("chat3|2026-11-03|8", { chatId: "chat3", createdAt: at("2026-11-03T09:00:00Z") }),
    ]);
    return indexer;
  }

  it("is found by chat and day, taking the day's first passage by time", async () => {
    const indexer = await chats();
    expect(indexer.docIdFor({ kind: "message", externalRef: "chat2:2026-11-03" })).toBe(
      "messages:chat2|2026-11-03|999",
    );
    expect(indexer.docIdFor({ kind: "message", externalRef: "chat3:2026-11-03" })).toBe(
      "messages:chat3|2026-11-03|8",
    );
  });

  it("has no passage while its day is not indexed yet: never the day before's", async () => {
    const indexer = await chats();
    // 4 Nov is the graph's day; the index holds 2 and 3 Nov only.
    expect(indexer.docIdFor({ kind: "message", externalRef: "chat2:2026-11-04" })).toBeUndefined();
    expect(indexer.docIdFor({ kind: "message", externalRef: "chat4:2026-11-03" })).toBeUndefined();
    expect(indexer.docIdFor({ kind: "message", externalRef: "no-day" })).toBeUndefined();
  });
});

describe("a work item's history chips", () => {
  const entry = (source: string, label: string) => ({
    factId: `fact_${source}`,
    chip: { source, label },
  });
  const all = [
    entry("mail", "Prof. Rao"),
    entry("messages", "Dana"),
    entry("contacts", "Dana Lee"),
    entry("files", "thesis.tex"),
    { factId: "fact_none", chip: null },
  ];

  it("keeps every label for the desktop app", () => {
    expect(scrubWorkHistory(desktop, all)).toEqual(all);
  });

  it("keeps the source but hides the label of an owner-only source from a remote client", () => {
    const remote = scrubWorkHistory(phone, all);
    expect(remote[0]?.chip).toEqual({ source: "mail", label: "Prof. Rao" });
    expect(remote[1]?.chip).toEqual({ source: "messages", label: "" });
    expect(remote[2]?.chip).toEqual({ source: "contacts", label: "" });
    expect(remote[3]?.chip).toEqual({ source: "files", label: "thesis.tex" });
    expect(remote[4]?.chip).toBeNull();
  });

  it("gives a Mac helper no chip at all", () => {
    expect(scrubWorkHistory(helper, all).map((e) => e.chip)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("a review item's citations", () => {
  const cite = (source: string, docId: string | null) => ({
    source,
    docId,
    quote: "Dinner on Friday at 7",
    sourceRef: `${source}-native`,
  });

  it("keeps ids and quotes for the desktop app, and what a remote client may open", async () => {
    const w = await world();
    const deps = { indexer: () => w.indexer };
    const all = [
      cite("messages", "messages:chat1|2026-11-03|9"),
      cite("mail", "mail:1"),
      cite("contacts", null),
    ];
    expect(scrubCitations(deps, desktop, all)).toEqual(all);
    const remote = scrubCitations(deps, phone, all);
    // Mail: the id and the quote stay. Messages and Contacts: no id, no quote, the label stays.
    expect(remote[1]).toEqual(cite("mail", "mail:1"));
    expect(remote[0]).toEqual({ source: "messages", docId: null, quote: "", sourceRef: "" });
    expect(remote[2]).toEqual({ source: "contacts", docId: null, quote: "", sourceRef: "" });
  });

  it("drops an id that is gone, too long or of a connection that is not a client", async () => {
    const w = await world();
    const deps = { indexer: () => w.indexer };
    const out = scrubCitations(deps, helper, [
      cite("mail", "mail:1"),
      cite("mail", "mail:gone"),
      cite("mail", `mail:${"x".repeat(MAX_DOC_ID_CHARS)}`),
    ]);
    expect(out.map((c) => c.docId)).toEqual([null, null, null]);
    expect(out[0]?.quote).toBe("Dinner on Friday at 7");
    expect(
      scrubCitations({ indexer: () => undefined }, desktop, [cite("mail", "mail:1")])[0]?.docId,
    ).toBeNull();
  });

  it("treats a Messages passage as owner-only even when the citation is labelled otherwise", async () => {
    const w = await world();
    const out = scrubCitations({ indexer: () => w.indexer }, phone, [
      cite("chats", "messages:chat1|2026-11-03|9"),
    ]);
    expect(out[0]).toMatchObject({ docId: null, quote: "" });
  });
});
