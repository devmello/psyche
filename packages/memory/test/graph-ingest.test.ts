import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardSync, parseCard, renderCard } from "../src/graph/cards.ts";
import {
  type ContactRecord,
  type EventRecord,
  GraphIngester,
  type MailRecord,
  type MessageRecord,
} from "../src/graph/ingest.ts";
import { GraphStore } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

interface World {
  now: string;
  owner: { emails: string[]; phones: string[] };
  contacts: ContactRecord[];
  mails: MailRecord[];
  deletedMails: { source: string; messageId: string }[];
  events: EventRecord[];
  messages: MessageRecord[];
  ownerProjects: { name: string; threadId: string }[];
}

const WORLD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "graph", "world.json"),
    "utf8",
  ),
) as World;

let env: TestEnv;
let graph: GraphStore;
let ingest: GraphIngester;
let clock: FakeClock;

beforeEach(async () => {
  clock = new FakeClock(Date.parse(WORLD.now));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  ingest = new GraphIngester(graph, {
    ownerEmails: WORLD.owner.emails,
    ownerPhones: WORLD.owner.phones,
    clock,
  });
});
afterEach(async () => env.cleanup());

const byName = (name: string) => graph.search(name, { limit: 10 }).find((s) => s.name === name);
const loadAll = () => {
  ingest.ingestContacts(WORLD.contacts);
  const mail = ingest.ingestMail(WORLD.mails);
  const events = ingest.ingestEvents(WORLD.events);
  const messages = ingest.ingestMessages(WORLD.messages);
  return { mail, events, messages };
};

describe("Contacts (§5.1)", () => {
  it("creates the owner and the people, orgs, roles and declared relations", () => {
    const report = ingest.ingestContacts(WORLD.contacts);
    expect(report.created).toBe(13);
    expect(graph.ownerEntity()?.name).toBe("Pat Kim");
    const sam = byName("Sam Lee");
    expect(sam?.subtitle).toBe("Acme");
    expect(graph.facts(sam?.id ?? "").find((f) => f.attribute === "title")).toMatchObject({
      value: "Head of product",
      provenance: "owner",
    });
    expect(graph.getEntity(sam?.id ?? "")?.aliases).toContain("Sammy");
    expect(
      graph
        .listEntities(["org"])
        .map((o) => o.name)
        .sort(),
    ).toEqual(["Acme", "BuildRight", "Initech", "Studio Mo"]);
    const alex = byName("Alex Kim");
    const brother = graph.edges(alex?.id ?? "").find((e) => e.rel === "related_to");
    expect(brother).toMatchObject({ label: "sibling", provenance: "owner" });
    // Re-ingesting is a no-op.
    expect(ingest.ingestContacts(WORLD.contacts).created).toBe(0);
  });
});

