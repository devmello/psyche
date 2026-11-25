import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * `memory.entities.create` does not make a second "Dana Whitfield" (QA 2026-11-25, bug 6): a
 * person, organisation or place that matches an active one by normalised name, alias or email
 * fails `conflict` with `details.entityId`, so a client can say "Already in Memory, open it?".
 * `allowDuplicate` is the owner's "create anyway". Work items (projects, assignments) repeat names.
 */

let composed: ComposedGateway | null = null;
let home = "";
let client: TestClient | null = null;

afterEach(async () => {
  client?.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function boot(): Promise<TestClient> {
  home = mkdtempSync(join(tmpdir(), "psyche-entdup-"));
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  client = await adminClient(composed.gateway);
  return client;
}

type Entity = { id: string; name: string };
const create = (c: TestClient, params: Record<string, unknown>) =>
  c.request("memory.entities.create", params, ik());
const created = (res: Awaited<ReturnType<typeof create>>): Entity =>
  (res.payload as { entity: Entity }).entity;

describe("memory.entities.create duplicates", () => {
  it("refuses a second Dana Whitfield and names the first", async () => {
    const c = await boot();
    const first = created(await create(c, { kind: "person", name: "Dana Whitfield" }));
    for (const name of ["Dana Whitfield", "dana  whitfield", "  DANA WHITFIELD "]) {
      const res = await create(c, { kind: "person", name });
      expect(res.ok, name).toBe(false);
      const err = res.error as { code: string; details?: Record<string, unknown> };
      expect(err.code).toBe("conflict");
      expect(err.details).toMatchObject({
        reason: "entity_exists",
        entityId: first.id,
        kind: "person",
      });
    }
    const found = await c.call<{ entities: Entity[] }>("memory.entities.search", {
      q: "Whitfield",
      kinds: ["person"],
    });
    expect(found.entities).toHaveLength(1);
  });

  it("matches an alias of an existing person, and by email when one is given", async () => {
    const c = await boot();
    const first = created(
      await create(c, {
        kind: "person",
        name: "Dana Whitfield",
        aliases: ["Dee"],
        identifiers: [{ kind: "email", value: "dana@example.com" }],
      }),
    );
    const byAlias = await create(c, { kind: "person", name: "Dee" });
    expect((byAlias.error as { details?: { entityId?: string } }).details?.entityId).toBe(first.id);
    const byEmail = await create(c, {
      kind: "person",
      name: "D. Whitfield",
      identifiers: [{ kind: "email", value: "Dana@Example.com" }],
    });
    expect(byEmail.ok).toBe(false);
    expect((byEmail.error as { details?: { entityId?: string } }).details?.entityId).toBe(first.id);
  });

  it("controls: a different name, allowDuplicate, other kinds and work items still create", async () => {
    const c = await boot();
    const first = created(await create(c, { kind: "person", name: "Dana Whitfield" }));
    const other = await create(c, { kind: "person", name: "Dana Whitfield-Reyes" });
    expect(other.ok).toBe(true);
    const forced = await create(c, {
      kind: "person",
      name: "Dana Whitfield",
      allowDuplicate: true,
    });
    expect(forced.ok).toBe(true);
    expect(created(forced).id).not.toBe(first.id);
    // A project may share a person's name; two projects may share a name.
    expect((await create(c, { kind: "project", name: "Dana Whitfield" })).ok).toBe(true);
    expect((await create(c, { kind: "project", name: "Q4 budget" })).ok).toBe(true);
    expect((await create(c, { kind: "project", name: "Q4 budget" })).ok).toBe(true);
    expect((await create(c, { kind: "assignment", name: "Essay" })).ok).toBe(true);
    expect((await create(c, { kind: "assignment", name: "Essay" })).ok).toBe(true);
  });

  it("an organisation or place is matched like a person, and kinds do not cross", async () => {
    const c = await boot();
    await create(c, { kind: "org", name: "Acme Corp" });
    expect((await create(c, { kind: "org", name: "acme corp" })).ok).toBe(false);
    // The same words as a person are a different thing.
    expect((await create(c, { kind: "person", name: "Acme Corp" })).ok).toBe(true);
    await create(c, { kind: "place", name: "Blue Bottle" });
    expect((await create(c, { kind: "place", name: "Blue Bottle" })).ok).toBe(false);
  });
});
