import { describeError, t } from "@psyche/ui";
import type { GatewayEvent } from "../client/connection.ts";
import type { GatewayPort, TerminalOpenResult, TerminalPort, Unsubscribe } from "./platform.ts";

/**
 * The terminal pane's port for a window that is a client of another computer's Gateway
 * (remote-gateway design §4.2, R4). The shell runs on the Host: this port only opens a
 * `terminal.session.*` session over the Gateway connection, sends keystrokes and sizes, and
 * hands the output to the pane. It never starts a process and never reads a program, folder or
 * environment out of what the Gateway answers; the pane renders bytes.
 *
 * Opening needs the owner's presence on the Host (a device-only approval card). The first call
 * fails `approval_required`; the port then waits for that card to be approved and opens again
 * with its id, and tells the pane it is waiting.
 *
 * Output is flow-controlled: after the pane has rendered a chunk the port confirms its `end`
 * (`terminal.session.ack`), which lets the Host read the PTY again. Keystrokes are batched for a
 * few milliseconds so typing and pastes cost few calls.
 */

export interface HostTerminalPortOptions {
  gateway: Pick<GatewayPort, "call" | "onEvent"> & Partial<Pick<GatewayPort, "onResync">>;
  /** The Host's name, for the messages the pane shows. */
  hostName: string | (() => string);
  /** How long to wait for the owner's approval of a new terminal. */
  approvalTimeoutMs?: number;
  /** Keystrokes are sent after this long (0: on the next tick). */
  writeBatchMs?: number;
}

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const WRITE_BATCH_MS = 4;
/** Under the Host's 64 KB per write, whatever the characters. */
const MAX_WRITE_CHARS = 16 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function codeOf(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

function detailsOf(err: unknown): Record<string, unknown> {
  return isRecord(err) && isRecord(err.details) ? err.details : {};
}

interface Writer {
  buffer: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function hostTerminalPort(opts: HostTerminalPortOptions): TerminalPort {
  const { gateway } = opts;
  const hostName = () => (typeof opts.hostName === "function" ? opts.hostName() : opts.hostName);
  /** Sessions this port opened and still has; a reconnect re-attaches them (see onResync). */
  const live = new Set<string>();
  /** Sessions that are over: nothing may be acked or written for them again. */
  const ended = new Set<string>();
  const batchMs = opts.writeBatchMs ?? WRITE_BATCH_MS;
  const dataListeners = new Set<(id: string, data: string) => void | Promise<void>>();
  const exitListeners = new Set<(id: string, exitCode: number) => void>();
  const writers = new Map<string, Writer>();
  const acks = new Map<string, { sending: boolean; latest: number }>();
  const approvalWaiters = new Set<(approvalId: string, status: string) => void>();
  let off: Unsubscribe | undefined;
  let offResync: Unsubscribe | undefined;

  const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);

  const sendAck = (sessionId: string, end: number) => {
    if (ended.has(sessionId)) return;
    let a = acks.get(sessionId);
    if (!a) {
      a = { sending: false, latest: 0 };
      acks.set(sessionId, a);
    }
    a.latest = Math.max(a.latest, end);
    if (a.sending) return;
    const flush = () => {
      const cur = acks.get(sessionId);
      if (!cur) return;
      const end = cur.latest;
      cur.sending = true;
      gateway.call("terminal.session.ack", { sessionId, end }).then(
        () => {
          cur.sending = false;
          if (cur.latest > end) flush();
        },
        () => {
          cur.sending = false;
        },
      );
    };
    flush();
  };

  const forget = (sessionId: string) => {
    const w = writers.get(sessionId);
    if (w?.timer !== undefined) clearTimeout(w.timer);
    writers.delete(sessionId);
    acks.delete(sessionId);
    live.delete(sessionId);
    ended.add(sessionId);
    if (ended.size > 256) {
      const oldest = ended.values().next().value;
      if (oldest !== undefined) ended.delete(oldest);
    }
  };

  const onEvent = (e: GatewayEvent) => {
    const p = e.payload;
    if (!isRecord(p)) return;
    if (e.event === "terminal.output") {
      if (typeof p.sessionId !== "string" || typeof p.data !== "string") return;
      const sessionId = p.sessionId;
      const end = typeof p.end === "number" ? p.end : undefined;
      const results: Array<void | Promise<void>> = [];
      for (const cb of dataListeners) results.push(cb(sessionId, p.data));
      if (end === undefined) return;
      // Acked only once rendered: a listener that dropped the data (a pane that is not showing
      // it) rejects, and the Host keeps waiting instead of flooding a sink that discards.
      Promise.all(results).then(
        () => sendAck(sessionId, end),
        () => undefined,
      );
    } else if (e.event === "terminal.exit") {
      if (typeof p.sessionId !== "string") return;
      const sessionId = p.sessionId;
      forget(sessionId);
      const code = typeof p.exitCode === "number" && p.reason === "exited" ? p.exitCode : -1;
      for (const cb of exitListeners) cb(sessionId, code);
    } else if (e.event === "approval.updated") {
      const approval = p.approval;
      if (isRecord(approval) && typeof approval.id === "string") {
        const status = typeof approval.status === "string" ? approval.status : "";
        for (const w of [...approvalWaiters]) w(approval.id, status);
      }
    }
  };

  const ensureListening = () => {
    off ??= gateway.onEvent(onEvent);
    // After a reconnect the Host holds the output of the gap until this device speaks again:
    // an ack of nothing says "still here" and releases it.
    offResync ??= gateway.onResync?.(() => {
      for (const sessionId of live) {
        quiet(gateway.call("terminal.session.ack", { sessionId, end: 0 }));
      }
    });
  };

  const unavailable = (err: unknown): { unavailable: string } => {
    const details = detailsOf(err);
    if (codeOf(err) === "forbidden" && details.reason === "host_terminal_needs_presence") {
      return { unavailable: t("web.terminal.openOnHost", { host: hostName() }) };
    }
    if (codeOf(err) === "rate_limited" && details.reason === "terminal_limit") {
      return { unavailable: t("web.terminal.limit", { host: hostName() }) };
    }
    return { unavailable: describeError(err) };
  };

  /** Resolves with the approval's final status, or "timeout". */
  const waitForApproval = (approvalId: string): Promise<string> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (status: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        approvalWaiters.delete(waiter);
        resolve(status);
      };
      const waiter = (id: string, status: string) => {
        if (id === approvalId && status !== "pending" && status !== "") finish(status);
      };
      const timer = setTimeout(
        () => finish("timeout"),
        opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
      );
      approvalWaiters.add(waiter);
      // It may have been answered before this listener existed.
      gateway.call("approvals.get", { approvalId }).then(
        (r) => {
          const a = isRecord(r) && isRecord(r.approval) ? r.approval : undefined;
          if (a && typeof a.status === "string") waiter(approvalId, a.status);
        },
        () => undefined,
      );
    });

  return {
    async open({ cols, rows, cwd, onWaiting }) {
      ensureListening();
      const params = { cols, rows, ...(cwd ? { cwd } : {}) };
      let approvalId: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await gateway.call("terminal.session.open", {
            ...params,
            ...(approvalId ? { approvalId } : {}),
          });
          if (!isRecord(res) || typeof res.sessionId !== "string") {
            return { unavailable: t("web.terminal.openFailed") };
          }
          const result: TerminalOpenResult = {
            sessionId: res.sessionId,
            target: "host",
            label: typeof res.label === "string" ? res.label : hostName(),
          };
          live.add(res.sessionId);
          ended.delete(res.sessionId);
          return result;
        } catch (err) {
          const id = detailsOf(err).approvalId;
          if (attempt === 0 && codeOf(err) === "approval_required" && typeof id === "string") {
            onWaiting?.();
            const status = await waitForApproval(id);
            if (status === "approved") {
              approvalId = id;
              continue;
            }
            return {
              unavailable:
                status === "timeout"
                  ? t("web.terminal.approvalTimedOut")
                  : t("web.terminal.approvalDenied"),
            };
          }
          return unavailable(err);
        }
      }
      return { unavailable: t("web.terminal.openFailed") };
    },
    write(sessionId, data) {
      if (ended.has(sessionId)) return;
      let w = writers.get(sessionId);
      if (!w) {
        w = { buffer: "", timer: undefined };
        writers.set(sessionId, w);
      }
      const writer = w;
      writer.buffer += data;
      const flush = () => {
        if (writer.timer !== undefined) clearTimeout(writer.timer);
        writer.timer = undefined;
        // Chunks stay in order: calls on one socket are handled in the order they were sent.
        while (writer.buffer.length > 0) {
          let end = Math.min(MAX_WRITE_CHARS, writer.buffer.length);
          const last = writer.buffer.charCodeAt(end - 1);
          if (end < writer.buffer.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
          const chunk = writer.buffer.slice(0, end);
          writer.buffer = writer.buffer.slice(end);
          quiet(gateway.call("terminal.session.write", { sessionId, data: chunk }));
        }
      };
      if (writer.buffer.length >= MAX_WRITE_CHARS) flush();
      else if (writer.timer === undefined) writer.timer = setTimeout(flush, batchMs);
    },
    resize(sessionId, cols, rows) {
      quiet(gateway.call("terminal.session.resize", { sessionId, cols, rows }));
    },
    close(sessionId) {
      forget(sessionId);
      quiet(gateway.call("terminal.session.close", { sessionId }));
    },
    onData(cb) {
      ensureListening();
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onExit(cb) {
      ensureListening();
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}
