import type { GraphInteraction } from "@psyche/protocol";
import {
  createSearchIndex,
  defaultSourcesConfig,
  SourceIndexer,
  type SourceItem,
} from "@psyche/search";
import { describe, expect, it } from "vitest";
import { type GistSources, scrubGistSources } from "../src/compose/people.ts";
import { canOpenGistSource } from "../src/compose/search-open.ts";
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

const gist = (id: string, docId?: string): GraphInteraction =>
  ({
    id,
    kind: "mail",
    gist: "Talked about the Lisbon dates",
    ...(docId === undefined ? {} : { gistDocId: docId }),
  }) as unknown as GraphInteraction;

describe("which gist sources a connection may open", () => {
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

  it("refuses a source a gist never comes from, a missing passage and no index at all", async () => {
    const w = await world();
    const deps = { indexer: () => w.indexer };
    expect(canOpenGistSource(deps, desktop, "notes:n1")).toBe(false);
    expect(canOpenGistSource(deps, desktop, "memory:f1")).toBe(false);
    expect(canOpenGistSource(deps, desktop, "mail:gone")).toBe(false);
    expect(canOpenGistSource({ indexer: () => undefined }, desktop, "mail:1")).toBe(false);
  });
});

describe("what the people methods send", () => {
  const gate = (w: { indexer: SourceIndexer }): GistSources => ({
    docIdFor: (ref) => w.indexer.docIdFor(ref),
    canOpen: (c, id) => canOpenGistSource({ indexer: () => w.indexer }, c, id),
  });

  it("keeps a reference the connection may open and drops the rest", async () => {
    const w = await world();
    const rows = [
      gist("a", "mail:1"),
      gist("b", "messages:chat1|2026-11-03|9"),
      gist("c", "notes:n1"),
      gist("d"),
    ];
    const forDesktop = scrubGistSources(desktop, gate(w), rows).map((r) => r.gistDocId);
    expect(forDesktop).toEqual(["mail:1", "messages:chat1|2026-11-03|9", undefined, undefined]);
    const forPhone = scrubGistSources(phone, gate(w), rows).map((r) => r.gistDocId);
    expect(forPhone).toEqual(["mail:1", undefined, undefined, undefined]);
    // The gist itself is untouched; only the reference goes.
    expect(scrubGistSources(phone, gate(w), rows)[1]?.gist).toBe("Talked about the Lisbon dates");
    expect("gistDocId" in (scrubGistSources(phone, gate(w), rows)[1] ?? {})).toBe(false);
  });

  it("drops every reference until Search is bound, and when the check throws", () => {
    expect(scrubGistSources(desktop, undefined, [gist("a", "mail:1")])[0]?.gistDocId).toBe(
      undefined,
    );
    const broken: GistSources = {
      docIdFor: () => undefined,
      canOpen: () => {
        throw new Error("index locked");
      },
    };
    expect(scrubGistSources(desktop, broken, [gist("a", "mail:1")])[0]?.gistDocId).toBe(undefined);
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
    expect(
      w.indexer.docIdFor({ kind: "message", externalRef: "chat1:2026-11-04" }),
    ).toBeUndefined();
  });
});

describe("a Messages day near midnight in another zone", () => {
  // Los Angeles, 3 Nov 2026 at 4:40 pm and 5:30 pm: the index labels the day 11-03 by the
  // connector's local time, while the graph's day for the same newest message is 11-04 (UTC).
  const first = Date.parse("2026-11-04T00:40:00Z");
  const newest = "2026-11-04T01:30:00Z";

  async function chats() {
    const index = createSearchIndex({ now: () => NOW });
    const config = defaultSourcesConfig();
    const indexer = new SourceIndexer(index, [], { config: () => config, now: () => NOW });
    config.sources.messages.enabled = true;
    await indexer.ingest("messages", [
      item("chat2|2026-11-03|5", { chatId: "chat2", createdAt: first }),
      item("chat2|2026-11-02|4", {
        chatId: "chat2",
        createdAt: Date.parse("2026-11-03T02:00:00Z"),
      }),
      item("chat3|2026-11-03|8", { chatId: "chat3", createdAt: first }),
    ]);
    return indexer;
  }

  it("finds the day by the time of its newest message when the day labels disagree", async () => {
    const indexer = await chats();
    const ref = { kind: "message", externalRef: "chat2:2026-11-04" } as const;
    // By label alone the two sides do not meet...
    expect(indexer.docIdFor(ref)).toBeUndefined();
    // ...by instant they do: the latest day of that chat that began at or before the message.
    expect(indexer.docIdFor({ ...ref, at: newest })).toBe("messages:chat2|2026-11-03|5");
  });

  it("prefers the same label, and never takes another chat or a day more than a day back", async () => {
    const indexer = await chats();
    expect(indexer.docIdFor({ kind: "message", externalRef: "chat2:2026-11-03", at: newest })).toBe(
      "messages:chat2|2026-11-03|5",
    );
    expect(
      indexer.docIdFor({ kind: "message", externalRef: "chat4:2026-11-04", at: newest }),
    ).toBeUndefined();
    expect(
      indexer.docIdFor({
        kind: "message",
        externalRef: "chat2:2026-11-06",
        at: "2026-11-06T12:00:00Z",
      }),
    ).toBeUndefined();
    expect(
      indexer.docIdFor({ kind: "message", externalRef: "chat2:2026-11-04", at: "not a time" }),
    ).toBeUndefined();
  });
});
