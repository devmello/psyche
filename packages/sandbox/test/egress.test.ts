import { spawn } from "node:child_process";
import { connect, createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type {
  ApprovalRequest,
  DecisionContext,
  PermissionBroker,
  ReceiptInput,
} from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { classifyAddress, matchAllowlist, parseAllowlist, parseSni } from "../src/egress/policy.ts";
import { type EgressLogEntry, EgressProxy } from "../src/egress/proxy.ts";
import { attachTunnel } from "../src/egress/tunnel.ts";
import { EGRESS_SHIM } from "../src/scripts.ts";

const scope = { kind: "task" as const, id: "task_1" };
const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      closers.push(() => server.close());
      resolve((server.address() as { port: number }).port);
    }),
  );
}

/** An upstream "internet" server: records what arrives, answers `reply`. */
async function upstream(reply = "") {
  const got: Buffer[] = [];
  const server = createServer((s) => {
    s.on("data", (d) => {
      got.push(d);
      if (reply !== "") s.end(reply);
    });
    s.on("error", () => undefined);
  });
  const port = await listen(server);
  return { port, bytes: () => Buffer.concat(got) };
}

/** A proxy whose DNS is a table and whose connects all go to the local upstream. */
function proxyFor(
  upstreamPort: number,
  dns: Record<string, string[]>,
  extra: ConstructorParameters<typeof EgressProxy>[0] = {},
) {
  const logs: EgressLogEntry[] = [];
  const dialed: string[] = [];
  const proxy = new EgressProxy({
    resolve: async (h) => {
      const a = dns[h];
      if (a === undefined) throw new Error("ENOTFOUND");
      return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    connect: (address, port) => {
      dialed.push(`${address}:${port}`);
      return connect(upstreamPort, "127.0.0.1");
    },
    onLog: (e) => logs.push(e),
    approvalWaitMs: 200,
    ...extra,
  });
  return { proxy, logs, dialed };
}

/** Serves the proxy on a local port, as the shim's connections would arrive. */
async function front(proxy: EgressProxy): Promise<number> {
  const server = createServer((s) => proxy.handle(scope, s));
  return listen(server);
}

/** Sends a raw request through the proxy and returns everything it answered. */
function raw(port: number, request: string, after?: (s: Socket) => void): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => {
      s.write(request);
      after?.(s);
    });
    const chunks: Buffer[] = [];
    s.on("data", (d) => chunks.push(d));
    s.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    s.on("error", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
}

