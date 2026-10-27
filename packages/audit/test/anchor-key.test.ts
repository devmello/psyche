import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANCHOR_KEY_FILE, SoftwareAnchorKey } from "../src/anchor-key.ts";
import { createAuditLog } from "../src/log.ts";
import { ANCHOR_FILE, FileAuditStore } from "../src/store.ts";

/** Signed anchors (security §15.1, docs/archive/status/s05.md §2 gap 6). */

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

let t = Date.parse("2026-10-19T12:00:00.000Z");
const clock = { now: () => t };

function setup(options: { anchorIntervalMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "psyche-anchor-"));
  homes.push(home);
  const open = () => {
    const store = new FileAuditStore(join(home, "audit"));
    const key = SoftwareAnchorKey.open(home, (store.tail()?.seq ?? -1) + 1);
    const log = createAuditLog({
      store,
      clock,
      signer: key,
      verifier: key,
      anchorEvery: 3,
      ...options,
    });
    return { store, key, log };
  };
  return { home, open };
}

const add = async (log: ReturnType<typeof createAuditLog>, n: number) => {
  for (let i = 0; i < n; i++) {
    t += 1000;
    await log.append({ kind: "test.entry", actor: { type: "system" }, data: { i } });
  }
};

function monthFile(home: string): string {
  const dir = join(home, "audit");
  const name = readdirSync(dir).find((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)) as string;
  return join(dir, name);
}

describe("SoftwareAnchorKey", () => {
  it("signs every boundary; verify checks each signature and reports the key", async () => {
    const { open, home } = setup();
    const { log, key } = open();
    await add(log, 7);
    const r = await log.verifyDetailed();
    expect(r).toMatchObject({
      ok: true,
      count: 7,
      anchors: 2,
      signedAnchors: 2,
      anchorKeyIds: [key.keyId],
      signingSinceSeq: 0,
    });
    expect(key.keyId).toMatch(/^ed25519:[0-9a-f]{16}$/);
    expect(statSync(join(home, ANCHOR_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "security")).mode & 0o777).toBe(0o700);
    // Reopening keeps the key.
    expect(open().key.keyId).toBe(key.keyId);
  });

  it("a forged anchor signature fails anchor_signature", async () => {
    const { open, home } = setup();
    const { log } = open();
    await add(log, 3);
    const path = join(home, "audit", ANCHOR_FILE);
    const anchor = JSON.parse(readFileSync(path, "utf8").trim());
    anchor.signature = Buffer.alloc(64, 7).toString("base64");
    writeFileSync(path, `${JSON.stringify(anchor)}\n`);
    expect(await open().log.verifyDetailed()).toMatchObject({
      ok: false,
      reason: "anchor_signature",
      brokenAtSeq: 2,
    });
  });

  it("deleting anchors.jsonl is anchor_missing", async () => {
    const { open, home } = setup();
    await add(open().log, 4);
    rmSync(join(home, "audit", ANCHOR_FILE));
    expect(await open().log.verifyDetailed()).toMatchObject({
      ok: false,
      reason: "anchor_missing",
    });
  });

  it("cutting the tail together with its anchors is truncated (the head is outside audit/)", async () => {
    const { open, home } = setup();
    await add(open().log, 7);
    // Keep entries 0-4 and only the first anchor (seq 2): a consistent, shorter log.
    const file = monthFile(home);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(file, `${lines.slice(0, 5).join("\n")}\n`);
    const anchors = join(home, "audit", ANCHOR_FILE);
    writeFileSync(anchors, `${readFileSync(anchors, "utf8").trim().split("\n")[0]}\n`);
    expect(await open().log.verifyDetailed()).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("a key enrolled on an existing log requires signatures only from its first entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-anchor-"));
    homes.push(home);
    const unsigned = createAuditLog({ dir: join(home, "audit"), clock, anchorEvery: 3 });
    await add(unsigned, 5);
    const store = new FileAuditStore(join(home, "audit"));
    const key = SoftwareAnchorKey.open(home, (store.tail()?.seq ?? -1) + 1);
    expect(key.signingSinceSeq()).toBe(5);
    const log = createAuditLog({ store, clock, signer: key, verifier: key, anchorEvery: 3 });
    expect(await log.verifyDetailed()).toMatchObject({ ok: true, signedAnchors: 0 });
    await add(log, 4);
    // Boundary 5 and 8 are anchored and signed; the unsigned boundary 2 is not required.
    expect(await log.verifyDetailed()).toMatchObject({
      ok: true,
      count: 9,
      signedAnchors: 2,
      signingSinceSeq: 5,
    });
  });

  it("anchorIntervalMs anchors a quiet log's tail; forgetHead clears the head", async () => {
    const { open } = setup({ anchorIntervalMs: 60 * 60_000 });
    const { log, key } = open();
    await add(log, 1);
    // The first entry anchors (no earlier anchor), the next one not, an hour later again.
    expect(key.head()?.seq).toBe(0);
    await add(log, 1);
    expect(key.head()?.seq).toBe(0);
    t += 60 * 60_000;
    await add(log, 1);
    // seq 2 is also the boundary.
    expect(key.head()?.seq).toBe(2);
    t += 60 * 60_000;
    await add(log, 1);
    expect(key.head()?.seq).toBe(3);
    expect(await log.verifyDetailed()).toMatchObject({ ok: true, signedAnchors: 3 });
    expect(key.forgetHead()?.seq).toBe(3);
    expect(open().key.head()).toBeUndefined();
  });
});
