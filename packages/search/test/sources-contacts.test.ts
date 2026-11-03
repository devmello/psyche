import { describe, expect, it } from "vitest";
import {
  CONTACTS_PAGE,
  CONTACTS_REFRESH_MS,
  type ContactsSourceDeps,
  contactsAdapter,
  defaultSourcesConfig,
  graphDocId,
  type HelperCall,
  isExcluded,
  readSourcesConfig,
  SourceIndexer,
  sourceTag,
} from "../src/index.ts";
import { NOW, setup } from "./helpers.ts";

/** The Contacts source over a fake `contacts.list` / `contacts.read` helper. Fixtures only. */

type Obj = Record<string, unknown>;

const jordan: Obj = {
  id: "c1",
  givenName: "Jordan",
  familyName: "Rivera",
  nickname: "JR",
  organization: "Acme Co",
  jobTitle: "Designer",
  emails: [
    { label: "work", value: "jordan@acme.example" },
    { label: "home", value: "jr@home.example" },
  ],
  phones: [{ label: "mobile", value: "+1 (510) 555-0101" }],
  addresses: [
    {
      label: "home",
      street: "12 Secret Lane",
      city: "Oakland",
      state: "CA",
      postalCode: "94607",
      country: "USA",
    },
  ],
  urls: [{ label: "homepage", value: "https://jordan.example/me" }],
  birthday: "1990-05-04",
  groups: ["Family"],
  // Never sent by the real helper; here to prove the adapter would not index it anyway.
  note: "door code 4471, allergic to penicillin",
};
const sam: Obj = {
  id: "c2",
  givenName: "Sam",
  familyName: "Lee",
  emails: [{ label: "work", value: "sam@lee.example" }],
  phones: [],
  addresses: [],
};

function world(contacts: Obj[] = [jordan, sam]) {
  const w = {
    contacts,
    calls: [] as { capability: string; params: Obj }[],
    /** Throw this from every call. */
    fail: undefined as string | undefined,
    /** Throw this from `contacts.read` only. */
    failRead: undefined as string | undefined,
    /** Listed, then gone by the time they are read. */
    ghosts: [] as string[],
    /** The most `contacts.list` hands back at once. */
    listCap: 2000,
    /** An older helper: no `offset`, so every page is the first. */
    ignoreOffset: false,
    up: true,
  };
  const helper: HelperCall = async (capability, params) => {
    w.calls.push({ capability, params });
    if (w.fail !== undefined) throw new Error(w.fail);
    if (capability === "contacts.list") {
      const limit = Number(params.limit ?? 500);
      if (limit < 1 || limit > 2000) throw new Error("limit must be 1–2000");
      const q = typeof params.query === "string" ? params.query.toLowerCase() : undefined;
      const named = w.contacts.filter(
        (c) =>
          q === undefined ||
          String(c.givenName ?? "")
            .toLowerCase()
            .startsWith(q) ||
          String(c.familyName ?? "")
            .toLowerCase()
            .startsWith(q),
      );
      const cap = Math.min(limit, w.listCap);
      const offset = w.ignoreOffset ? 0 : Number(params.offset ?? 0);
      return {
        contacts: [
          ...named.slice(offset, offset + cap).map((c) => ({
            id: c.id,
            name: String(c.listedName ?? `${c.givenName ?? ""} ${c.familyName ?? ""}`.trim()),
          })),
          ...(offset === 0 ? w.ghosts.map((id) => ({ id, name: "Ghost" })) : []),
        ],
        total: w.contacts.length,
        truncated: named.length > offset + cap,
      };
    }
    if (capability === "contacts.read") {
      if (w.failRead !== undefined) throw new Error(w.failRead);
      const c = w.contacts.find((x) => x.id === params.id);
      if (c === undefined)
        throw new Error(`contacts.read failed: not_found (No contact ${String(params.id)})`);
      const { note: _note, listedName: _listed, ...rest } = c;
      return { contact: rest, provenance: "untrusted" };
    }
    throw new Error(`no ${capability}`);
  };
  return { w, helper };
}

function harness(
  contacts?: Obj[],
  opts: { parentOf?: ContactsSourceDeps["parentOf"]; exclude?: string[] } = {},
) {
  const { index } = setup();
  const { w, helper } = world(contacts);
  let now = NOW;
  const config = defaultSourcesConfig();
  config.sources.contacts.enabled = true;
  if (opts.exclude !== undefined) config.exclude.contacts = opts.exclude;
  const adapter = contactsAdapter({
    helper: () => (w.up ? helper : undefined),
    ...(opts.parentOf === undefined ? {} : { parentOf: opts.parentOf }),
    now: () => now,
  });
  const indexer = new SourceIndexer(index, [adapter], {
    config: () => config,
    now: () => NOW,
    pauseMs: 0,
  });
  const ids = () =>
    (
      index.db
        .prepare("SELECT id FROM search_docs WHERE source = ? ORDER BY id")
        .all(sourceTag("contacts")) as { id: string }[]
    ).map((r) => r.id);
  return {
    index,
    w,
    adapter,
    indexer,
    config,
    ids,
    setNow: (t: number) => {
      now = t;
    },
  };
}

