import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { updateHandlers } from "../src/compose/update.ts";
import { BusySources, UpdateGate } from "../src/update-gate.ts";
import {
  adminClient,
  handshake,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/** Review fixes around the update gate: who is told the build, and what a drain flushes. */

const cleanups: (() => Promise<void> | void)[] = [];
const open: TestClient[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  for (const fn of cleanups.splice(0)) await fn();
});

describe("the build in the challenge (L5)", () => {
  it("goes to the Host's own app only, not to a proxied or browser peer", async () => {
    const publicOrigin = "https://studio-mac.tail1234.ts.net";
    const t: TestGateway = await startTestGateway({
      config: { publicOrigin, allowedOrigins: [publicOrigin, "http://127.0.0.1:5173"] },
    });
    cleanups.push(() => t.cleanup());
    const local = await TestClient.open(wsUrlOf(t.gateway));
    open.push(local);
    const own = await handshake(local, t.gateway.origin, {
      handshakeSecret: t.gateway.handshakeSecret,
    });
    expect((own.challengeRes.payload as { server?: unknown }).server).toMatchObject({
      version: expect.any(String),
      build: expect.any(String),
    });

    const proxied = await TestClient.open(wsUrlOf(t.gateway), { "x-forwarded-for": "100.64.0.9" });
    open.push(proxied);
    const remote = await handshake(proxied, publicOrigin, {
      key: newDeviceKey(),
      gatewayKey: t.gateway.context.identity.publicKey,
    });
    expect(remote.challengeRes.ok).toBe(true);
    expect(remote.challengeRes.payload).not.toHaveProperty("server");

    // A page in the browser: loopback, but with an Origin.
    const page = await TestClient.open(wsUrlOf(t.gateway), { origin: "http://127.0.0.1:5173" });
    open.push(page);
    const web = await handshake(page, "http://127.0.0.1:5173", { deviceFamily: "web" });
    if (web.challengeRes.ok === true) expect(web.challengeRes.payload).not.toHaveProperty("server");
  });
});

describe("preparing flushes every database (L7)", () => {
  it("truncates the write-ahead log of the other plain databases, and leaves locked ones alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "psy-flush-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, "state"));
    const other = join(home, "state", "search.sqlite");
    const d = new DatabaseSync(other);
    d.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    d.exec("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1), (2), (3);");
    const wal = `${other}-wal`;
    expect(statSync(wal).size).toBeGreaterThan(0);
    // A file that is not plain SQLite is not touched.
    writeFileSync(join(home, "state", "memory.sqlite"), "ciphertext");

    const db = openDb(":memory:");
    const gate = new UpdateGate();
    const t = await startTestGateway({
      db,
      home,
      updateGate: gate,
      handlers: updateHandlers({
        db,
        home,
        gate,
        runningTasks: async () => [],
        broker: { list: async () => [] },
        busy: new BusySources(),
      }),
    });
    cleanups.push(() => t.cleanup());
    const owner = await adminClient(t.gateway);
    open.push(owner);
    const report = await owner.call<{ ready: boolean }>("gateway.prepareUpdate", { waitMs: 0 });
    expect(report.ready).toBe(true);
    // The log was folded into the main file and emptied, though another connection is open.
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
    d.close();
    const check = new DatabaseSync(other, { readOnly: true });
    expect(check.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 });
    check.close();
  });
});
