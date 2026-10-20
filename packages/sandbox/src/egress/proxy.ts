import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP, connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import type {
  DecisionContext,
  PermissionBroker,
  SandboxScope,
  Surface,
  TaintSource,
} from "@psyche/protocol";
import {
  type AllowEntry,
  canonicalHost,
  classifyAddress,
  matchAllowlist,
  originOf,
  parseAllowlist,
  parseSni,
} from "./policy.ts";

/**
 * Host-side egress proxy for sandboxes in `network: "proxy"` (feature K4; security §5.2).
 * Deny by default: a scope reaches only hosts on its allowlist, through HTTP CONNECT (TLS only,
 * the ClientHello's server name must be the CONNECT host) or absolute-form `http://` requests.
 * The proxy resolves DNS itself and connects to the address it checked, so a name that
 * resolves to loopback, link-local, metadata or (unless the entry says `private`) a LAN address
 * is refused, and DNS rebinding cannot swap the address afterwards. No TLS interception.
 *
 * Each origin a scope uses for the first time goes through the Permission Broker as a
 * `new_origin` read: in a tainted task the broker asks (security §3.6), and the card names the
 * taint sources. Every first decision per origin gets a receipt; every connection is logged
 * with host and byte counts. Blocked requests get 403 with `X-Proxy-Error`.
 */

export interface EgressLogEntry {
  scope: SandboxScope;
  host: string;
  port: number;
  origin: string;
  /** The address the proxy connected to, when it got that far. */
  address?: string;
  decision: "allowed" | "blocked";
  /** `X-Proxy-Error` code for blocked requests, or why a tunnel was closed. */
  reason?: string;
  bytesUp: number;
  bytesDown: number;
  durationMs: number;
}

export interface EgressProxyOptions {
  /** Asked once per new origin per scope. Without it only the allowlist applies. */
  broker?: PermissionBroker;
  /**
   * The decision context of the task or thread a sandbox scope belongs to (taint, run, thread,
   * permission mode). When the broker is set and this returns nothing, the scope is treated as
   * tainted, so a new origin asks.
   */
  context?: (
    scope: SandboxScope,
  ) => Promise<DecisionContext | undefined> | DecisionContext | undefined;
  /** Approval surfaces; default `["desktop"]`. */
  surfaces?: Surface[];
  /**
   * How long a connection waits for an approval before it is answered `approval-pending`. The
   * approval stays open; once answered, the next attempt gets the result. Default 20 s.
   */
  approvalWaitMs?: number;
  /** How long an open approval is followed in the background. Default 15 min. */
  approvalTtlMs?: number;
  /** DNS. Default: the OS resolver (`dns.lookup`, all addresses). */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Opens the upstream connection to a checked address. Default `net.connect`. */
  connect?: (address: string, port: number) => Duplex;
  onLog?: (entry: EgressLogEntry) => void;
  /** Request head and ClientHello must arrive within this. Default 10 s. */
  headTimeoutMs?: number;
  /** Upstream TCP connect timeout. Default 15 s. */
  connectTimeoutMs?: number;
  /**
   * How long an origin's decision is reused before the broker is asked again (#283, TM-16):
   * a `once` approval covers one burst of connections, and a revoked grant stops applying
   * after this. Default 60 s.
   */
  verdictTtlMs?: number;
  /** Clock for the TTL (tests). */
  now?: () => number;
}

type Verdict = { ok: true; approvalId?: string } | { ok: false; code: string; message: string };

interface CachedVerdict {
  verdict: Promise<Verdict>;
  /** When it settled (`now()`); undefined while the decision or its card is pending. */
  settledAt?: number;
}

interface ScopeState {
  scope: SandboxScope;
  entries: AllowEntry[];
  /** The current decision per allowlisted origin, shared by concurrent connections. */
  origins: Map<string, CachedVerdict>;
  /** Origins refused as not allowlisted, receipted once (never a cached decision: #283 TM-19). */
  unlisted: Set<string>;
}

const MAX_HEAD_BYTES = 16 * 1024;
const MAX_HELLO_BYTES = 16 * 1024 + 5;

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  502: "Bad Gateway",
  504: "Gateway Timeout",
};