describe("mail (§5.1, §4.2)", () => {
  it("creates people only past the threshold and never from bulk, machine or role senders", () => {
    const { mail } = loadAll();
    expect(mail.skipped).toBeGreaterThanOrEqual(4);
    expect(byName("Kai Tanaka")).toBeDefined(); // the owner wrote to them
    expect(byName("Lena Brandt")).toBeDefined(); // cc'd on two threads with the owner
    expect(graph.search("Random Person")).toEqual([]); // one inbound mail
    expect(graph.resolveIdentifier("email", "sam.lee.billing@evil.example")).toBeUndefined();
    for (const a of [
      "news@acme.com",
      "team@lists.example",
      "no-reply@calendar.example",
      "support@shop.example",
    ]) {
      expect(graph.resolveIdentifier("email", a), a).toBeUndefined();
    }
    // The look-alike "Sam Lee" never merged into or touched the real one.
    const sam = byName("Sam Lee");
    expect(graph.identifiers(sam?.id ?? "").map((i) => i.value)).not.toContain(
      "sam.lee.billing@evil.example",
    );
  });

  it("marks a family inbox shared, so it resolves to nobody on its own", () => {
    loadAll();
    expect(graph.resolveIdentifier("email", "lees@gmail.com")).toBeUndefined();
  });

  it("records direction and the unanswered ask becomes a waiting_on loop after 3 days", () => {
    loadAll();
    const sam = byName("Sam Lee");
    const interactions = graph.interactions(sam?.id ?? "", { limit: 50 });
    expect(interactions.some((i) => i.direction === "out" && i.subject === "SOW for Q4")).toBe(
      true,
    );
    expect(interactions.some((i) => i.kind === "meeting" && i.subject === "SOW review")).toBe(true);
    // Two asks qualify: the SOW (Sam Lee) and the forward asking Mo about the quote (no reply in that thread).
    const report = ingest.checkNoReply();
    expect(report.loops).toBe(2);
    expect(
      graph.loops({ direction: "waiting_on", entityId: byName("Mo Chen")?.id ?? "" }),
    ).toHaveLength(1);
    const [loop] = graph.loops({ direction: "waiting_on", entityId: sam?.id ?? "" });
    expect(loop).toMatchObject({
      counterpartId: sam?.id,
      text: "Could you send me the signed SOW by Friday?",
      provenance: "owner",
      detectedBy: "rule",
      status: "open",
    });
    // Dana answered the mockups ask: no loop for her.
    expect(graph.loops({ entityId: byName("Dana Fox")?.id ?? "" })).toEqual([]);
    // A reply closes it.
    ingest.ingestMail([
      {
        source: "apple:mail",
        messageId: "<reply@fixture>",
        date: clock.iso(),
        from: { email: "sam@acme.com", name: "Sam Lee" },
        to: [{ email: "pat@kim.example" }],
        subject: "Re: SOW for Q4",
        threadKey: "t-sow",
      },
    ]);
    expect(graph.getLoop(loop?.id ?? "")).toMatchObject({ status: "done", closedBy: "reply_seen" });
  });

  it("follows deletions at the source", () => {
    loadAll();
    const omar = byName("Omar Haddad");
    expect(graph.interactions(omar?.id ?? "")).toHaveLength(1);
    ingest.ingestMail(
      WORLD.deletedMails.map((d) => ({
        ...d,
        date: clock.iso(),
        from: { email: "omar@hadd.example" },
        deleted: true,
      })),
    );
    expect(graph.interactions(omar?.id ?? "")).toHaveLength(0);
  });

  it("ranks the two Sams by two-way contact", () => {
    loadAll();
    const sams = graph.search("sam", { kinds: ["person"] }).map((s) => s.name);
    expect(sams.slice(0, 2)).toEqual(["Sam Lee", "Sam Ortiz"]);
  });
});

describe("calendar and messages (§5.1)", () => {
  it("creates meeting attendees but never rooms; groups only attach known people", () => {
    const { events, messages } = loadAll();
    expect(events.created).toBe(1); // the partner's vendor
    expect(byName("Vic Vendor")).toBeDefined();
    expect(graph.search("Conf Room")).toEqual([]);
    const alex = byName("Alex Kim");
    expect(graph.interactions(alex?.id ?? "").filter((i) => i.kind === "message")).toHaveLength(2);
    const rita = byName("Rita Gomez");
    expect(graph.interactions(rita?.id ?? "").some((i) => i.threadKey === "chat-kitchen")).toBe(
      true,
    );
    expect(messages.created).toBe(0); // the Telegram stranger: the owner never answered
    expect(graph.resolveIdentifier("channel", "telegram:998877")).toBeUndefined();
  });

  it("creates the projects the owner names in chat", () => {
    ingest.ingestOwnerProjects(WORLD.ownerProjects);
    expect(graph.listEntities(["project"]).map((p) => p.name)).toEqual(["Kitchen remodel"]);
    expect(ingest.ingestOwnerProjects(WORLD.ownerProjects).created).toBe(0);
  });
});