const signal = new AbortController().signal;

describe("the Contacts source: defaults", () => {
  it("is off until switched on, and owner-only for the agent like Messages", () => {
    // No context cards: other people's numbers and addresses do not go to a cloud model.
    expect(defaultSourcesConfig().sources.contacts).toMatchObject({
      enabled: false,
      agent: false,
      processing: "none",
    });
    expect(
      readSourcesConfig({ sources: { contacts: { enabled: true } } }).sources.contacts,
    ).toMatchObject({ enabled: true, agent: false });
    // The owner can allow the agent.
    expect(
      readSourcesConfig({ sources: { contacts: { enabled: true, agent: true } } }).sources.contacts
        .agent,
    ).toBe(true);
  });
});

describe("the Contacts source: what is indexed", () => {
  it("indexes name, nickname, company, job title, emails, numbers, city and country, birthday", async () => {
    const h = harness();
    await h.indexer.tick();
    expect(h.ids()).toEqual(["contacts:c1", "contacts:c2"]);
    for (const q of [
      "Jordan Rivera",
      "JR",
      "Acme",
      "Designer",
      "jordan@acme.example",
      "Oakland",
      "1990-05-04",
    ])
      expect(
        (await h.index.search({ q })).hits.map((x) => x.id),
        q,
      ).toContain("contacts:c1");
    const hit = (await h.index.search({ q: "Jordan Rivera" })).hits[0];
    expect(hit?.title).toBe("Jordan Rivera");
    expect(hit?.provenance).toBe("untrusted");
  });

  it("never indexes the street, state, postal code, URLs, groups or the note", async () => {
    const h = harness();
    await h.indexer.tick();
    for (const q of ["Secret Lane", "94607", "jordan.example", "Family", "penicillin", "4471"])
      expect((await h.index.search({ q })).hits, q).toHaveLength(0);
  });

  it("a contact with only a company or an address still gets a name; an empty one is skipped", async () => {
    const h = harness([
      { id: "c3", organization: "Blue Bottle", emails: [], phones: [], addresses: [] },
      { id: "c4", emails: [], phones: [], addresses: [] },
    ]);
    await h.indexer.tick();
    expect(h.ids()).toEqual(["contacts:c3"]);
  });
});

