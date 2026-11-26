import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertDevice } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { Call } from "../src/context.ts";
import { silentLogger } from "../src/log.ts";

/**
 * Security review R1 on #1717, through the composed Gateway's real handlers: a paired phone or
 * remote Mac is let into People, but `memory.entities.timeline` shows no hidden or Messages loop,
 * `memory.entities.export` (raw evidence, quotes, quarantine) is desktop and Host CLI only, and
 * `memory.entities.get` is unchanged. The desktop app and the Host CLI are the controls.
 */

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const call = (
  identity: Record<string, unknown>,
  origin: string | null = null,
  remoteLoopback = false,
): Call => ({ identity, conn: { peer: { origin, remoteLoopback } } }) as unknown as Call;
const WRITE = ["operator.read", "operator.write"] as const;
const desktop = call({ role: "client", desktopShell: true }, null, true);
const hostCli = call({ role: "client", localHostCli: true });
const phone = call({ role: "client", deviceId: "dev_phone", scopes: WRITE });
const mac = call({ role: "client", deviceId: "dev_mac", scopes: WRITE });
const web = call({ role: "client", deviceId: "dev_phone", scopes: WRITE }, "https://evil.example");

const MAIL_LOOP = "Send the mail deck to Sam";
const MSG_LOOP = "Return the ladder to Sam";
const EVIDENCE = "secret evidence quote from Messages";

async function world() {
  home = mkdtempSync(join(tmpdir(), "psyche-entloops-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const db = composed.gateway.context.db;
  for (const [id, platform, family] of [
    ["dev_phone", "ios", "ios"],
    ["dev_mac", "macos", "desktop"],
  ] as const)
    insertDevice(db, {
      id,
      name: id,
      platform,
      role: "client",
      publicKey: Buffer.alloc(32, id === "dev_phone" ? 7 : 9),
      scopes: WRITE,
      pairedAt: "2026-11-24T10:00:00.000Z",
      deviceFamily: family,
    });
  const graph = composed.people.graph;
  const sam = graph.createEntity({ kind: "person", name: "Sam Lee" }).id;
  const project = graph.createEntity({ kind: "project", name: "Lisbon trip" }).id;
  const loop = (text: string, kind: string, visible: 0 | 1, evidence: string) => {
    const l = graph.addLoop({
      direction: "i_owe",
      text,
      evidence,
      counterpartId: sam,
      projectId: project,
      status: "open",
      provenance: "owner",
      detectedBy: "owner",
    });
    if (l === undefined) throw new Error("no loop");
    composed?.db.sqlite
      .prepare("UPDATE graph_loops SET source_kind = ?, remote_visible = ? WHERE id = ?")
      .run(kind, visible, l.id);
    return l.id;
  };
  loop(MAIL_LOOP, "mail", 1, "mail evidence");
  loop(MSG_LOOP, "messages", 0, EVIDENCE);
  const handlers = composed.gateway.context.extraHandlers;
  const run = (name: string, c: Call, params: unknown) =>
    (handlers[name] as unknown as { run: (c: Call, p: unknown) => Promise<unknown> }).run(
      c,
      params,
    );
  return { run, sam, project };
}

type Timeline = { rows: { text: string; kind: string }[] };
const texts = (t: unknown) => (t as Timeline).rows.map((r) => r.text).join("\n");

describe("memory.entities.timeline per viewer (hidden loops)", () => {
  it("the desktop shell sees every loop row (positive control)", async () => {
    const w = await world();
    const t = texts(await w.run("memory.entities.timeline", desktop, { entityId: w.project }));
    expect(t).toContain(MAIL_LOOP);
    expect(t).toContain(MSG_LOOP);
  });

  it("the Host CLI is scrubbed like memory.loops.* (not the shell on this Mac)", async () => {
    const w = await world();
    const t = texts(await w.run("memory.entities.timeline", hostCli, { entityId: w.project }));
    expect(t).toContain(MAIL_LOOP);
    expect(t).not.toContain(MSG_LOOP);
  });

  it("the phone and a remote Mac keep the visible loop and lose the Messages one", async () => {
    const w = await world();
    for (const c of [phone, mac]) {
      const t = texts(await w.run("memory.entities.timeline", c, { entityId: w.project }));
      expect(t).toContain(MAIL_LOOP);
      expect(t).not.toContain(MSG_LOOP);
      expect(t).not.toContain("ladder");
    }
  });
});

describe("memory.entities.export (raw evidence)", () => {
  it("the desktop and the Host CLI get a full export", async () => {
    const w = await world();
    for (const c of [desktop, hostCli]) {
      const r = (await w.run("memory.entities.export", c, { id: w.sam })) as {
        bytes: number;
        mime: string;
      };
      expect(r.mime).toBe("application/zip");
      expect(r.bytes).toBeGreaterThan(0);
    }
  });

  it.each([
    ["phone", phone],
    ["remote Mac", mac],
    ["web (Origin)", web],
  ])("%s is refused and gets no bytes", async (_who, c) => {
    const w = await world();
    await expect(w.run("memory.entities.export", c, { id: w.sam })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("memory.entities.get is unchanged for the phone", () => {
  it("returns the person and only the visible open loop", async () => {
    const w = await world();
    const detail = (await w.run("memory.entities.get", phone, { id: w.sam })) as {
      entity: { name: string };
      openLoops: { text: string }[];
    };
    expect(detail.entity.name).toBe("Sam Lee");
    const loops = detail.openLoops.map((l) => l.text).join("\n");
    expect(loops).toContain(MAIL_LOOP);
    expect(loops).not.toContain(MSG_LOOP);
  });
});
