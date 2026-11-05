import { chmodSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSignalSocket,
  checkSignalTcpPeer,
  parseSignalTcpAddress,
  SIGNAL_MAX_ATTACHMENT_BYTES,
  SIGNAL_RECONNECT_MAX_MS,
  SIGNAL_REFUSED_METHODS,
  SignalAdapter,
  type SignalPeerTools,
  SignalRpcClient,
} from "../../src/adapters/signal/index.ts";
import {
  ACCOUNT,
  FixtureDaemon,
  type Harness,
  harness,
  OWNER,
  textEnvelope,
  ticks,
  untilConnected,
  WINDOWS,
} from "./helpers.ts";

const uid = process.getuid?.() ?? 0;

let h: Harness | undefined;
const daemons: FixtureDaemon[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of daemons.splice(0)) await d.close();
});

async function daemon(): Promise<FixtureDaemon> {
  const d = await FixtureDaemon.start();
  daemons.push(d);
  return d;
}

describe("Signal connection", () => {
  it("connects, and reconnects with back-off after the daemon drops the connection", async () => {
    h = await harness();
    expect(await h.adapter.health()).toMatchObject({ ok: true });
    h.daemon.dropClients();
    await h.daemon.waitForConnections(2);
    await untilConnected(h.adapter);
    expect(h.reconnectSleeps).toEqual([1000]);
    expect(h.adapter.reconnects).toBe(1);
    expect(await h.adapter.health()).toMatchObject({ ok: true });
    // Inbound flows on the new connection.
    h.daemon.push(textEnvelope(OWNER, "still there?"));
    await h.settle();
    expect(h.delivered.map((e) => e.message.text)).toEqual(["still there?"]);
  });

  it("backs off up to 60 s while the daemon is gone and reports why", async () => {
    h = await harness();
    await h.daemon.stopListening();
    for (let i = 0; i < 200 && h.reconnectSleeps.length < 9; i++) await ticks(1);
    expect(h.reconnectSleeps.slice(0, 8)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
    expect(Math.max(...h.reconnectSleeps)).toBe(SIGNAL_RECONNECT_MAX_MS);
    const health = await h.adapter.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain(`cannot reach signal-cli at ${h.daemon.path}`);
    await h.daemon.listen();
    await h.daemon.waitForConnections(2);
    await untilConnected(h.adapter);
    expect(await h.adapter.health()).toMatchObject({ ok: true });
  });

  it("start fails with 'cannot reach' when no daemon is listening", async () => {
    const d = await daemon();
    await d.stopListening();
    const adapter = new SignalAdapter({ socketPath: d.path, account: ACCOUNT });
    await expect(adapter.start()).rejects.toMatchObject({ code: "unavailable" });
    expect((await adapter.health()).detail).toContain(`cannot reach signal-cli at ${d.path}`);
  });
});

// UNIX socket modes and owners: Windows reaches signal-cli over loopback TCP instead (below).
describe.skipIf(WINDOWS)("Signal socket permission check", () => {
  it("accepts the owner's own 0700 socket", async () => {
    const d = await daemon();
    expect(await checkSignalSocket(d.path, uid)).toBeUndefined();
  });

  it("refuses a group- or world-writable socket (fatal health)", async () => {
    const d = await daemon();
    chmodSync(d.path, 0o770);
    const adapter = new SignalAdapter({ socketPath: d.path, account: ACCOUNT });
    await expect(adapter.start()).rejects.toMatchObject({ code: "forbidden" });
    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/group- or world-writable/);
    expect(d.connections).toBe(0);
  });

  it("refuses a socket in a group-writable directory", async () => {
    const d = await daemon();
    chmodSync(d.dir, 0o770);
    expect(await checkSignalSocket(d.path, uid)).toMatch(/directory .* group- or world-writable/);
    chmodSync(d.dir, 0o700);
  });

  it("refuses a socket owned by someone else", async () => {
    const d = await daemon();
    const adapter = new SignalAdapter({ socketPath: d.path, account: ACCOUNT, uid: uid + 1 });
    await expect(adapter.start()).rejects.toMatchObject({ code: "forbidden" });
    expect((await adapter.health()).detail).toMatch(/belongs to another user/);
    expect(d.connections).toBe(0);
  });

  it("refuses something that is not a socket", async () => {
    const d = await daemon();
    expect(await checkSignalSocket(d.dir, uid)).toMatch(/is not a socket/);
  });
});