describe("the Contacts source: paging and limits", () => {
  const many = (n: number): Obj[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${String(i).padStart(4, "0")}`,
      givenName: `Person${i}`,
      familyName: "Test",
      emails: [],
      phones: [],
      addresses: [],
    }));

  it("reads a page of contacts per pull and never asks the helper for more than it allows", async () => {
    const h = harness(many(CONTACTS_PAGE * 2 + 7));
    const first = await h.adapter.pull(null, { signal, limit: 100 });
    expect(first.items).toHaveLength(CONTACTS_PAGE);
    expect(first.hasMore).toBe(true);
    const second = await h.adapter.pull(first.cursor, { signal, limit: 100 });
    expect(second.items).toHaveLength(CONTACTS_PAGE);
    const third = await h.adapter.pull(second.cursor, { signal, limit: 100 });
    expect(third.items).toHaveLength(7);
    expect(third.hasMore).toBe(false);
    for (const c of h.w.calls.filter((x) => x.capability === "contacts.list"))
      expect(Number(c.params.limit)).toBeLessThanOrEqual(2000);
    // A smaller indexer page is honoured.
    const small = await h.adapter.pull(null, { signal, limit: 5 });
    expect(small.items).toHaveLength(5);
  });

  it("indexes every contact across ticks", async () => {
    const h = harness(many(CONTACTS_PAGE + 3));
    for (let i = 0; i < 4; i++) await h.indexer.tick();
    expect(h.ids()).toHaveLength(CONTACTS_PAGE + 3);
    expect(h.indexer.status().sources.find((s) => s.id === "contacts")).toMatchObject({
      state: "idle",
      backfilled: true,
    });
  });

  it("pages the list with offset past the helper's cap, so every contact is listed and complete", async () => {
    const h = harness(many(7));
    h.w.listCap = 3;
    const out = await h.adapter.listIds?.(signal);
    expect(out?.complete).toBe(true);
    expect(out?.ids).toHaveLength(7);
    const offsets = h.w.calls.map((c) => Number(c.params.offset ?? 0));
    expect(offsets).toEqual([0, 3, 6]);
    for (const c of h.w.calls) expect(Number(c.params.limit)).toBeLessThanOrEqual(2000);
  });

  it("lists once per pass, not once per page of contacts", async () => {
    const h = harness(many(CONTACTS_PAGE * 3));
    for (let i = 0; i < 3; i++) await h.indexer.tick();
    expect(h.ids()).toHaveLength(CONTACTS_PAGE * 3);
    // One listing for the pass, plus the one the first nightly sweep makes: not one per page.
    expect(h.w.calls.filter((c) => c.capability === "contacts.list")).toHaveLength(2);
  });

  it("an older helper that ignores offset ends the walk and the list is not called complete", async () => {
    const h = harness(many(7));
    h.w.listCap = 3;
    h.w.ignoreOffset = true;
    const out = await h.adapter.listIds?.(signal);
    expect(out?.complete).toBe(false);
    expect(out?.ids).toHaveLength(3);
  });

  it("an address book past 2000 is paged in full and a deleted contact is purged by the sweep", async () => {
    const h = harness(many(2005));
    for (let i = 0; i < 45; i++) await h.indexer.tick();
    expect(h.ids()).toHaveLength(2005);
    h.w.contacts = h.w.contacts.slice(0, 2004);
    expect(await h.indexer.sweep("contacts")).toBe(1);
    expect(h.ids()).toHaveLength(2004);
  });

  it("does not read again until the refresh time has passed, then picks up edits", async () => {
    const h = harness();
    await h.indexer.tick();
    const reads = () => h.w.calls.filter((c) => c.capability === "contacts.read").length;
    expect(reads()).toBe(2);
    await h.indexer.tick();
    expect(reads()).toBe(2);
    (h.w.contacts[1] as Obj).phones = [{ label: "mobile", value: "+1 415 555 0199" }];
    h.setNow(NOW + CONTACTS_REFRESH_MS + 1);
    await h.indexer.tick();
    expect(reads()).toBe(4);
    expect((await h.index.search({ q: "415 555 0199" })).hits.map((x) => x.id)).toContain(
      "contacts:c2",
    );
  });
});

describe("the Contacts source: permission and availability", () => {
  it("is unavailable without a Host helper", async () => {
    const h = harness();
    h.w.up = false;
    expect(h.adapter.unavailable()).toBe("the Mac helper is not connected");
    expect(h.indexer.status().sources.find((s) => s.id === "contacts")).toMatchObject({
      state: "unavailable",
      detail: "the Mac helper is not connected",
    });
  });

  it("surfaces the helper's permission message on the row and indexes nothing", async () => {
    const h = harness();
    h.w.fail = "Psyche (Helper) does not have the Contacts permission";
    await h.indexer.tick();
    expect(h.ids()).toEqual([]);
    expect(h.indexer.status().sources.find((s) => s.id === "contacts")).toMatchObject({
      state: "error",
      detail: "Psyche (Helper) does not have the Contacts permission",
    });
    // Granted later: the next pass fills the source and clears the error.
    h.w.fail = undefined;
    await h.indexer.tick();
    expect(h.ids()).toEqual(["contacts:c1", "contacts:c2"]);
    expect(h.indexer.status().sources.find((s) => s.id === "contacts")?.state).toBe("idle");
  });

  it("skips a contact deleted between the list and the read, but stops on any other error", async () => {
    const h = harness();
    h.w.ghosts = ["gone"];
    const page = await h.adapter.pull(null, { signal, limit: 100 });
    expect(page.items.map((i) => i.nativeId).sort()).toEqual(["c1", "c2"]);
    h.w.failRead = "contacts.read failed: forbidden (no access)";
    await expect(h.adapter.pull(null, { signal, limit: 100 })).rejects.toThrow(/forbidden/);
  });

  it("the nightly sweep forgets a deleted contact, and a partial list deletes nothing", async () => {
    const h = harness();
    await h.indexer.tick();
    h.w.contacts = [jordan];
    expect(await h.indexer.sweep("contacts")).toBe(1);
    expect(h.ids()).toEqual(["contacts:c1"]);
    h.w.contacts = [sam, { id: "c9", givenName: "Zed", familyName: "Zhao" }];
    h.w.listCap = 1;
    h.w.ignoreOffset = true;
    expect(await h.indexer.sweep("contacts")).toBe(0);
    expect(h.ids()).toEqual(["contacts:c1"]);
  });
});

describe("the Contacts source: never index these contacts", () => {
  it.each([
    ["number", ["+15105550101"], ["contacts:c2"]],
    ["email", ["sam@lee.example"], ["contacts:c1"]],
    ["name", ["Jordan Rivera"], ["contacts:c2"]],
    ["nickname", ["jr"], ["contacts:c2"]],
  ])("purges what was indexed once its %s is excluded", async (_kind, exclude, left) => {
    const h = harness();
    await h.indexer.tick();
    expect(h.ids()).toEqual(["contacts:c1", "contacts:c2"]);
    h.config.exclude.contacts = exclude as string[];
    await h.indexer.applyConfig();
    expect(h.ids()).toEqual(left);
  });

  it("an excluded contact is not indexed in the first place", async () => {
    const h = harness(undefined, { exclude: ["jr@home.example"] });
    await h.indexer.tick();
    expect(h.ids()).toEqual(["contacts:c2"]);
  });

  it("carries name, nickname, emails and numbers as parties", async () => {
    const h = harness();
    const page = await h.adapter.pull(null, { signal, limit: 100 });
    expect(page.items.find((i) => i.nativeId === "c1")?.parties).toEqual([
      "Jordan Rivera",
      "JR",
      "jordan@acme.example",
      "jr@home.example",
      "+1 (510) 555-0101",
    ]);
  });
});

describe("the Contacts source: parties for the exclusion list", () => {
  it("includes the shown name with middle name and prefix, and a company that is the card's name", async () => {
    const h = harness([
      {
        ...jordan,
        id: "c5",
        listedName: "Dr. Jordan Quinn Rivera",
      },
      { id: "c6", organization: "Blue Bottle", listedName: "Blue Bottle", emails: [], phones: [] },
    ]);
    const page = await h.adapter.pull(null, { signal, limit: 100 });
    const parties = (id: string) => page.items.find((i) => i.nativeId === id)?.parties ?? [];
    expect(parties("c5")).toContain("Dr. Jordan Quinn Rivera");
    expect(parties("c5")).toContain("Jordan Rivera");
    expect(parties("c6")).toContain("Blue Bottle");
    // A company on a person's card is not a party: excluding "Acme Co" is not excluding Jordan.
    expect(parties("c5")).not.toContain("Acme Co");
  });

  it("excludes a company-only card by the name Contacts shows, and by a number written another way", async () => {
    const h = harness(
      [
        {
          id: "c6",
          organization: "Blue Bottle",
          listedName: "Blue Bottle",
          emails: [],
          phones: [],
        },
        jordan,
      ],
      { exclude: ["blue bottle", "(510) 555-0101"] },
    );
    await h.indexer.tick();
    expect(h.ids()).toEqual([]);
  });
});

describe("the Contacts source: one result per person", () => {
  it("collapses onto the person's Memory document when it is known, and not otherwise", async () => {
    const h = harness(undefined, {
      parentOf: (c) =>
        c.emails.includes("jordan@acme.example") ? graphDocId("e-jordan") : undefined,
    });
    const page = await h.adapter.pull(null, { signal, limit: 100 });
    expect(page.items.find((i) => i.nativeId === "c1")?.parentId).toBe("entity:e-jordan");
    expect(page.items.find((i) => i.nativeId === "c2")?.parentId).toBeUndefined();
    await h.indexer.tick();
    const hit = (await h.index.search({ q: "Jordan Rivera" })).hits.find(
      (x) => x.id === "contacts:c1",
    );
    expect(hit?.parentId).toBe("entity:e-jordan");
  });
});

describe("the Contacts source: a changed parent re-indexes the contact", () => {
  it("drops the collapse when the person turns private, instead of skipping the unchanged text", async () => {
    let parent: string | undefined = graphDocId("e-jordan");
    const h = harness(undefined, { parentOf: () => parent });
    await h.indexer.tick();
    const row = () =>
      h.index.db.prepare("SELECT parent_id FROM search_docs WHERE id = 'contacts:c1'").get() as {
        parent_id: string | null;
      };
    expect(row().parent_id).toBe("entity:e-jordan");
    parent = undefined;
    h.setNow(NOW + CONTACTS_REFRESH_MS + 1);
    await h.indexer.tick();
    expect(row().parent_id).toBeNull();
  });
});

describe("the exclusion list matches a number however it is written", () => {
  const ex = (...contacts: string[]) => ({ contacts, chats: [], accounts: [], folders: [] });
  const item = (party: string) => ({
    nativeId: "x",
    title: "",
    text: "",
    createdAt: 0,
    provenance: "owner" as const,
    parties: [party],
  });
  it.each([
    ["+1 555 123 4567", "(555) 123-4567"],
    ["(555) 123-4567", "+1 555 123 4567"],
    ["+44 7911 123456", "07911 123456"],
  ])("%s is %s", (party, listed) => {
    expect(isExcluded(item(party), ex(listed))).toBe(true);
  });
  it("does not match a different number or a short one", () => {
    expect(isExcluded(item("+1 555 123 4567"), ex("555 123 4568"))).toBe(false);
    expect(isExcluded(item("+1 555 123 4567"), ex("123456"))).toBe(false);
  });
});
