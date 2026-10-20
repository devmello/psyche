import "@xterm/xterm/css/xterm.css";
import { describeError, t } from "@psyche/ui";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type { TerminalPort } from "../platform.ts";

/**
 * Terminal pane (feature K6; docs/06 §3.6). The shell only renders: the desktop asks the
 * Gateway where each shell runs (the per-task sandbox, or the host only when `exec_host` is on)
 * and never falls back to a host shell. When no terminal can be opened the pane shows the
 * port's message. Visual design belongs to the design pass; styling here is minimal.
 */

export interface TerminalPaneProps {
  port: TerminalPort;
  threadId: string;
  cwd?: string;
  onExit?: (sessionId: string, exitCode: number) => void;
}

type SessionInfo =
  | { status: "opening" }
  | { status: "open"; sessionId: string; label: string; target: "sandbox" | "host" }
  | {
      status: "exited";
      sessionId: string;
      label: string;
      target: "sandbox" | "host";
      exitCode: number;
    }
  | { status: "unavailable"; message: string };

interface SessionHandlers {
  data(data: string): void;
  exit(exitCode: number): void;
}

/** Keystroke chunks stay well under the host's 64 KB per-write cap (≤ 3 UTF-8 bytes a unit). */
const WRITE_CHUNK = 16 * 1024;
const PENDING_SESSIONS = 16;
const PENDING_CHARS = 256 * 1024;

/** Splits a paste into write-sized chunks without cutting a surrogate pair. */
export function splitForWrite(data: string, size = WRITE_CHUNK): string[] {
  if (data.length <= size) return [data];
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Routes port events to the session that owns them, holding output that arrives before a
 * session's `open` reply has been handled (bounded, oldest sessions dropped first).
 */
class SessionRouter {
  readonly #handlers = new Map<string, SessionHandlers>();
  readonly #pending = new Map<string, { data: string[]; chars: number; exit?: number }>();

  data(sessionId: string, data: string): void {
    const handler = this.#handlers.get(sessionId);
    if (handler) {
      handler.data(data);
      return;
    }
    const entry = this.#entry(sessionId);
    if (entry.chars + data.length > PENDING_CHARS) return;
    entry.data.push(data);
    entry.chars += data.length;
  }

  exit(sessionId: string, exitCode: number): void {
    const handler = this.#handlers.get(sessionId);
    if (handler) {
      handler.exit(exitCode);
      return;
    }
    this.#entry(sessionId).exit = exitCode;
  }

  attach(sessionId: string, handlers: SessionHandlers): void {
    this.#handlers.set(sessionId, handlers);
    const pending = this.#pending.get(sessionId);
    if (!pending) return;
    this.#pending.delete(sessionId);
    if (pending.data.length > 0) handlers.data(pending.data.join(""));
    if (pending.exit !== undefined) handlers.exit(pending.exit);
  }

  detach(sessionId: string): void {
    this.#handlers.delete(sessionId);
    this.#pending.delete(sessionId);
  }

  #entry(sessionId: string) {
    let entry = this.#pending.get(sessionId);
    if (!entry) {
      if (this.#pending.size >= PENDING_SESSIONS) {
        const oldest = this.#pending.keys().next().value;
        if (oldest !== undefined) this.#pending.delete(oldest);
      }
      entry = { data: [], chars: 0 };
      this.#pending.set(sessionId, entry);
    }
    return entry;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? describeError(error)
    : t("web.terminal.openFailed");
}

function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // Not laid out yet (hidden tab or zero-size container).
  }
}

const styles = {
  pane: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "var(--shell-panel, #111)",
    color: "var(--shell-text, inherit)",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 8px",
    borderBottom: "1px solid var(--shell-border, #333)",
    fontSize: 12,
  },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 6px",
    border: "1px solid transparent",
    borderRadius: 4,
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  label: {
    marginInlineStart: "auto",
    color: "var(--shell-muted, #999)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  body: { position: "relative", flex: 1, minHeight: 0 },
  session: { position: "absolute", inset: 0, display: "flex", flexDirection: "column" },
  xterm: { flex: 1, minHeight: 0, padding: 4 },
  message: { padding: 16, color: "var(--shell-muted, #999)", fontSize: 13 },
  exit: {
    padding: "2px 8px",
    borderTop: "1px solid var(--shell-border, #333)",
    color: "var(--shell-muted, #999)",
    fontSize: 12,
  },
} satisfies Record<string, CSSProperties>;

interface TerminalSessionProps {
  port: TerminalPort;
  router: SessionRouter;
  threadId: string;
  cwd: string | undefined;
  visible: boolean;
  onInfo: (info: SessionInfo) => void;
  onExit: ((sessionId: string, exitCode: number) => void) | undefined;
}