describe("Signal over loopback TCP (Windows)", () => {
  const me = "HOST\\owner";
  const conn = {
    local: { address: "127.0.0.1", port: 50_001 },
    remote: { address: "127.0.0.1", port: 7583 },
  };
  const netstat = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       900",
    "  TCP    127.0.0.1:7583         0.0.0.0:0              LISTENING       4242",
    "  TCP    127.0.0.1:7583         127.0.0.1:50001        ESTABLISHED     4242",
    "  TCP    127.0.0.1:50001        127.0.0.1:7583         ESTABLISHED     77",
  ].join("\r\n");
  function tools(text: string, users: Record<number, string> = { 4242: me }): SignalPeerTools {
    return { netstat: async () => text, processUser: async (pid) => users[pid] };
  }

  it("takes only loopback addresses", () => {
    expect(parseSignalTcpAddress("127.0.0.1:7583")).toEqual({ host: "127.0.0.1", port: 7583 });
    expect(parseSignalTcpAddress("[::1]:7583")).toEqual({ host: "::1", port: 7583 });
    expect(parseSignalTcpAddress("localhost:7583")).toEqual({ host: "localhost", port: 7583 });
    for (const bad of ["0.0.0.0:7583", "192.168.1.5:7583", "example.com:7583", "127.0.0.1:0"]) {
      expect(parseSignalTcpAddress(bad)).toBeUndefined();
    }
    expect(parseSignalTcpAddress("C:\\signal\\socket")).toBeUndefined();
  });

  it("accepts the owner's own daemon on loopback", async () => {
    expect(await checkSignalTcpPeer(conn, me, "127.0.0.1:7583", tools(netstat))).toBeUndefined();
    // Account names compare case-insensitively, as Windows does.
    expect(
      await checkSignalTcpPeer(conn, "host\\OWNER", "127.0.0.1:7583", tools(netstat)),
    ).toBeUndefined();
  });

  it("refuses a daemon run by another user, or one Windows will not name", async () => {
    expect(
      await checkSignalTcpPeer(conn, me, "a", tools(netstat, { 4242: "HOST\\other" })),
    ).toMatch(/belongs to another user \(HOST\\other\)/);
    expect(await checkSignalTcpPeer(conn, me, "a", tools(netstat, {}))).toMatch(
      /belongs to another user/,
    );
  });

  it("refuses a daemon that also listens beyond this computer", async () => {
    const open = `${netstat}\r\n  TCP    0.0.0.0:7583           0.0.0.0:0              LISTENING       4242`;
    expect(await checkSignalTcpPeer(conn, me, "a", tools(open))).toMatch(/beyond this computer/);
  });

  it("refuses when the far end cannot be found or is not loopback", async () => {
    expect(await checkSignalTcpPeer(conn, me, "a", tools(""))).toMatch(/cannot tell/);
    const failing: SignalPeerTools = {
      netstat: async () => {
        throw new Error("no netstat");
      },
      processUser: async () => me,
    };
    expect(await checkSignalTcpPeer(conn, me, "a", failing)).toMatch(/cannot tell/);
    const remote = { local: conn.local, remote: { address: "10.0.0.2", port: 7583 } };
    expect(await checkSignalTcpPeer(remote, me, "a", tools(netstat))).toMatch(/loopback/);
  });

  it.skipIf(!WINDOWS)("connects to this user's own daemon", async () => {
    const d = await daemon();
    const adapter = new SignalAdapter({ socketPath: d.path, account: ACCOUNT });
    await adapter.start();
    expect(await adapter.health()).toMatchObject({ ok: true });
    await adapter.stop();
  });

  it.skipIf(!WINDOWS)(
    "refuses a daemon run by someone else before writing (fatal health)",
    async () => {
      const d = await daemon();
      const adapter = new SignalAdapter({
        socketPath: d.path,
        account: ACCOUNT,
        windowsUser: "NOWHERE\\nobody",
      });
      await expect(adapter.start()).rejects.toMatchObject({ code: "forbidden" });
      expect((await adapter.health()).detail).toMatch(/belongs to another user/);
      expect(d.lines).toEqual([]);
    },
  );

  it.skipIf(!WINDOWS)("refuses a socket path: Windows uses --tcp", async () => {
    const adapter = new SignalAdapter({ socketPath: "C:\\signal\\socket", account: ACCOUNT });
    await expect(adapter.start()).rejects.toMatchObject({ code: "forbidden" });
    expect((await adapter.health()).detail).toMatch(/--tcp 127\.0\.0\.1:7583/);
  });
});