const scopeKey = (scope: SandboxScope) => `${scope.kind}:${scope.id}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class EgressProxy {
  readonly #o: EgressProxyOptions;
  readonly #scopes = new Map<string, ScopeState>();

  constructor(options: EgressProxyOptions = {}) {
    this.#o = options;
  }

  /**
   * Replaces a scope's allowlist (the task's declared hosts, or an MCP server's
   * `allowedDomains`). Entries: `pypi.org`, `*.githubusercontent.com`, `host:8443`,
   * `mirror.lan private`. Decisions already made for origins still on the list are kept until
   * they expire; an origin that was refused as not allowlisted goes to the broker once listed.
   */
  setAllowlist(scope: SandboxScope, entries: readonly (string | Partial<AllowEntry>)[]): void {
    const key = scopeKey(scope);
    const parsed = parseAllowlist(entries);
    const prev = this.#scopes.get(key);
    const origins = new Map<string, CachedVerdict>();
    for (const [origin, cached] of prev?.origins ?? []) {
      const u = new URL(origin);
      const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (matchAllowlist(parsed, host, port) !== undefined) origins.set(origin, cached);
    }
    this.#scopes.set(key, { scope: { ...scope }, entries: parsed, origins, unlisted: new Set() });
  }

  /** The scope's allowlist as parsed. */
  allowlist(scope: SandboxScope): AllowEntry[] {
    return structuredClone(this.#scopes.get(scopeKey(scope))?.entries ?? []);
  }

  /** Forgets a scope (its sandbox was deleted): allowlist and origin decisions. */
  clear(scope: SandboxScope): void {
    this.#scopes.delete(scopeKey(scope));
  }

  /** Serves one client connection from a sandbox of `scope` (a tunnel stream or a socket). */
  handle(scope: SandboxScope, client: Duplex): void {
    void this.#serve(scope, client).catch(() => client.destroy());
  }

  async #serve(scope: SandboxScope, client: Duplex): Promise<void> {
    const started = Date.now();
    const reader = new Prefetch(client, this.#o.headTimeoutMs ?? 10_000);
    const headEnd = await reader.until((b) => b.indexOf("\r\n\r\n"), MAX_HEAD_BYTES);
    if (headEnd < 0) {
      reject(client, 400, "invalid-request", "request head too large, incomplete or too slow");
      return;
    }
    const head = reader.take(headEnd + 4).toString("latin1");
    const [requestLine = "", ...headerLines] = head.slice(0, -4).split("\r\n");
    const [method = "", target = ""] = requestLine.split(" ");

    let host: string | undefined;
    let port: number;
    let tunnel = false;
    let forwardHead: string | undefined;
    /** Plain HTTP: the one request's body length; nothing after it is forwarded (#282). */
    let bodyLength = 0;
    if (method === "CONNECT") {
      const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
      host = m?.[1] === undefined ? undefined : canonicalHost(m[1]);
      port = Number(m?.[2] ?? 0);
      tunnel = true;
    } else if (/^http:\/\//i.test(target)) {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        reject(client, 400, "invalid-request", "invalid request URL");
        return;
      }
      host = canonicalHost(u.hostname);
      port = u.port === "" ? 80 : Number(u.port);
      const prepared = prepareHttp(method, u, headerLines);
      if ("error" in prepared) {
        reject(client, 400, "invalid-request", prepared.error);
        return;
      }
      forwardHead = prepared.head;
      bodyLength = prepared.bodyLength;
    } else {
      reject(
        client,
        400,
        "invalid-request",
        "this proxy accepts CONNECT host:port and absolute http:// requests only",
      );
      return;
    }
    if (host === undefined || !(port > 0 && port < 65_536)) {
      reject(client, 400, "invalid-request", "invalid host or port");
      return;
    }

    const origin = originOf(host, port, tunnel);
    const log = (entry: Partial<EgressLogEntry> & Pick<EgressLogEntry, "decision">) =>
      this.#log({
        scope,
        host: host as string,
        port,
        origin,
        bytesUp: 0,
        bytesDown: 0,
        durationMs: Date.now() - started,
        ...entry,
      });
    const blocked = (status: number, code: string, message: string) => {
      reject(client, status, code, message);
      log({ decision: "blocked", reason: code });
    };

    const state = this.#scopes.get(scopeKey(scope));
    const entry = state === undefined ? undefined : matchAllowlist(state.entries, host, port);
    if (state === undefined || entry === undefined) {
      blocked(403, "blocked-by-allowlist", `${origin} is not on this sandbox's egress allowlist`);
      // Disallowed hosts are logged and, once per origin, receipted (K4 "blocked and logged").
      if (state !== undefined && !state.unlisted.has(origin)) {
        state.unlisted.add(origin);
        void this.#receipt(scope, origin, {
          ok: false,
          code: "blocked-by-allowlist",
          message: "not allowlisted",
        });
      }
      return;
    }

    const verdict = await this.#verdict(state, origin);
    if (!verdict.ok) {
      blocked(403, verdict.code, verdict.message);
      return;
    }

    // Resolve here, check every address, and connect to the checked one (no rebinding).
    let addresses: { address: string; family: number }[];
    try {
      addresses =
        isIP(host) !== 0
          ? [{ address: host, family: isIP(host) }]
          : await (this.#o.resolve ?? ((h) => lookup(h, { all: true, verbatim: true })))(host);
    } catch {
      blocked(502, "dns-failure", `could not resolve ${host}`);
      return;
    }
    const classes = addresses.map((a) => classifyAddress(a.address));
    if (addresses.length === 0 || classes.includes("blocked")) {
      blocked(
        403,
        "blocked-address",
        `${host} resolves to a loopback, link-local or reserved address`,
      );
      return;
    }
    if (classes.includes("private") && !entry.allowPrivate) {
      blocked(
        403,
        "blocked-address",
        `${host} resolves to a private address; allowlist it with "private"`,
      );
      return;
    }
    const address = (addresses[0] as { address: string }).address;

    let upstream: Duplex;
    try {
      upstream = await this.#connect(address, port);
    } catch {
      blocked(502, "upstream-unreachable", `could not connect to ${origin}`);
      return;
    }

    let bytesUp = 0;
    let bytesDown = 0;
    let reason: string | undefined;
    if (tunnel) {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const helloEnd = await reader.until((b) => {
        const sni = parseSni(b);
        return sni === undefined ? -1 : b.length;
      }, MAX_HELLO_BYTES);
      const sni = parseSni(reader.peek());
      if (helloEnd < 0 || sni === undefined || sni === null || sni !== host) {
        // Only TLS to the allowlisted name: no plaintext tunnels, no fronting.
        reason = sni === null || sni === undefined ? "no-sni" : "sni-mismatch";
        upstream.destroy();
        client.destroy();
        log({ decision: "blocked", reason, address });
        return;
      }
    } else {
      upstream.write(forwardHead as string);
    }
    const rest = reader.release();
    // A tunnel carries the client's TLS stream as is. Plain HTTP forwards exactly one request:
    // its head and `Content-Length` body bytes; anything after that (a pipelined request for
    // another virtual host) is dropped (#282).
    let remaining = tunnel ? Number.POSITIVE_INFINITY : bodyLength;
    const forward = (d: Buffer) => {
      if (remaining <= 0) return;
      const part = tunnel ? d : d.subarray(0, remaining);
      remaining -= part.length;
      bytesUp += part.length;
      if (part.length > 0) upstream.write(part);
    };
    forward(rest);
    upstream.on("data", (d: Buffer) => {
      bytesDown += d.length;
    });
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstream.destroy();
      log({ decision: "allowed", address, bytesUp, bytesDown, ...(reason ? { reason } : {}) });
    };
    client.on("error", done);
    upstream.on("error", done);
    client.on("close", done);
    upstream.on("close", done);
    if (tunnel) {
      client.on("data", (d: Buffer) => {
        bytesUp += d.length;
      });
      client.pipe(upstream);
    } else {
      client.on("data", forward);
    }
    upstream.pipe(client);
    client.resume();
  }

  /**
   * The decision for an origin in a scope. One decision (and at most one approval card) per
   * origin: concurrent and retried connections share it. A connection waits up to
   * `approvalWaitMs` for an open card, then gets `approval-pending`; the card's answer becomes
   * the origin's decision for the next attempt.
   */
  async #verdict(state: ScopeState, origin: string): Promise<Verdict> {
    const now = this.#o.now ?? Date.now;
    const ttl = this.#o.verdictTtlMs ?? 60_000;
    let cached = state.origins.get(origin);
    if (cached?.settledAt !== undefined && now() - cached.settledAt >= ttl) cached = undefined;
    if (cached === undefined) {
      const entry: CachedVerdict = { verdict: this.#decide(state.scope, origin) };
      state.origins.set(origin, entry);
      void entry.verdict.then((v) => {
        entry.settledAt = now();
        return this.#receipt(state.scope, origin, v);
      });
      cached = entry;
    }
    const final = cached.verdict;
    const wait = this.#o.approvalWaitMs ?? 20_000;
    let timer: NodeJS.Timeout | undefined;
    const pending = new Promise<Verdict>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            code: "approval-pending",
            message: `waiting for the owner to approve ${origin}; retry once it is answered`,
          }),
        wait,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([final, pending]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Allowlisted origin, first use in this scope: the broker decides (and may ask). */
  async #decide(scope: SandboxScope, origin: string): Promise<Verdict> {
    const broker = this.#o.broker;
    if (broker === undefined) return { ok: true };
    const taskId = scope.kind === "task" ? scope.id : undefined;
    const ctx: DecisionContext = (await this.#o.context?.(scope)) ?? {
      threadId: `sandbox:${scopeKey(scope)}`,
      runId: `sandbox:${scopeKey(scope)}`,
      ...(taskId === undefined ? {} : { taskId }),
      permissionMode: "balanced",
      // Unknown context: assume untrusted content may be steering the sandbox.
      taint: true,
      taintSources: [{ sourceKind: "sandbox", origin: `sandbox:${scopeKey(scope)}` }],
    };
    const params = { url: origin, taskId: ctx.taskId ?? taskId ?? null };
    const target = { kind: "origin" as const, value: origin };
    try {
      const decision = await broker.decide(
        {
          tool: "sandbox.egress",
          sideEffect: "read",
          kind: "new_origin",
          targetKind: "origin",
          target,
          params,
          paramsHash: sha256(JSON.stringify(params)),
        },
        { ...ctx, newTarget: true },
      );
      if (decision.decision === "allow") return { ok: true };
      if (decision.decision === "deny") {
        return { ok: false, code: "denied-by-policy", message: decision.reason ?? decision.rule };
      }
      return await this.#ask(broker, ctx, origin, target, decision);
    } catch (err) {
      return {
        ok: false,
        code: "denied-by-policy",
        message: `the permission check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async #ask(
    broker: PermissionBroker,
    ctx: DecisionContext,
    origin: string,
    target: { kind: "origin"; value: string },
    decision: Awaited<ReturnType<PermissionBroker["decide"]>>,
  ): Promise<Verdict> {
    const sources: TaintSource[] = ctx.taintSources ?? [];
    const issued = await broker.requestApproval({
      context: ctx,
      kind: "new_origin",
      summary: `Let the sandbox connect to ${origin}`,
      details: {
        origin,
        via: "sandbox egress proxy",
        ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      },
      bindingHash:
        decision.bindingHash ??
        sha256(JSON.stringify({ kind: "new_origin", origin, task: ctx.taskId ?? null })),
      grantKey: decision.grantKey ?? `new_origin|${origin}`,
      requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
      sideEffect: "read",
      targetKind: "origin",
      target,
      surfaces: this.#o.surfaces ?? ["desktop"],
      ...(decision.scopesOffered === undefined ? {} : { scopesOffered: decision.scopesOffered }),
      taint: ctx.taint,
      ...(sources.length === 0 ? {} : { taintSources: sources }),
    });
    const id = issued.approval.id;
    try {
      const a = await broker.awaitDecision(
        id,
        AbortSignal.timeout(this.#o.approvalTtlMs ?? 15 * 60_000),
      );
      return a.status === "approved"
        ? { ok: true, approvalId: id }
        : {
            ok: false,
            code: "approval-denied",
            message: `the owner did not approve ${origin} (${a.status})`,
          };
    } catch {
      return { ok: false, code: "approval-denied", message: `no answer for ${origin}` };
    }
  }

  async #receipt(scope: SandboxScope, origin: string, v: Verdict): Promise<void> {
    const broker = this.#o.broker;
    if (broker === undefined) return;
    try {
      await broker.recordReceipt({
        kind: "sandbox.egress",
        outcome: v.ok ? "ok" : "failed",
        summary: v.ok
          ? `Sandbox egress to ${origin} allowed`
          : `Sandbox egress to ${origin} blocked (${v.code})`,
        taskId: scope.kind === "task" ? scope.id : null,
        approvalId: v.ok ? (v.approvalId ?? null) : null,
        externalRefs: { origin, scope: scopeKey(scope) },
      });
    } catch {
      // The audit log's problem; the decision stands.
    }
  }

  #connect(address: string, port: number): Promise<Duplex> {
    const open =
      this.#o.connect ?? ((a: string, p: number) => netConnect({ host: a, port: p }) as Duplex);
    const socket = open(address, port);
    const ms = this.#o.connectTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        socket.destroy();
        reject(new Error("timeout"));
      }, ms);
      t.unref?.();
      const fail = (err: Error) => {
        clearTimeout(t);
        reject(err);
      };
      socket.once("error", fail);
      const ready = () => {
        clearTimeout(t);
        socket.off("error", fail);
        resolve(socket);
      };
      // net.Socket emits `connect`; an injected stream may already be usable.
      if ("connecting" in socket && (socket as { connecting?: boolean }).connecting === true) {
        socket.once("connect", ready);
      } else {
        ready();
      }
    });
  }

  #log(entry: EgressLogEntry): void {
    try {
      this.#o.onLog?.(entry);
    } catch {
      // ignore
    }
  }
}

function reject(client: Duplex, status: number, code: string, message: string): void {
  const body = `${message}\n`;
  client.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nX-Proxy-Error: ${code}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n${body}`,
  );
}

/**
 * Absolute-form request → origin-form for the upstream, one request per connection (#282).
 * `Host` is always the request URL's host: a client-supplied `Host` could otherwise name another
 * virtual host on the allowlisted address (a shared CDN). Bodies need one valid
 * `Content-Length`; `Transfer-Encoding`, conflicting lengths and folded headers are refused.
 */
function prepareHttp(
  method: string,
  u: URL,
  headerLines: string[],
): { head: string; bodyLength: number } | { error: string } {
  if (!/^[A-Z]+$/.test(method)) return { error: "invalid method" };
  const drop = /^(host|proxy-connection|proxy-authorization|connection|keep-alive|te|upgrade):/i;
  const headers: string[] = [];
  let length: number | undefined;
  for (const line of headerLines) {
    if (line === "") continue;
    if (/^[ \t]/.test(line)) return { error: "folded header lines are not accepted" };
    const colon = line.indexOf(":");
    if (colon <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, colon))) {
      return { error: "malformed header line" };
    }
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "transfer-encoding") {
      return { error: "Transfer-Encoding request bodies are not accepted; send Content-Length" };
    }
    if (name === "content-length") {
      if (!/^\d{1,15}$/.test(value)) return { error: "invalid Content-Length" };
      const n = Number(value);
      if (length !== undefined && length !== n) return { error: "conflicting Content-Length" };
      length = n;
    }
    if (drop.test(line)) continue;
    headers.push(line);
  }
  headers.unshift(`Host: ${u.host}`);
  headers.push("Connection: close");
  return {
    head: `${method} ${u.pathname}${u.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`,
    bodyLength: length ?? 0,
  };
}

