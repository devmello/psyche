import { lstat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PsycheError } from "@psyche/protocol";
import type { SignalTcpAddress } from "./tcp.ts";

/**
 * A minimal client for the owner's own signal-cli daemon (`signal-cli -a +NUMBER daemon --socket
 * <path>`, or `--tcp 127.0.0.1:<port>` on Windows, where Node cannot reach an AF_UNIX socket):
 * newline-delimited JSON-RPC 2.0, `node:net` only. Psyche connects to
 * a daemon the owner runs; it never registers, verifies or links a number, so those methods are
 * refused here before a byte is written, and only the handful of calls the adapter needs pass.
 */

/** Account-changing methods: never sent, whatever the caller asks. */
export const SIGNAL_REFUSED_METHODS: ReadonlySet<string> = new Set([
  "register",
  "verify",
  "link",
  "startLink",
  "finishLink",
  "addDevice",
  "removeDevice",
  "updateAccount",
  "setPin",
  "removePin",
  "unregister",
  "deleteLocalAccountData",
]);

/** Everything the adapter uses; any other method is refused too. */
export const SIGNAL_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "send",
  "sendTyping",
  "sendReaction",
  "getAttachment",
  "version",
]);

export const SIGNAL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Checks the socket before connecting (security §9: the daemon speaks as the owner's number, so a
 * socket someone else could have created or can write to could be anyone's). It must be a socket
 * owned by `uid`, not group- or world-writable, in a directory owned by `uid` (or root) that
 * others cannot write (a sticky directory such as `/tmp` is fine: others cannot replace our file).
 * Returns a fatal problem, `"missing"` when nothing is there yet (the daemon is not running), or
 * undefined when it is fine.
 */
export async function checkSignalSocket(path: string, uid: number): Promise<string | undefined> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return `cannot inspect the signal-cli socket at ${path}`;
  }
  if (!st.isSocket()) return `${path} is not a socket; point PSYCHE_SIGNAL_SOCKET at signal-cli's`;
  if (st.uid !== uid) {
    return `the signal-cli socket at ${path} belongs to another user (uid ${st.uid}); run the daemon as this user`;
  }
  if ((st.mode & 0o022) !== 0) {
    return `the signal-cli socket at ${path} is group- or world-writable; chmod it 0600 or 0700`;
  }
  const dir = dirname(path);
  let dst: Awaited<ReturnType<typeof lstat>>;
  try {
    dst = await lstat(dir);
  } catch {
    return `cannot inspect ${dir}`;
  }
  if (dst.uid !== uid && dst.uid !== 0) {
    return `the directory ${dir} belongs to another user; put the signal-cli socket in your own directory`;
  }
  const sticky = (dst.mode & 0o1000) !== 0;
  if ((dst.mode & 0o022) !== 0 && !sticky) {
    return `the directory ${dir} is group- or world-writable; another user could replace the signal-cli socket`;
  }
  return undefined;
}