describe("Signal JSON-RPC client", () => {
  async function client(d: FixtureDaemon, timeoutMs = 15_000) {
    const tcp = parseSignalTcpAddress(d.path);
    const c = new SignalRpcClient({
      socketPath: d.path,
      ...(WINDOWS && tcp !== undefined ? { tcp } : {}),
      timeoutMs,
      onNotification: () => undefined,
      onClose: () => undefined,
    });
    await c.connect();
    await d.waitForConnections(1);
    return c;
  }

  it("never writes account-changing methods", async () => {
    const d = await daemon();
    const c = await client(d);
    for (const method of [
      "register",
      "verify",
      "link",
      "addDevice",
      "removeDevice",
      "updateAccount",
      "setPin",
      "deleteLocalAccountData",
    ]) {
      expect(SIGNAL_REFUSED_METHODS.has(method)).toBe(true);
      await expect(c.request(method, { number: ACCOUNT })).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    await expect(c.request("updateProfile", {})).rejects.toMatchObject({ code: "forbidden" });
    await ticks();
    expect(d.lines).toEqual([]);
    c.close();
  });

  it("times out a request the daemon never answers", async () => {
    const d = await daemon();
    d.handlers.set("send", "hang");
    const c = await client(d, 30);
    await expect(c.request("send", { recipient: [OWNER], message: "hi" })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(d.requests.map((r) => r.method)).toEqual(["send"]);
    c.close();
  });

  it("surfaces JSON-RPC errors and correlates responses by id", async () => {
    const d = await daemon();
    d.handlers.set("send", (p) => {
      if (p.message === "bad") throw new Error("never");
      return { timestamp: 7 };
    });
    d.handlers.delete("sendTyping");
    const c = await client(d);
    const [a, b] = await Promise.allSettled([
      c.request("send", { recipient: [OWNER], message: "ok" }),
      c.request("sendTyping", { recipient: [OWNER] }),
    ]);
    expect(a).toEqual({ status: "fulfilled", value: { timestamp: 7 } });
    expect(b).toMatchObject({ status: "rejected", reason: { code: "unavailable" } });
    expect(String((b as PromiseRejectedResult).reason.message)).toContain("Method not implemented");
    c.close();
  });
});

describe("Signal attachments", () => {
  it("fetches by id through getAttachment and enforces the size cap", async () => {
    h = await harness({ adapter: { maxAttachmentBytes: 1000 } });
    const small = Buffer.alloc(600, 7);
    const big = Buffer.alloc(1001, 7);
    h.daemon.handlers.set("getAttachment", (p) => ({
      data: (p.id === "big.bin" ? big : small).toString("base64"),
    }));
    const bytes = await h.adapter.fetchAttachment("small.bin");
    expect(bytes.byteLength).toBe(600);
    expect(h.daemon.requests.at(-1)).toMatchObject({
      method: "getAttachment",
      params: { id: "small.bin" },
    });
    await expect(h.adapter.fetchAttachment("big.bin")).rejects.toMatchObject({
      code: "invalid_params",
      message: "attachment too large",
    });
    await expect(h.adapter.fetchAttachment("../../etc/passwd")).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("the default cap is 25 MB; capabilities are text-only with reactions", () => {
    expect(SIGNAL_MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(new SignalAdapter({ socketPath: "/x", account: ACCOUNT }).capabilities()).toMatchObject({
      maxMessageChars: 2000,
      markdown: false,
      typing: true,
      reactions: true,
      buttons: false,
    });
    expect(() => new SignalAdapter({ socketPath: "/x", account: "psyche" })).toThrow(/E\.164/);
  });
});

describe("Signal outbound", () => {
  it("sends to a DM, a uuid peer or a group and returns the timestamp as the message id", async () => {
    h = await harness();
    const dm = await h.adapter.send({ chatId: OWNER, text: "hi" });
    expect(dm.messageId).toBe(String(h.daemon.lastSentTimestamp));
    await h.adapter.send({ chatId: "uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", text: "hey" });
    await h.adapter.send({ chatId: "group:Z3JvdXAtaWQtMDEyMzQ1Njc=", text: "all" });
    expect(h.daemon.sent().map((r) => r.params)).toEqual([
      { recipient: [OWNER], message: "hi" },
      { recipient: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], message: "hey" },
      { groupId: "Z3JvdXAtaWQtMDEyMzQ1Njc=", message: "all" },
    ]);
    await expect(h.adapter.send({ chatId: OWNER, text: "x".repeat(2001) })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(h.adapter.send({ chatId: "nobody", text: "x" })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("chunks long replies through the service to 2000 characters", async () => {
    h = await harness();
    await h.service.send({ channelId: h.channel.id, chatId: OWNER }, "word ".repeat(700), {
      format: "plain",
    });
    const texts = h.daemon.sentTexts();
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((t) => t.length <= 2000)).toBe(true);
  });
});
