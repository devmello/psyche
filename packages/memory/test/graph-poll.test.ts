import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GraphSourceAdapter, pollCursorKey, runGraphPoll } from "../src/graph/poll.ts";
import { GraphStore } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const WORLD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "graph", "world.json"),
    "utf8",
  ),
);

let env: TestEnv;
let graph: GraphStore;
let clock: FakeClock;

beforeEach(async () => {
  clock = new FakeClock(Date.parse(WORLD.now));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
});
afterEach(async () => env.cleanup());

/** Serves the fixture world in pages of `size`, with the index as the cursor. */
function paged<T>(
  id: string,
  source: GraphSourceAdapter["source"],
  key: "contacts" | "mails" | "events" | "messages",
  items: T[],
  size = 1000,
  identities?: { emails?: string[]; phones?: string[] },
): GraphSourceAdapter & { pulls: unknown[] } {
  const pulls: unknown[] = [];
  return {
    id,
    source,
    pulls,
    ...(identities === undefined ? {} : { ownerIdentities: async () => identities }),
    async pull(cursor) {
      pulls.push(cursor);
      const from = (cursor as { at?: number } | null)?.at ?? 0;
      return { [key]: items.slice(from, from + size), cursor: { at: from + size } };
    },
  };
}

const all = (size = 1000) => [
  paged("mail:apple", "mail", "mails", WORLD.mails, size, { emails: WORLD.owner.emails }),
  paged("calendar:apple", "calendar", "events", WORLD.events, size),
  paged("messages:imessage", "messages", "messages", WORLD.messages, size, {
    phones: WORLD.owner.phones,
  }),
  paged("contacts:apple", "contacts", "contacts", WORLD.contacts, size),
];

describe("deterministic pass polling (§5.1)", () => {
  it("polls only the sources the owner turned on, contacts first", async () => {
    const adapters = all();
    const report = await runGraphPoll(graph, adapters, {
      enabled: { contacts: true, mail: true },
      clock,
    });
    expect(report.adapters.map((a) => a.id)).toEqual(["contacts:apple", "mail:apple"]);
    expect(adapters[1]?.pulls).toEqual([]);
    expect(report.interactions).toBeGreaterThan(0);
    // Mail people resolved to their Contacts entries instead of new candidates.
    const sam = graph.resolveIdentifier("email", "sam@acme.com");
    expect(graph.getEntity(sam ?? "")?.name).toBe("Sam Lee");
    expect(graph.interactions(sam ?? "").some((i) => i.kind === "mail")).toBe(true);
    expect(graph.interactions(sam ?? "").some((i) => i.kind === "meeting")).toBe(false);
  });

  it("continues from the stored cursor and leaves it on failure", async () => {
    const mail = paged("mail:apple", "mail", "mails", WORLD.mails, 10, {
      emails: WORLD.owner.emails,
    });
    await runGraphPoll(graph, [mail], { enabled: { mail: true }, clock });
    await runGraphPoll(graph, [mail], { enabled: { mail: true }, clock });
    expect(mail.pulls).toEqual([null, { at: 10 }]);
    expect(graph.cursor(pollCursorKey("mail:apple"))).toEqual({ at: 20 });
    const broken: GraphSourceAdapter = {
      id: "mail:apple",
      source: "mail",
      pull: () => Promise.reject(new Error("offline")),
    };
    const report = await runGraphPoll(graph, [broken], { enabled: { mail: true }, clock });
    expect(report.adapters).toEqual([{ id: "mail:apple", source: "mail", ok: false }]);
    expect(graph.cursor(pollCursorKey("mail:apple"))).toEqual({ at: 20 });
  });

  it("learns the owner's addresses from the accounts, so sent mail counts as the owner's", async () => {
    await runGraphPoll(graph, all(), {
      enabled: { contacts: true, mail: true, calendar: true, messages: true },
      clock,
    });
    const sam = graph.resolveIdentifier("email", "sam@acme.com") ?? "";
    const directions = new Set(graph.interactions(sam, { limit: 50 }).map((i) => i.direction));
    expect(directions.has("out")).toBe(true);
    // Re-polling the same pages changes nothing (interactions are idempotent by source item).
    const before = (
      env.db.sqlite.prepare("SELECT count(*) AS n FROM graph_interactions").get() as {
        n: number;
      }
    ).n;
    for (const key of ["mail:apple", "calendar:apple", "messages:imessage", "contacts:apple"])
      graph.setCursor(pollCursorKey(key), null);
    await runGraphPoll(graph, all(), {
      enabled: { contacts: true, mail: true, calendar: true, messages: true },
      clock,
    });
    expect(
      (env.db.sqlite.prepare("SELECT count(*) AS n FROM graph_interactions").get() as { n: number })
        .n,
    ).toBe(before);
  });
});
