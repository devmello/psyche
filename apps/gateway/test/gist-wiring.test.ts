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
  graph.setInteractionGist(i, "Talked about the Lisbon dates", "messages:chat1|2026-11-03|9");
  // Search's own rule is tested apart (gist-sources.test.ts): here, Messages open on the desktop only.
  composed.people.useGistSources({
    docIdFor: () => undefined,
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
