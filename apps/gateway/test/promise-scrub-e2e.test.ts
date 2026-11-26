import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import type { PromiseView } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import {
  adminClient,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  TestClient,
  wsUrlOf,
} from "./helpers.ts";

/**
 * The promise scrub through a composed Gateway: real connections (the desktop shell with its
 * handshake secret, and paired devices without it), the real bus personaliser, the real
 * `memory.loops.*` mount, `settings.set` and the device notification surface.
 */

const QUOTE = "I will send you the deck by Friday";
const NAME = "Sam Lee";
const NOW = "2026-11-24T10:00:00.000Z";

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
const clock = new FakeClock();

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 80));

async function setup(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-promise-scrub-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    clock,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

/** A paired device that is not the desktop shell: it reconnects without the handshake secret. */
async function remote(
  c: ComposedGateway,
  platform: "macos" | "ios" | "web",
  opts: { spoof?: boolean } = {},
): Promise<TestClient> {
  const key = newDeviceKey();
  const deviceId = `${platform}-${Math.random().toString(36).slice(2)}`;
  const first = await desktopClient(c.gateway, key, deviceId, platform);
  first.close();
  // An admin device is the strongest remote caller: the refusals must hold against it too.
  updateDevice(c.db, deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const t = await TestClient.open(wsUrlOf(c.gateway));
  clients.push(t);
  const r = await handshake(t, c.gateway.origin, {
    key,
    deviceId,
    platform,
    // The shell's family, with a wrong secret when spoofing: neither makes it the shell.
    ...(opts.spoof ? { handshakeSecret: "not-the-secret" } : {}),
  });
  if ((r.verifyRes?.payload as { phase?: string } | undefined)?.phase !== "paired")
    throw new Error(`remote did not pair: ${JSON.stringify(r.verifyRes)}`);
  return t;
}

interface Seeded {
  ids: Record<string, string>;
  sam: string;
}

function seed(c: ComposedGateway): Seeded {
  const g = c.people.graph;
  const sam = g.createEntity({ kind: "person", name: NAME, linkedBy: "rule", source: "mail" }).id;
  const mixes: Record<string, { kind: string; visible: 0 | 1; cites: string[] }> = {
    mail: { kind: "mail", visible: 1, cites: ["mail"] },
    messages: { kind: "messages", visible: 0, cites: ["messages"] },
    mixed: { kind: "mail", visible: 1, cites: ["mail", "messages"] },
    meeting: { kind: "meeting", visible: 1, cites: ["transcripts"] },
    chat: { kind: "chat", visible: 1, cites: ["chats"] },
  };
  const ids: Record<string, string> = {};
  let n = 0;
  for (const [name, m] of Object.entries(mixes)) {
    const loop = g.addLoop({
      direction: "i_owe",
      text: `Send the deck ${name}`,
      evidence: QUOTE,
      counterpartId: sam,
      status: "open",
      provenance: "owner",
      detectedBy: "owner",
    });
    if (loop === undefined) throw new Error("no loop");
    ids[name] = loop.id;
    c.db.sqlite
      .prepare("UPDATE graph_loops SET source_kind = ?, remote_visible = ? WHERE id = ?")
      .run(m.kind, m.visible, loop.id);
    for (const src of m.cites) {
      n += 1;
      c.db.sqlite
        .prepare(
          `INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start,
             "end", source_hash, provenance, observed_at, created_at)
           VALUES (?, 'loop', ?, ?, 'ref', ?, 0, 5, 'h', 'untrusted', ?, ?)`,
        )
        .run(`cit_${n}`, loop.id, src, QUOTE, NOW, NOW);
    }
  }
  return { ids, sam };
}

const VISIBLE = ["mail", "meeting", "chat"];

const promiseOf = (id: string, what: string, sourceKind: PromiseView["sourceKind"]): PromiseView =>
  ({
    id,
    direction: "i_owe",
    what,
    status: "open",
    state: "open",
    basis: "promise",
    whatAction: "send",
    counterpartLabel: NAME,
    counterpartId: "ent_sam",
    projectId: null,
    dueAt: null,
    dueText: null,
    dueKind: "none",
    dueConfidence: null,
    proposedDueAt: null,
    snoozedUntil: null,
    brokenAt: null,
    warnedAt: null,
    nudgeCount: 0,
    lastNudgeAt: null,
    sourceKind,
    provenance: "owner",
    confidence: 0.9,
    createdAt: NOW,
    closedAt: null,
    closedBy: null,
    citations: [
      {
        id: "c1",
        source: "mail",
        quote: QUOTE,
        sourceRef: "r",
        observedAt: NOW,
        provenance: "untrusted",
      },
    ],
  }) as PromiseView;

describe("promise scrub over real connections", () => {
  it("memory.loops.list and update: the shell sees the quote, remote devices do not", async () => {
    const c = await setup();
    const { ids } = seed(c);
    const shell = await desktopClient(c.gateway);
    clients.push(shell);
    const viewers = {
      "remote desktop": await remote(c, "macos"),
      iOS: await remote(c, "ios"),
      web: await remote(c, "web"),
      "spoofed shell": await remote(c, "macos", { spoof: true }),
    };

    const all = await shell.call<{ loops: { id: string; evidence: string | null }[] }>(
      "memory.loops.list",
      { limit: 50 },
    );
    expect(all.loops).toHaveLength(5);
    expect(JSON.stringify(all)).toContain(QUOTE);

    for (const [name, t] of Object.entries(viewers)) {
      const out = await t.call<{ loops: { id: string }[] }>("memory.loops.list", {
        limit: 50,
        // An earlier viewer snoozes one below; it is still listed.
        status: ["suggested", "open", "snoozed"],
        // A param cannot make a connection the shell.
        desktopShell: true,
      });
      expect(out.loops.map((l) => l.id).sort(), name).toEqual(
        VISIBLE.map((v) => ids[v] as string).sort(),
      );
      expect(JSON.stringify(out), name).not.toContain(QUOTE);

      for (const hidden of ["messages", "mixed"]) {
        const res = await t.request(
          "memory.loops.update",
          {
            id: ids[hidden],
            status: "done",
          },
          ik(),
        );
        expect(res.ok, `${name} ${hidden}`).toBe(false);
        expect((res.error as { code: string }).code).toBe("not_found");
      }
      // A remote viewer who may see a mail promise can still close it.
      const done = await t.call<{ loop: { status: string; evidence: string | null } }>(
        "memory.loops.update",
        { id: ids.chat, status: "snoozed" },
        ik(),
      );
      expect(done.loop).toMatchObject({ status: "snoozed", evidence: null });
    }
    // The hidden ones were never written.
    for (const hidden of ["messages", "mixed"])
      expect(c.people.graph.getLoop(ids[hidden] as string)?.status).toBe("open");
  });

  it("promise.updated and memory.loop.updated reach each subscriber in its own form", async () => {
    const c = await setup();
    const { ids } = seed(c);
    const shell = await desktopClient(c.gateway);
    clients.push(shell);
    const phone = await remote(c, "ios");
    const spoof = await remote(c, "macos", { spoof: true });

    const bus = c.gateway.bus;
    bus.publish("promise.updated", { promise: promiseOf(ids.mail as string, "mail one", "mail") });
    bus.publish("promise.updated", {
      promise: promiseOf(ids.messages as string, "messages one", "messages"),
    });
    bus.publish("promise.updated", {
      promise: promiseOf(ids.mixed as string, "mixed one", "mail"),
    });
    bus.publish("memory.loop.updated", {
      loop: c.people.graph.getLoop(ids.mail as string) as never,
    });
    bus.publish("memory.loop.updated", {
      loop: c.people.graph.getLoop(ids.messages as string) as never,
    });
    await settle();

    const shellPromises = shell.eventsNamed("promise.updated");
    expect(shellPromises).toHaveLength(3);
    expect(JSON.stringify(shellPromises)).toContain(QUOTE);
    expect(shell.eventsNamed("memory.loop.updated")).toHaveLength(2);

    for (const t of [phone, spoof]) {
      const ps = t.eventsNamed("promise.updated");
      expect(ps).toHaveLength(1);
      expect(JSON.stringify(ps)).toContain("mail one");
      expect(JSON.stringify(ps)).not.toContain(QUOTE);
      expect(JSON.stringify(ps)).not.toContain("ent_sam");
      const ls = t.eventsNamed("memory.loop.updated");
      expect(ls).toHaveLength(1);
      expect(JSON.stringify(ls)).not.toContain(QUOTE);
    }
  });

  it("settings.set of a promises.sources key: the shell may, a device may not", async () => {
    const c = await setup();
    const shell = await adminClient(c.gateway);
    clients.push(shell);
    const phone = await remote(c, "ios");
    const spoof = await remote(c, "macos", { spoof: true });

    for (const t of [phone, spoof]) {
      const res = await t.request(
        "settings.set",
        { key: "promises.sources.messages", value: true, desktopShell: true },
        ik(),
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatchObject({ code: "forbidden", details: { reason: "owner_only" } });
    }
    const ok = await shell.request(
      "settings.set",
      { key: "promises.sources.messages", value: true },
      ik(),
    );
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    const read = await phone.call<{ settings: Record<string, unknown> }>("settings.get", {
      keys: ["promises.sources.messages"],
    });
    expect(read.settings["promises.sources.messages"]).toBe(true);
  });
});