export interface SignalRpcClientOptions {
  /** The socket path, or the daemon's address in messages when `tcp` is given. */
  socketPath: string;
  /** Connect over loopback TCP to this address instead of the socket path. */
  tcp?: SignalTcpAddress;
  /**
   * Runs on the open connection before anything is read or written; a returned problem closes it
   * and `connect` rejects with `forbidden`.
   */
  verifyPeer?: (socket: Socket) => Promise<string | undefined>;
  timeoutMs?: number;
  /** Longest line accepted from the daemon; a longer one drops the connection. */
  maxLineBytes?: number;
  onNotification: (method: string, params: unknown) => void;
  onClose: () => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export class SignalRpcClient {
  readonly #path: string;
  readonly #tcp: SignalTcpAddress | undefined;
  readonly #verifyPeer: SignalRpcClientOptions["verifyPeer"];
  readonly #timeoutMs: number;
  readonly #maxLine: number;
  readonly #onNotification: SignalRpcClientOptions["onNotification"];
  readonly #onClose: () => void;
  readonly #pending = new Map<number, PendingRequest>();
  #socket: Socket | undefined;
  #decoder = new StringDecoder("utf8");
  #buf = "";
  #nextId = 1;
  #closed = false;

  constructor(options: SignalRpcClientOptions) {
    this.#path = options.socketPath;
    this.#tcp = options.tcp;
    this.#verifyPeer = options.verifyPeer;
    this.#timeoutMs = options.timeoutMs ?? SIGNAL_REQUEST_TIMEOUT_MS;
    this.#maxLine = options.maxLineBytes ?? 48 * 1024 * 1024;
    this.#onNotification = options.onNotification;
    this.#onClose = options.onClose;
  }

  get connected(): boolean {
    return this.#socket !== undefined && !this.#closed;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tcp = this.#tcp;
      const socket =
        tcp === undefined
          ? createConnection({ path: this.#path })
          : createConnection({ host: tcp.host, port: tcp.port });
      let open = false;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      const unreachable = () =>
        new PsycheError("unavailable", `cannot reach signal-cli at ${this.#path}`, {
          retryable: true,
        });
      socket.once("connect", () => {
        const verify = this.#verifyPeer?.(socket) ?? Promise.resolve(undefined);
        verify.then(
          (problem) => {
            if (settled) return;
            if (problem !== undefined) {
              fail(new PsycheError("forbidden", problem));
              return;
            }
            settled = true;
            open = true;
            this.#socket = socket;
            // Attached only now: nothing from the daemon is read before the check passes.
            socket.on("data", (chunk: Buffer) => this.#onData(chunk));
            resolve();
          },
          () => fail(new PsycheError("forbidden", `cannot verify signal-cli at ${this.#path}`)),
        );
      });
      socket.on("error", () => {
        if (!open) fail(unreachable());
      });
      socket.on("close", () => {
        if (open) this.#teardown();
        else fail(unreachable());
      });
    });
  }

  /** One request; refused methods throw before anything is written. */
  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (SIGNAL_REFUSED_METHODS.has(method)) {
      return Promise.reject(
        new PsycheError(
          "forbidden",
          `Psyche never calls signal-cli ${method}: manage the account with signal-cli yourself`,
        ),
      );
    }
    if (!SIGNAL_ALLOWED_METHODS.has(method)) {
      return Promise.reject(new PsycheError("forbidden", `signal-cli ${method} is not used`));
    }
    const socket = this.#socket;
    if (socket === undefined || this.#closed) {
      return Promise.reject(
        new PsycheError("unavailable", `not connected to signal-cli at ${this.#path}`, {
          retryable: true,
        }),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // Not retryable: a send that timed out may still have gone out.
        reject(new PsycheError("timeout", `signal-cli ${method} timed out`));
      }, this.#timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error == null) return;
        const p = this.#pending.get(id);
        if (p === undefined) return;
        clearTimeout(p.timer);
        this.#pending.delete(id);
        reject(new PsycheError("unavailable", `signal-cli ${method} failed`, { retryable: true }));
      });
    });
  }

  close(): void {
    const socket = this.#socket;
    this.#teardown();
    socket?.destroy();
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket = undefined;
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(
        new PsycheError("unavailable", `signal-cli connection closed during ${p.method}`, {
          retryable: true,
        }),
      );
      this.#pending.delete(id);
    }
    this.#onClose();
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buf += this.#decoder.write(chunk);
    let nl = this.#buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.trim() !== "") this.#onLine(line);
      if (this.#closed) return;
      nl = this.#buf.indexOf("\n");
    }
    if (this.#buf.length > this.#maxLine) {
      // A runaway line: drop the connection rather than buffer without bound.
      this.close();
    }
  }

  #onLine(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object") return;
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const p = this.#pending.get(msg.id);
      if (p === undefined) return;
      clearTimeout(p.timer);
      this.#pending.delete(msg.id);
      if (msg.error != null) {
        const text = typeof msg.error.message === "string" ? msg.error.message : "error";
        p.reject(
          new PsycheError("unavailable", `signal-cli ${p.method}: ${text.slice(0, 200)}`, {
            details: { rpcCode: typeof msg.error.code === "number" ? msg.error.code : null },
          }),
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && msg.id === undefined) {
      try {
        this.#onNotification(msg.method, msg.params);
      } catch {
        // A handler bug never kills the connection.
      }
    }
  }
}