describe("cards (§4.8, §5.4)", () => {
  it("renders a readable card within budget and writes it as a protected file", async () => {
    loadAll();
    ingest.checkNoReply();
    const sam = byName("Sam Lee");
    const cards = new CardSync(graph, env.store);
    const path = await cards.write(sam?.id ?? "");
    expect(path).toBe("people/sam-lee.md");
    const file = (await env.store.readFile(path ?? ""))?.content ?? "";
    expect(file.length).toBeLessThanOrEqual(2200);
    expect(file).toContain("# Sam Lee");
    expect(file).toContain("- Title: Head of product [contacts]");
    expect(file).toContain("- [ ] Waiting on: Could you send me the signed SOW by Friday?");
    expect(file).toContain("## Notes");
    const parsed = parseCard(file);
    expect(parsed).toMatchObject({ ok: true, id: sam?.id, emails: ["sam@acme.com"] });
    // The agent's memory tool cannot write cards.
    const err = await env.store
      .write(path ?? "", "x", { provenance: "agent" })
      .catch((e: unknown) => e);
    expect((err as PsycheError).code).toBe("policy_denied");
    expect(renderCard(graph, "ent_missing")).toBeUndefined();
  });

  it("turns the owner's edits into corrections the next ingest respects", async () => {
    loadAll();
    ingest.checkNoReply();
    const sam = byName("Sam Lee");
    const ortiz = byName("Sam Ortiz");
    const cards = new CardSync(graph, env.store);
    const path = (await cards.write(sam?.id ?? "")) ?? "";
    let file = (await env.store.readFile(path))?.content ?? "";
    file = file
      .replace(/^- Title: .*$/m, "") // delete the title line
      .replace("## Facts\n", "## Facts\n- City: Oakland\n") // add a fact
      .replace("- [ ] Waiting on:", "- [x] Waiting on:") // tick the loop
      .replace("emails:\n  - sam@acme.com", "emails:\n  - sam@acme.com\n  - sam.ortiz@gmail.com") // someone else's address
      .replace(
        /## Notes\n<!--.*-->\n?/,
        "## Notes\n<!-- Yours. Psyche never rewrites this section. -->\nMet at the Acme offsite.",
      );
    await env.store.writeFileAsOwner(path, file);
    const result = await cards.onFileChanged(path);
    expect(result?.applied).toEqual(
      expect.arrayContaining(["fact:city", "retract:title", "loop:done", "notes"]),
    );
    expect(result?.conflicts).toEqual(["sam.ortiz@gmail.com"]);
    expect(graph.facts(sam?.id ?? "").map((f) => [f.attribute, f.value, f.provenance])).toEqual([
      ["city", "Oakland", "owner"],
    ]);
    expect(graph.notes(sam?.id ?? "")).toBe("Met at the Acme offsite.");
    expect(graph.loops({ entityId: sam?.id ?? "" })).toEqual([]);
    expect(graph.suggestions()[0]?.entityIds.sort()).toEqual([sam?.id, ortiz?.id].sort());
    // Contacts still says "Head of product", but the owner's correction wins.
    ingest.ingestContacts(WORLD.contacts);
    expect(graph.facts(sam?.id ?? "").map((f) => f.attribute)).not.toContain("title");
    // The card was re-rendered with the edits and keeps the notes.
    const after = (await env.store.readFile(path))?.content ?? "";
    expect(after).toContain("- City: Oakland [you]");
    expect(after).toContain("Met at the Acme offsite.");
  });

  it("leaves a file that no longer parses as a card alone", async () => {
    loadAll();
    const sam = byName("Sam Lee");
    const cards = new CardSync(graph, env.store);
    const path = (await cards.write(sam?.id ?? "")) ?? "";
    await env.store.writeFileAsOwner(path, "just some notes, no front matter");
    await cards.onFileChanged(path);
    expect((await env.store.readFile(path))?.content).toBe("just some notes, no front matter");
    expect(graph.facts(sam?.id ?? "").length).toBeGreaterThan(0);
  });
});
