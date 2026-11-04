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