function TerminalSession({
  port,
  router,
  threadId,
  cwd,
  visible,
  onInfo,
  onExit,
}: TerminalSessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<SessionInfo>({ status: "opening" });
  const onInfoRef = useRef(onInfo);
  const onExitRef = useRef(onExit);
  onInfoRef.current = onInfo;
  onExitRef.current = onExit;

  useEffect(() => onInfoRef.current(info), [info]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    safeFit(fit);

    let disposed = false;
    let exited = false;
    let sessionId: string | undefined;
    let size = { cols: term.cols, rows: term.rows };

    const syncSize = () => {
      if (!sessionId || exited) return;
      if (term.cols === size.cols && term.rows === size.rows) return;
      size = { cols: term.cols, rows: term.rows };
      port.resize(sessionId, size.cols, size.rows);
    };

    const input = term.onData((data) => {
      if (!sessionId || exited) return;
      for (const chunk of splitForWrite(data)) port.write(sessionId, chunk);
    });

    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            safeFit(fit);
            syncSize();
          });
    observer?.observe(el);

    port.open({ threadId, ...(cwd ? { cwd } : {}), cols: size.cols, rows: size.rows }).then(
      (res) => {
        if (disposed) {
          if ("sessionId" in res) port.close(res.sessionId);
          return;
        }
        if ("unavailable" in res) {
          setInfo({ status: "unavailable", message: res.unavailable });
          return;
        }
        const id = res.sessionId;
        sessionId = id;
        setInfo({ status: "open", sessionId: id, label: res.label, target: res.target });
        router.attach(id, {
          data: (data) => term.write(data),
          exit: (exitCode) => {
            exited = true;
            term.options.disableStdin = true;
            setInfo({
              status: "exited",
              sessionId: id,
              label: res.label,
              target: res.target,
              exitCode,
            });
            onExitRef.current?.(id, exitCode);
          },
        });
        syncSize();
      },
      (error: unknown) => {
        if (!disposed) setInfo({ status: "unavailable", message: errorMessage(error) });
      },
    );

    return () => {
      disposed = true;
      observer?.disconnect();
      input.dispose();
      if (sessionId) {
        router.detach(sessionId);
        if (!exited) port.close(sessionId);
      }
      term.dispose();
    };
  }, [port, router, threadId, cwd]);

  return (
    <div style={{ ...styles.session, visibility: visible ? "visible" : "hidden" }}>
      {info.status === "unavailable" ? (
        <p role="alert" style={styles.message}>
          {info.message}
        </p>
      ) : null}
      <div
        ref={hostRef}
        data-testid="terminal-host"
        style={{ ...styles.xterm, display: info.status === "unavailable" ? "none" : "block" }}
      />
      {info.status === "exited" ? (
        <div role="status" style={styles.exit}>
          {t("web.terminal.exit", { code: info.exitCode })}
        </div>
      ) : null}
    </div>
  );
}

function headerLabel(info: SessionInfo | undefined): string {
  if (!info || info.status === "opening") return t("web.terminal.opening");
  if (info.status === "unavailable") return t("web.terminal.unavailable");
  return info.label;
}

export function TerminalPane({ port, threadId, cwd, onExit }: TerminalPaneProps) {
  const routerRef = useRef<SessionRouter | null>(null);
  routerRef.current ??= new SessionRouter();
  const router = routerRef.current;
  const nextKey = useRef(2);
  const [tabs, setTabs] = useState<number[]>([1]);
  const [active, setActive] = useState(1);
  const [infos, setInfos] = useState<ReadonlyMap<number, SessionInfo>>(new Map());

  useEffect(() => {
    const offData = port.onData((id, data) => router.data(id, data));
    const offExit = port.onExit((id, code) => router.exit(id, code));
    return () => {
      offData();
      offExit();
    };
  }, [port, router]);

  const addTab = useCallback(() => {
    const key = nextKey.current++;
    setTabs((all) => [...all, key]);
    setActive(key);
  }, []);

  const closeTab = useCallback(
    (key: number) => {
      const remaining = tabs.filter((k) => k !== key);
      setTabs(remaining);
      setInfos((m) => {
        const next = new Map(m);
        next.delete(key);
        return next;
      });
      if (active === key) setActive(remaining[remaining.length - 1] ?? 0);
    },
    [tabs, active],
  );

  const setInfo = useCallback((key: number, info: SessionInfo) => {
    setInfos((m) => new Map(m).set(key, info));
  }, []);

  return (
    <section aria-label={t("web.terminal.label")} style={styles.pane}>
      <div role="tablist" aria-label={t("web.terminal.sessions")} style={styles.bar}>
        {tabs.map((key, i) => (
          <span key={key} style={styles.tab}>
            <button
              type="button"
              role="tab"
              aria-selected={key === active}
              onClick={() => setActive(key)}
              style={{
                ...styles.tab,
                padding: 0,
                fontWeight: key === active ? 600 : 400,
              }}
            >
              {t("web.terminal.tab", { n: i + 1 })}
            </button>
            <button
              type="button"
              aria-label={t("web.terminal.closeTab", { n: i + 1 })}
              onClick={() => closeTab(key)}
              style={{ ...styles.tab, padding: 0 }}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-label={t("web.terminal.newTab")}
          onClick={addTab}
          style={styles.tab}
        >
          +
        </button>
        <span style={styles.label}>{tabs.length > 0 ? headerLabel(infos.get(active)) : ""}</span>
      </div>
      <div style={styles.body}>
        {tabs.length === 0 ? <p style={styles.message}>{t("web.terminal.empty")}</p> : null}
        {tabs.map((key) => (
          <TerminalSession
            key={key}
            port={port}
            router={router}
            threadId={threadId}
            cwd={cwd}
            visible={key === active}
            onInfo={(info) => setInfo(key, info)}
            onExit={onExit}
          />
        ))}
      </div>
    </section>
  );
}
