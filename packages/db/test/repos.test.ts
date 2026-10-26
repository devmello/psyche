import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  createPairingRequest,
  createRun,
  createThread,
  decidePairingRequest,
  deleteSettings,
  expirePairingRequests,
  finishRun,
  getDevice,
  getPairingRequest,
  getSetting,
  getSettings,
  getThread,
  insertDevice,
  listDevices,
  listThreads,
  revokeDevice,
  setSetting,
  touchLastSeen,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const KEY = new Uint8Array(32).fill(7);

describe("settings", () => {
  it("round-trips JSON values and upserts", () => {
    const db = memoryDb();
    expect(getSetting(db, "appearance.theme")).toBeUndefined();
    const first = setSetting(db, "appearance.theme", "dark");
    expect(first).toEqual({ key: "appearance.theme", value: "dark", updatedAt: first.updatedAt });
    setSetting(db, "models.roles", {
      primary: "anthropic/claude-sonnet-5-5",
      fallbacks: [1, null],
    });
    setSetting(db, "flags.enabled", false);
    const updated = setSetting(db, "appearance.theme", { mode: "light" });
    expect(updated.updatedAt > first.updatedAt).toBe(true);

    expect(getSetting(db, "appearance.theme")?.value).toEqual({ mode: "light" });
    expect(getSettings(db)).toEqual({
      "appearance.theme": { mode: "light" },
      "flags.enabled": false,
      "models.roles": { primary: "anthropic/claude-sonnet-5-5", fallbacks: [1, null] },
    });
    expect(getSettings(db, ["flags.enabled", "missing"])).toEqual({ "flags.enabled": false });
    expect(getSettings(db, [])).toEqual({});
    expect(() => setSetting(db, "x", undefined)).toThrow(TypeError);
  });

  it("deletes settings and reports the keys that existed", () => {
    const db = memoryDb();
    setSetting(db, "a", 1);
    setSetting(db, "b", 2);
    setSetting(db, "c", 3);
    expect(deleteSettings(db, ["a", "c", "missing"]).sort()).toEqual(["a", "c"]);
    expect(getSettings(db)).toEqual({ b: 2 });
    expect(deleteSettings(db, [])).toEqual([]);
    expect(deleteSettings(db, ["a"])).toEqual([]);
  });
});

describe("devices", () => {
  it("inserts, lists, touches and revokes", () => {
    const db = memoryDb();
    const d = insertDevice(db, {
      name: "MacBook",
      platform: "macos",
      role: "both",
      publicKey: KEY,
      tokenHash: new Uint8Array([1, 2, 3]),
      scopes: ["operator.read", "operator.write"],
      pairedAt: "2026-10-18T22:00:00.000Z",
    });
    expect(d.publicKey).toBe(Buffer.from(KEY).toString("base64url"));
    expect(getDevice(db, d.id)).toEqual(d);
    expect(touchLastSeen(db, d.id, "2026-10-18T23:00:00.000Z")).toBe(true);
    expect(getDevice(db, d.id)?.lastSeenAt).toBe("2026-10-18T23:00:00.000Z");
    expect(listDevices(db)).toHaveLength(1);
    const revoked = revokeDevice(db, d.id);
    expect(revoked?.revokedAt).not.toBeNull();
    expect(listDevices(db)).toHaveLength(0);
    expect(listDevices(db, { includeRevoked: true })).toHaveLength(1);
    const row = db.sqlite.prepare("SELECT token_hash FROM devices WHERE id = ?").get(d.id);
    expect(row).toEqual({ token_hash: null });
    expect(revokeDevice(db, "missing")).toBeUndefined();
  });
});

describe("pairing requests", () => {
  it("approves a pending request once", () => {
    const db = memoryDb();
    const admin = insertDevice(db, {
      name: "Mac",
      platform: "macos",
      role: "client",
      publicKey: KEY,
    });
    const phone = insertDevice(db, {
      name: "Phone",
      platform: "ios",
      role: "client",
      publicKey: KEY,
    });
    const req = createPairingRequest(db, {
      kind: "device",
      code: "123456",
      deviceId: phone.id,
      display: "iPhone 18",
    });
    expect(req.status).toBe("pending");
    const approved = decidePairingRequest(db, req.id, {
      decision: "approved",
      decidedByDeviceId: admin.id,
    });
    expect(approved).toMatchObject({ status: "approved", decidedByDeviceId: admin.id });
    expect(() => decidePairingRequest(db, req.id, { decision: "denied" })).toThrow(PsycheError);
    expect(() => decidePairingRequest(db, "nope", { decision: "denied" })).toThrow(/not found/);
  });

  it("expires stale requests", () => {
    const db = memoryDb();
    const stale = createPairingRequest(db, {
      kind: "channel-sender",
      code: "A1",
      channelId: "telegram",
      senderId: "12345",
      display: "@someone",
      expiresAt: "2026-10-18T22:05:00Z",
    });
    const fresh = createPairingRequest(db, {
      kind: "channel-sender",
      code: "B2",
      display: "@other",
      expiresAt: "2026-10-18T23:00:00.000Z",
    });
    expect(stale.expiresAt).toBe("2026-10-18T22:05:00.000Z");
    expect(expirePairingRequests(db, "2026-10-18T22:10:00.000Z")).toBe(1);
    expect(getPairingRequest(db, stale.id)?.status).toBe("expired");
    expect(getPairingRequest(db, fresh.id)?.status).toBe("pending");
    expect(expirePairingRequests(db, "2026-10-18T22:10:00.000Z")).toBe(0);
    expect(() => decidePairingRequest(db, stale.id, { decision: "approved" })).toThrow(/expired/);
  });

  it("refuses to approve a request past its expiry even before the sweep", () => {
    const db = memoryDb(); // clock starts at 2026-10-18T22:00:00.000Z
    const req = createPairingRequest(db, {
      kind: "device",
      code: "C3",
      display: "x",
      expiresAt: "2026-10-18T21:00:00.000Z",
    });
    expect(() => decidePairingRequest(db, req.id, { decision: "approved" })).toThrow(/expired/);
    expect(getPairingRequest(db, req.id)?.status).toBe("expired");
  });
});

describe("threads and runs", () => {
  it("creates, lists and finishes", () => {
    const db = memoryDb();
    const main = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const side = createThread(db, {
      kind: "side",
      sessionKey: "owner:side",
      parentThreadId: main.id,
      title: "Side quest",
      pinned: true,
    });
    expect(main).toMatchObject({
      title: "",
      titleSource: "auto",
      permissionMode: "balanced",
      pinned: false,
    });
    expect(side).toMatchObject({ titleSource: "user", pinned: true, parentThreadId: main.id });
    expect(listThreads(db).map((t) => t.id)).toEqual([side.id, main.id]);
    expect(listThreads(db, { kind: "main" }).map((t) => t.id)).toEqual([main.id]);
    expect(listThreads(db, { limit: 1 })).toHaveLength(1);
    expect(getThread(db, "missing")).toBeUndefined();

    const run = createRun(db, { threadId: main.id, modelRef: "anthropic/claude-sonnet-5-5" });
    expect(run).toMatchObject({ status: "running", attempt: 1, endedAt: null });
    const done = finishRun(db, run.id, {
      status: "done",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2, costUsd: 0.01 },
    });
    expect(done).toMatchObject({ status: "done", usage: { input: 10, costUsd: 0.01 } });
    expect(done.endedAt).not.toBeNull();
    expect(() => finishRun(db, "missing", { status: "failed" })).toThrow(/not found/);
  });
});
