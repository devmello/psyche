import { PsycheMark, StatusPill } from "@psyche/ui";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import type { GatewayStatus } from "../../client/status.ts";
import { useShell, useShellState } from "../context.tsx";

/** Left rail (docs/06 §2.1); below 720 px it renders as the bottom tab bar (§3.24). */
export const RAIL_ITEMS = [
  { route: "/chat", label: "Chat" },
  { route: "/search", label: "Search" },
  { route: "/feed", label: "Feed" },
  { route: "/ideas", label: "Ideas" },
  { route: "/goals", label: "Goals" },
  { route: "/library/documents", label: "Library" },
] as const;

const COMPACT_TABS = new Set(["/chat", "/feed", "/ideas", "/goals", "/library/documents"]);

export function Rail(props: {
  route: string;
  compact: boolean;
  onNavigate: (route: string) => void;
  /** Shown above Settings on wide layouts (the web client's connection pill). */
  footer?: ReactNode;
}): ReactElement {
  const items = props.compact ? RAIL_ITEMS.filter((i) => COMPACT_TABS.has(i.route)) : RAIL_ITEMS;
  const section = `/${props.route.split("/")[1] ?? ""}`;
  return (
    <nav className="rail" aria-label="Sections" data-testid="rail">
      {props.compact ? null : (
        <span style={{ alignSelf: "center", padding: "4px 0 8px" }}>
          <PsycheMark size={24} withWordmark={false} />
        </span>
      )}
      {items.map((i) => (
        <button
          key={i.route}
          type="button"
          aria-current={i.route.startsWith(section) ? "page" : undefined}
          onClick={() => props.onNavigate(i.route)}
        >
          {i.label}
        </button>
      ))}
      {props.compact ? null : (
        <>
          <span className="spacer" />
          {props.footer ? <div className="rail-status">{props.footer}</div> : null}
          <button type="button" onClick={() => props.onNavigate("/settings/general")}>
            Settings
          </button>
        </>
      )}
    </nav>
  );
}

/** A row's time: the clock time today, the weekday within a week, else the date. */
export function rowTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (d.getTime() >= startOfToday - 6 * 86_400_000) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function titleOf(thread: { kind: string; title: string }): string {
  return thread.kind === "main" ? "Main chat" : thread.title || "Untitled";
}

export function ThreadList(props: {
  hidden: boolean;
  currentThreadId: string | null;
  onOpen: (threadId: string) => void;
  onNew: () => void;
}): ReactElement {
  const threads = useShellState((s) => s.threads);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const live = threads.filter((t) => t.thread.archivedAt === null);
  const archived = threads.length - live.length;
  const q = query.trim().toLowerCase();
  const shown = q
    ? live.filter((t) =>
        `${titleOf(t.thread)} ${t.lastMessage?.text ?? ""}`.toLowerCase().includes(q),
      )
    : live;
  const now = new Date();
  return (
    <aside className="threads" hidden={props.hidden} aria-label="Threads" data-testid="thread-list">
      <div className="threads-header">
        <strong>Threads</strong>
        <button type="button" className="pill" onClick={props.onNew} title="New side chat (⌘N)">
          + Side chat
        </button>
      </div>
      <div className="threads-search">
        <label htmlFor={searchId} className="sr-only">
          Search threads
        </label>
        <input
          id={searchId}
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {live.length === 0 ? (
        <p style={{ padding: "0 12px", color: "var(--shell-muted)" }}>No side chats yet.</p>
      ) : shown.length === 0 ? (
        <p style={{ padding: "0 12px", color: "var(--shell-muted)" }}>
          No threads match “{query.trim()}”.
        </p>
      ) : null}
      <ul aria-label="Threads list">
        {shown.map(({ thread, activity, lastMessage }) => {
          const at = lastMessage?.at ?? thread.lastMessageAt;
          const busy = activity.running + activity.awaitingApproval + activity.awaitingInput > 0;
          return (
            <li key={thread.id}>
              <button
                type="button"
                className="thread-row"
                aria-current={thread.id === props.currentThreadId ? "true" : undefined}
                onClick={() => props.onOpen(thread.id)}
              >
                <span className="thread-row-top">
                  <span className="thread-row-title">{titleOf(thread)}</span>
                  {busy ? (
                    <span className="thread-row-dot" role="img" aria-label="Working or waiting" />
                  ) : null}
                  {at ? (
                    <time className="thread-row-time" dateTime={at}>
                      {rowTime(at, now)}
                    </time>
                  ) : null}
                </span>
                {lastMessage ? (
                  <span className="thread-row-line">
                    {lastMessage.role === "user" ? "You: " : ""}
                    {lastMessage.text}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {archived > 0 ? (
        <p style={{ padding: "0 12px", color: "var(--shell-muted)" }}>Archived ({archived})</p>
      ) : null}
    </aside>
  );
}

/** docs/06 §3.0 Offline: the composer is disabled; tasks keep running. */
export function OfflineBanner({ status }: { status: GatewayStatus }): ReactElement | null {
  if (status.phase === "paired") return null;
  if (status.phase === "pending")
    return (
      <div className="banner" role="status" data-testid="pairing-banner">
        Approve this device from a paired device to continue. Pairing code{" "}
        <code>{status.pairingCode}</code>
      </div>
    );
  if (status.phase === "denied")
    return (
      <div className="banner" role="alert">
        This device was denied by the Gateway.
      </div>
    );
  if (
    status.phase === "idle" ||
    status.phase === "connecting" ||
    status.phase === "challenge" ||
    status.phase === "verifying"
  )
    if (status.attempt === 0) return null;
  return (
    <div className="banner" role="status" data-testid="offline-banner">
      Psyche can't reach the Gateway. Tasks keep running; this window will reconnect.
    </div>
  );
}

export function GatewayPill({ status }: { status: GatewayStatus }): ReactElement {
  const tone = status.phase === "paired" ? "ok" : status.phase === "pending" ? "warn" : "error";
  const label = status.phase === "paired" ? "connected" : status.phase;
  return <StatusPill tone={tone} label={label} title="Gateway connection" />;
}

export function Toasts(): ReactElement {
  const { store } = useShell();
  const toasts = useShellState((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role="status" data-tone={t.tone}>
          {t.text}{" "}
          <button type="button" className="pill" onClick={() => store.dismissToast(t.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

/** Placeholder for screens other sessions build (Feed, Ideas, Goals, Library, Settings). */
export function SectionPlaceholder({ route }: { route: string }): ReactElement {
  return (
    <section className="chat" aria-label={route} data-testid="section">
      <header>
        <strong>{route}</strong>
      </header>
      <p style={{ padding: 16, color: "var(--shell-muted)" }}>
        This screen arrives with the UI kit.
      </p>
    </section>
  );
}