/** CONNECT, then a real TLS ClientHello for `servername` (the handshake itself fails: no cert). */
function connectTls(port: number, host: string, servername: string): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () =>
      s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`),
    );
    let head = "";
    const onData = (d: Buffer) => {
      head += d.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      s.off("data", onData);
      if (!head.startsWith("HTTP/1.1 200")) {
        resolve(head);
        s.destroy();
        return;
      }
      const t = tlsConnect({ socket: s, servername, rejectUnauthorized: false });
      t.on("error", () => resolve(head));
      t.on("close", () => resolve(head));
      // The stand-in upstream never answers the handshake: stop once the hello is out.
      setTimeout(() => {
        t.destroy();
        resolve(head);
      }, 150);
    };
    s.on("data", onData);
    s.on("error", () => resolve(head));
  });
}

interface FakeBrokerState {
  decide: Array<{ ctx: DecisionContext; target?: string }>;
  approvals: ApprovalRequest[];
  receipts: ReceiptInput[];
  answer?: (id: string) => Promise<"approved" | "denied">;
}

/** Only the four broker methods the proxy calls. Tainted new origins ask, as the real engine. */
function fakeBroker(state: FakeBrokerState): PermissionBroker {
  const broker: Pick<
    PermissionBroker,
    "decide" | "requestApproval" | "awaitDecision" | "recordReceipt"
  > = {
    async decide(call, ctx) {
      state.decide.push({ ctx, ...(call.target ? { target: call.target.value } : {}) });
      return ctx.taint
        ? { decision: "ask", rule: "taint:new_origin", approvalKind: "new_origin" }
        : { decision: "allow", rule: "mode:balanced/read" };
    },
    async requestApproval(input) {
      const approval = {
        id: `apr_${state.approvals.length + 1}`,
        kind: input.kind,
        summary: input.summary,
        details: input.details,
        status: "pending",
        taint: input.taint,
      } as unknown as ApprovalRequest;
      state.approvals.push(approval);
      return { approval, answerTokens: {} };
    },
    async awaitDecision(id) {
      const status = (await state.answer?.(id)) ?? "denied";
      return { id, status } as unknown as ApprovalRequest;
    },
    async recordReceipt(input) {
      state.receipts.push(input);
      return {} as never;
    },
  };
  return broker as PermissionBroker;
}

describe("egress policy (K4)", () => {
  it("classifies addresses: never the host, link-local or metadata; LAN only when allowed", () => {
    for (const a of [
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "169.254.169.254",
      "::1",
      "::",
      "fe80::1",
      "fd00:ec2::254",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a9fe:a9fe",
      "224.0.0.1",
      "255.255.255.255",
      "not-an-ip",
    ]) {
      expect(classifyAddress(a), a).toBe("blocked");
    }
    for (const a of [
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "100.100.1.1",
      "fd12::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(classifyAddress(a), a).toBe("private");
    }
    for (const a of ["151.101.0.223", "2606:4700::1", "172.32.0.1"]) {
      expect(classifyAddress(a), a).toBe("public");
    }
  });

  it("parses and matches allowlists; wildcards never cover the apex, a TLD or everything", () => {
    const list = parseAllowlist([
      "pypi.org",
      "*.githubusercontent.com",
      "https://files.pythonhosted.org/packages",
      "registry.example.com:8443",
      "mirror.lan private",
      "*",
      "*.com",
      "bad host",
      "BÜCHER.example",
    ]);
    expect(list.map((e) => e.host)).toEqual([
      "pypi.org",
      "*.githubusercontent.com",
      "files.pythonhosted.org",
      "registry.example.com",
      "mirror.lan",
      "xn--bcher-kva.example",
    ]);
    expect(matchAllowlist(list, "pypi.org", 443)?.host).toBe("pypi.org");
    expect(matchAllowlist(list, "pypi.org", 22)).toBeUndefined();
    expect(matchAllowlist(list, "raw.githubusercontent.com", 443)?.host).toBe(
      "*.githubusercontent.com",
    );
    expect(matchAllowlist(list, "githubusercontent.com", 443)).toBeUndefined();
    expect(matchAllowlist(list, "evilgithubusercontent.com", 443)).toBeUndefined();
    expect(matchAllowlist(list, "registry.example.com", 443)).toBeUndefined();
    expect(matchAllowlist(list, "registry.example.com", 8443)?.ports).toEqual([8443]);
    expect(matchAllowlist(list, "mirror.lan", 80)?.allowPrivate).toBe(true);
  });
});

describe("egress proxy (K4)", () => {
  it("blocks a host that is not allowlisted with 403 and X-Proxy-Error, logs and receipts it once", async () => {
    const up = await upstream();
    const state: FakeBrokerState = { decide: [], approvals: [], receipts: [] };
    const { proxy, logs, dialed } = proxyFor(
      up.port,
      { "evil.test": ["151.101.0.1"] },
      {
        broker: fakeBroker(state),
      },
    );
    proxy.setAllowlist(scope, ["pypi.org"]);
    const port = await front(proxy);
    const r1 = await raw(port, "CONNECT evil.test:443 HTTP/1.1\r\n\r\n");
    await raw(port, "CONNECT evil.test:443 HTTP/1.1\r\n\r\n");
    expect(r1).toMatch(/^HTTP\/1\.1 403 /);
    expect(r1).toContain("X-Proxy-Error: blocked-by-allowlist");
    expect(dialed).toEqual([]);
    expect(state.decide).toEqual([]);
    expect(logs.map((l) => [l.origin, l.decision, l.reason])).toEqual([
      ["https://evil.test", "blocked", "blocked-by-allowlist"],
      ["https://evil.test", "blocked", "blocked-by-allowlist"],
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(state.receipts.map((r) => [r.kind, r.outcome, r.taskId])).toEqual([
      ["sandbox.egress", "failed", "task_1"],
    ]);
  });

  it("tunnels TLS to an allowlisted host at the address it resolved and checked", async () => {
    const up = await upstream();
    const state: FakeBrokerState = { decide: [], approvals: [], receipts: [] };
    const { proxy, logs, dialed } = proxyFor(
      up.port,
      { "pypi.org": ["151.101.0.223"] },
      {
        broker: fakeBroker(state),
        context: () => ({
          threadId: "thr",
          runId: "run",
          taskId: "task_1",
          permissionMode: "balanced",
          taint: false,
        }),
      },
    );
    proxy.setAllowlist(scope, ["pypi.org"]);
    const port = await front(proxy);
    const head = await connectTls(port, "pypi.org", "pypi.org");
    expect(head).toMatch(/^HTTP\/1\.1 200 /);
    expect(dialed).toEqual(["151.101.0.223:443"]);
    expect(parseSni(up.bytes())).toBe("pypi.org");
    await new Promise((r) => setTimeout(r, 20));
    expect(state.decide.map((d) => d.target)).toEqual(["https://pypi.org"]);
    expect(state.approvals).toEqual([]);
    expect(state.receipts.map((r) => r.outcome)).toEqual(["ok"]);
    const allowed = logs.find((l) => l.decision === "allowed");
    expect(allowed?.address).toBe("151.101.0.223");
    expect(allowed?.bytesUp).toBeGreaterThan(0);
  });

  it("refuses names that resolve to loopback, metadata or (without `private`) the LAN", async () => {
    const up = await upstream();
    const { proxy, dialed } = proxyFor(up.port, {
      "rebind.test": ["151.101.0.1", "127.0.0.1"],
      "meta.test": ["169.254.169.254"],
      "lan.test": ["192.168.1.20"],
      "mirror.lan": ["192.168.1.21"],
    });
    proxy.setAllowlist(scope, ["rebind.test", "meta.test", "lan.test", "mirror.lan private"]);
    const port = await front(proxy);
    for (const host of ["rebind.test", "meta.test", "lan.test"]) {
      const r = await raw(port, `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
      expect(r, host).toContain("X-Proxy-Error: blocked-address");
    }
    // An IP literal is checked the same way, even when allowlisted.
    proxy.setAllowlist(scope, ["127.0.0.1", "mirror.lan private"]);
    expect(await raw(port, "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n")).toContain("blocked-address");
    expect(dialed).toEqual([]);
    expect(await connectTls(port, "mirror.lan", "mirror.lan")).toMatch(/^HTTP\/1\.1 200 /);
    expect(dialed).toEqual(["192.168.1.21:443"]);
  });

  it("closes a tunnel whose ClientHello names another host, or that is not TLS", async () => {
    const up = await upstream();
    const { proxy, logs } = proxyFor(up.port, { "pypi.org": ["151.101.0.223"] });
    proxy.setAllowlist(scope, ["pypi.org"]);
    const port = await front(proxy);
    await connectTls(port, "pypi.org", "evil.test");
    await raw(port, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n", (s) =>
      setTimeout(() => s.write("SSH-2.0-OpenSSH\r\n".padEnd(64, "x")), 20),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(logs.map((l) => l.reason)).toEqual(["sni-mismatch", "no-sni"]);
    expect(up.bytes().length).toBe(0);
  });

  it("forwards absolute-form http:// as origin-form, without proxy headers", async () => {
    const up = await upstream("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const { proxy } = proxyFor(up.port, { "deb.example.org": ["151.101.0.9"] });
    proxy.setAllowlist(scope, ["deb.example.org"]);
    const port = await front(proxy);
    const r = await raw(
      port,
      "GET http://deb.example.org/dists/stable/Release?x=1 HTTP/1.1\r\nHost: deb.example.org\r\nProxy-Authorization: Basic eA==\r\nProxy-Connection: keep-alive\r\n\r\n",
    );
    expect(r).toContain("200 OK");
    const sent = up.bytes().toString("latin1");
    expect(sent.startsWith("GET /dists/stable/Release?x=1 HTTP/1.1\r\n")).toBe(true);
    expect(sent).not.toMatch(/proxy-/i);
    expect(sent).toContain("Connection: close");
    expect(await raw(port, "GET https://deb.example.org/ HTTP/1.1\r\n\r\n")).toContain(
      "invalid-request",
    );
  });

  it("asks once per new origin in a tainted task, and the answer decides every connection", async () => {
    const up = await upstream();
    let approve: (v: "approved" | "denied") => void = () => undefined;
    const state: FakeBrokerState = {
      decide: [],
      approvals: [],
      receipts: [],
      answer: () => new Promise((r) => (approve = r)),
    };
    const sources = [{ sourceKind: "web.fetch", origin: "https://evil.test" }];
    const { proxy } = proxyFor(
      up.port,
      { "pypi.org": ["151.101.0.223"] },
      {
        broker: fakeBroker(state),
        context: () => ({
          threadId: "thr",
          runId: "run",
          taskId: "task_1",
          permissionMode: "balanced",
          taint: true,
          taintSources: sources,
        }),
      },
    );
    proxy.setAllowlist(scope, ["pypi.org"]);
    const port = await front(proxy);
    // Two connections while the card is open: one card, both told it is pending.
    const [a, b] = await Promise.all([
      raw(port, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n"),
      raw(port, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n"),
    ]);
    expect(a).toContain("X-Proxy-Error: approval-pending");
    expect(b).toContain("X-Proxy-Error: approval-pending");
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]).toMatchObject({ kind: "new_origin", taint: true });
    expect(state.decide[0]?.ctx).toMatchObject({
      taint: true,
      newTarget: true,
      taintSources: sources,
    });
    approve("approved");
    await new Promise((r) => setTimeout(r, 20));
    expect(await connectTls(port, "pypi.org", "pypi.org")).toMatch(/^HTTP\/1\.1 200 /);
    expect(state.approvals).toHaveLength(1);
    expect(state.receipts.map((r) => [r.outcome, r.approvalId])).toEqual([["ok", "apr_1"]]);
  });

  it("a denied card blocks the origin; an unknown context counts as tainted", async () => {
    const up = await upstream();
    const state: FakeBrokerState = {
      decide: [],
      approvals: [],
      receipts: [],
      answer: async () => "denied",
    };
    const { proxy } = proxyFor(
      up.port,
      { "pypi.org": ["151.101.0.223"] },
      { broker: fakeBroker(state) },
    );
    proxy.setAllowlist(scope, ["pypi.org"]);
    const port = await front(proxy);
    const r = await raw(port, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n");
    expect(r).toContain("X-Proxy-Error: approval-denied");
    expect(state.decide[0]?.ctx.taint).toBe(true);
    expect(await raw(port, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n")).toContain("approval-denied");
    expect(state.approvals).toHaveLength(1);
  });
});

describe("egress shim over stdio (K4)", () => {
  it("carries a CONNECT tunnel from the shim's loopback port to the proxy", async () => {
    const up = await upstream();
    const { proxy, dialed } = proxyFor(up.port, { "pypi.org": ["151.101.0.223"] });
    proxy.setAllowlist(scope, ["pypi.org"]);
    // The shim runs as it would in the container, here as a host process on an ephemeral port.
    const child = spawn("python3", ["-I", "-S", "-c", EGRESS_SHIM, "0"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    closers.push(() => child.kill("SIGKILL"));
    const tunnel = attachTunnel({ stdin: child.stdin, stdout: child.stdout }, (conn) =>
      proxy.handle(scope, conn),
    );
    const port = await tunnel.ready;
    const head = await connectTls(port, "pypi.org", "pypi.org");
    expect(head).toMatch(/^HTTP\/1\.1 200 /);
    expect(dialed).toEqual(["151.101.0.223:443"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(parseSni(up.bytes())).toBe("pypi.org");
    expect(await raw(port, "CONNECT evil.test:443 HTTP/1.1\r\n\r\n")).toContain(
      "blocked-by-allowlist",
    );
    tunnel.close();
    await new Promise<void>((r) => child.once("exit", () => r()));
  });
});

describe("egress hardening (#282, #283)", () => {
  it("#282: forces Host to the URL's host and forwards exactly one request", async () => {
    const up = await upstream("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const { proxy } = proxyFor(up.port, { "pypi.org": ["151.101.0.223"] });
    proxy.setAllowlist(scope, ["pypi.org"]);
    const port = await front(proxy);
    await raw(
      port,
      "GET http://pypi.org/x HTTP/1.1\r\nHost: attacker-tenant.example\r\n\r\n" +
        "GET http://pypi.org/y HTTP/1.1\r\nHost: attacker-tenant.example\r\n\r\n",
    );
    const sent = up.bytes().toString("latin1");
    expect(sent.match(/^GET /gm)).toHaveLength(1);
    expect(sent).toContain("\r\nHost: pypi.org\r\n");
    expect(sent).not.toContain("attacker-tenant");
  });

  it("#282: sends one Content-Length body and nothing after it; refuses smuggling shapes", async () => {
    const up = await upstream("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    const { proxy } = proxyFor(up.port, { "api.example.org": ["151.101.0.7"] });
    proxy.setAllowlist(scope, ["api.example.org"]);
    const port = await front(proxy);
    await raw(
      port,
      "POST http://api.example.org/p HTTP/1.1\r\nContent-Length: 5\r\n\r\nhelloGET /smuggled HTTP/1.1\r\n\r\n",
    );
    const sent = up.bytes().toString("latin1");
    expect(sent.endsWith("\r\n\r\nhello")).toBe(true);
    expect(sent).not.toContain("smuggled");
    for (const bad of [
      "POST http://api.example.org/p HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      "POST http://api.example.org/p HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!",
      "GET http://api.example.org/ HTTP/1.1\r\nX-A: 1\r\n folded: yes\r\n\r\n",
    ]) {
      expect(await raw(port, bad)).toMatch(/^HTTP\/1\.1 400 [\s\S]*invalid-request/);
    }
  });

  it("#283 TM-16: a decision expires, so a revoked grant (or a once approval) asks again", async () => {
    const up = await upstream();
    let clock = 0;
    let granted = true;
    const decided: string[] = [];
    const broker = {
      async decide() {
        decided.push(granted ? "allow" : "deny");
        return granted
          ? { decision: "allow" as const, rule: "grant:g1" }
          : { decision: "deny" as const, rule: "mode:manual" };
      },
      async recordReceipt() {
        return {} as never;
      },
    } as unknown as PermissionBroker;
    const { proxy } = proxyFor(
      up.port,
      { "pypi.org": ["151.101.0.223"] },
      {
        broker,
        context: () => ({
          threadId: "t",
          runId: "r",
          taskId: "task_1",
          permissionMode: "balanced",
          taint: false,
        }),
        verdictTtlMs: 1000,
        now: () => clock,
      },
    );
    proxy.setAllowlist(scope, ["pypi.org"]);
    const port = await front(proxy);
    expect(await connectTls(port, "pypi.org", "pypi.org")).toMatch(/^HTTP\/1\.1 200 /);
    granted = false; // the owner revokes the grant
    clock = 500;
    expect(await connectTls(port, "pypi.org", "pypi.org")).toMatch(/^HTTP\/1\.1 200 /);
    clock = 1500;
    expect(await raw(port, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n")).toContain("denied-by-policy");
    expect(decided).toEqual(["allow", "deny"]);
  });

  it("#283 TM-19: an origin refused as not allowlisted works once it is allowlisted", async () => {
    const up = await upstream();
    const { proxy } = proxyFor(up.port, { "files.example.org": ["151.101.0.8"] });
    proxy.setAllowlist(scope, ["pypi.org"]);
    const port = await front(proxy);
    expect(await raw(port, "CONNECT files.example.org:443 HTTP/1.1\r\n\r\n")).toContain(
      "blocked-by-allowlist",
    );
    proxy.setAllowlist(scope, ["pypi.org", "files.example.org"]);
    expect(await connectTls(port, "files.example.org", "files.example.org")).toMatch(
      /^HTTP\/1\.1 200 /,
    );
  });

  it("#283 TM-20: IPv6 forms that embed or translate IPv4 classify by what they reach", () => {
    for (const a of [
      "64:ff9b:1::a9fe:a9fe",
      "0064:ff9b:0000:0000:0000:0000:a9fe:a9fe",
      "::ffff:0:169.254.169.254",
      "::169.254.169.254",
      "::a9fe:a9fe",
      "0:0:0:0:0:0:0:1",
      "2002:7f00:1::1",
      "2001:0:4136:e378::1",
      "fe80::1%en0",
      "192.0.0.170",
      "192.0.2.10",
      "2001:db8::1",
    ]) {
      expect(classifyAddress(a), a).toBe("blocked");
    }
    expect(classifyAddress("2002:0a00:0001::")).toBe("private");
    expect(classifyAddress("::ffff:0:10.0.0.1")).toBe("private");
    expect(classifyAddress("64:ff9b::8.8.8.8")).toBe("public");
    expect(classifyAddress("2606:4700:0:0:0:0:0:1111")).toBe("public");
  });
});