/** Reads ahead from a stream without losing bytes, then hands the rest over. */
class Prefetch {
  #buf = Buffer.alloc(0);
  #ended = false;
  #wake: (() => void) | undefined;
  readonly #stream: Duplex;
  readonly #timeoutMs: number;
  readonly #onData = (d: Buffer) => {
    this.#buf = Buffer.concat([this.#buf, d]);
    this.#wake?.();
  };
  readonly #onEnd = () => {
    this.#ended = true;
    this.#wake?.();
  };

  constructor(stream: Duplex, timeoutMs: number) {
    this.#stream = stream;
    this.#timeoutMs = timeoutMs;
    stream.on("data", this.#onData);
    stream.on("end", this.#onEnd);
    stream.on("close", this.#onEnd);
    stream.on("error", this.#onEnd);
  }

  /** Waits until `find` returns ≥ 0 (or the cap, end or timeout: then -1). */
  async until(find: (buf: Buffer) => number, max: number): Promise<number> {
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const at = find(this.#buf);
      if (at >= 0) return at;
      if (this.#ended || this.#buf.length > max || Date.now() >= deadline) return -1;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        this.#wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.#wake = undefined;
    }
  }

  peek(): Buffer {
    return this.#buf;
  }

  take(n: number): Buffer {
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }

  /** Stops buffering; returns what was read ahead. The stream is paused until piped. */
  release(): Buffer {
    this.#stream.pause();
    this.#stream.off("data", this.#onData);
    this.#stream.off("end", this.#onEnd);
    this.#stream.off("close", this.#onEnd);
    this.#stream.off("error", this.#onEnd);
    const rest = this.#buf;
    this.#buf = Buffer.alloc(0);
    return rest;
  }
}
