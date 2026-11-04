import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { Call } from "../src/context.ts";
import { silentLogger } from "../src/log.ts";

let composed: ComposedGateway | null = null;
let home = "";
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const call = (identity: Partial<Call["identity"]>): Call => ({ identity }) as unknown as Call;
const desktop = call({ role: "client", desktopShell: true });
const remote = call({ role: "client" });

/** The mounted `memory.entities.*` methods, as the Gateway serves them to a connection. */
async function world() {
  home = mkdtempSync(join(tmpdir(), "psyche-gist-wiring-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    timeZone: "UTC",
    clock: new FakeClock(Date.parse("2026-11-04T12:00:00Z")),
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: FakeModelProvider.script([]), model: "fake/model" },
  });
  const graph = composed.people.graph;
  const ava = graph.createEntity({ kind: "person", name: "Ava Stone" }).id;
  const i = graph.upsertInteraction({
    kind: "message",
    source: "messages",
    externalRef: "chat1:2026-11-03",
    occurredAt: "2026-11-03T10:00:00.000Z",
    direction: "in",
    participants: [{ entityId: ava, role: "from" }],
  });
  graph.setInteractionGist(i, "Talked about the Lisbon dates");
  // Search's own rule is tested apart (gist-sources.test.ts): here, Messages open on the desktop only.
  composed.people.useGistSources({
    docIdFor: (ref) =>
      ref.kind === "message" && ref.externalRef === "chat1:2026-11-03"
        ? "messages:chat1|2026-11-03|9"
        : undefined,
    canOpen: (c) => c.identity.desktopShell === true,
  });
  const handlers = composed.gateway.context.extraHandlers;
  const run = (name: string, c: Call, params: unknown) =>
    (handlers[name] as unknown as { run: (c: Call, p: unknown) => Promise<unknown> }).run(
      c,
      params,
    );
  return { ava, run };
}

describe("the mounted people methods and gist sources", () => {
  it("memory.entities.interactions strips gistDocId on a remote connection, not on the desktop", async () => {
    const w = await world();
    const read = async (c: Call) =>
      (
        (await w.run("memory.entities.interactions", c, { id: w.ava })) as {
          interactions: { gist?: string; gistDocId?: string }[];
        }
      ).interactions[0];
    expect(await read(desktop)).toMatchObject({
      gist: "Talked about the Lisbon dates",
      gistDocId: "messages:chat1|2026-11-03|9",
    });
    const remoteRow = await read(remote);
    expect(remoteRow?.gist).toBe("Talked about the Lisbon dates");
    expect(remoteRow).not.toHaveProperty("gistDocId");
  });

  it("memory.entities.get strips it from recentInteractions the same way", async () => {
    const w = await world();
    const read = async (c: Call) =>
      (
        (await w.run("memory.entities.get", c, { id: w.ava })) as {
          recentInteractions: { gistDocId?: string }[];
        }
      ).recentInteractions[0];
    expect(await read(desktop)).toHaveProperty("gistDocId", "messages:chat1|2026-11-03|9");
    expect(await read(remote)).not.toHaveProperty("gistDocId");
  });

  it("sends none to anyone while the check refuses (as it does with no index)", async () => {
    const w = await world();
    composed?.people.useGistSources({ docIdFor: () => undefined, canOpen: () => false });
    const res = (await w.run("memory.entities.interactions", desktop, { id: w.ava })) as {
      interactions: object[];
    };
    expect(res.interactions[0]).not.toHaveProperty("gistDocId");
  });
});

describe("the mounted memory.review.list and citations", () => {
  async function review() {
    const w = await world();
    const em = composed?.people.em;
    const graph = composed?.people.graph;
    if (em === undefined || graph === undefined) throw new Error("no graph");
    const sam = graph.createEntity({
      kind: "person",
      name: "Sam Lee",
      identifiers: [{ kind: "email", value: "sam@acme.com" }],
    }).id;
    const cite = (source: "messages" | "mail" | "contacts", docId: string, n: number) => ({
      source,
      docId,
      sourceRef: `native-${source}`,
      quote: "Dinner on Friday at 7",
      start: n,
      end: n + 20,
      sourceHash: `h${n}`,
    });
    const out = em.proposeFact({
      entityId: sam,
      attribute: "employer",
      value: "Initech",
      provenance: "untrusted",
      subjectKind: "self_disclosure",
      citations: [
        cite("messages", "messages:chat1|2026-11-03|9", 1),
        cite("mail", "mail:1", 2),
        cite("contacts", "contacts:c1", 3),
      ],
    });
    expect(out.status).toBe("pending");
    const read = async (c: Call) =>
      (
        (await w.run("memory.review.list", c, { state: ["pending"] })) as {
          items: {
            citations: {
              source: string;
              docId?: string | null;
              quote: string;
              sourceRef: string;
            }[];
          }[];
        }
      ).items[0]?.citations ?? [];
    return read;
  }

  it("keeps the quote of a Messages or Contacts citation for the desktop app only", async () => {
    const read = await review();
    const desk = await read(desktop);
    expect(desk.map((c) => [c.source, c.quote])).toEqual([
      ["messages", "Dinner on Friday at 7"],
      ["mail", "Dinner on Friday at 7"],
      ["contacts", "Dinner on Friday at 7"],
    ]);
    const rem = await read(remote);
    expect(rem.map((c) => [c.source, c.quote, c.sourceRef])).toEqual([
      ["messages", "", ""],
      ["mail", "Dinner on Friday at 7", "native-mail"],
      ["contacts", "", ""],
    ]);
  });

  it("sends no document id to a connection that cannot open it (here, with no index at all)", async () => {
    const read = await review();
    for (const c of [...(await read(remote)), ...(await read(desktop))])
      expect(c.docId ?? null).toBeNull();
  });
});
