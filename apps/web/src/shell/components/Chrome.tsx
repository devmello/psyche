import { activeI18n, destinationFor, PsycheMark, StatusPill, t } from "@psyche/ui";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import type { GatewayStatus } from "../../client/status.ts";
import { useShell, useShellState } from "../context.tsx";
import type { GatewayRunView } from "../platform.ts";

/** The destinations, in docs/06 §2.1's order (the fallback sidebar's first group). */
export const RAIL_ITEMS = [
  {
    route: "/chat",
    get label() {
      return t("web.rail.chat");
    },
  },
  {
    route: "/search",
    get label() {
      return t("web.rail.search");
    },
  },
  {
    route: "/feed",
    get label() {
      return t("web.rail.feed");
    },
  },
  {
    route: "/ideas",
    get label() {
      return t("web.rail.ideas");
    },
  },
  {
    route: "/goals",
    get label() {
      return t("web.rail.goals");
    },
  },
  {
    route: "/library/documents",
    get label() {
      return t("web.rail.library");
    },
  },
] as const;

const rowClass =
  "flex h-7 w-full items-center gap-2 rounded-sm px-3 text-start text-body text-label-primary outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-selection";

/**
 * The shell's own sidebar (redesign §5.1) for hosts without the UI kit's: destinations, the
 * thread list on chat routes, and Settings at the foot. The composed app passes the kit's.
 */
export function ShellSidebar(props: {
  route: string;
  onNavigate: (route: string) => void;
  /** The thread list, on chat routes. */
  threads?: ReactNode;
  /** Shown above Settings (the web client's connection pill). */
  footer?: ReactNode;
  width: number;
}): ReactElement {
  // `/agent/*` belongs to Chat: the agent sheet opens over the chat.
  const current = destinationFor(props.route);
  return (
    <nav
      className="flex h-full min-h-0 flex-col gap-3 py-2 material-sidebar"
      style={{ width: props.width }}
      aria-label={t("shell.sidebar.label")}
      data-testid="sidebar"
    >
      <span className="px-3 pb-1">
        <PsycheMark size={20} withWordmark={false} />
      </span>
      <ul aria-label={t("shell.sidebar.destinations")} className="flex flex-col">
        {RAIL_ITEMS.map((i) => (
          <li key={i.route} className="px-1">
            <button
              type="button"
              className={rowClass}
              aria-current={destinationFor(i.route) === current ? "page" : undefined}
              onClick={() => props.onNavigate(i.route)}
            >
              {i.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{props.threads}</div>
      {props.footer ? <div className="px-3">{props.footer}</div> : null}
      <div className="px-1">
        <button
          type="button"
          className={rowClass}
          onClick={() => props.onNavigate("/settings/model")}
        >
          {t("web.rail.settings")}
        </button>
      </div>
    </nav>
  );
}

/** A row's time: the clock time today, the weekday within a week, else the date. */
export function rowTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfToday) {
    return activeI18n().time(d, { hour: "numeric", minute: "2-digit" });
  }
  if (d.getTime() >= startOfToday - 6 * 86_400_000) {
    return activeI18n().date(d, { weekday: "short" });
  }
  return activeI18n().date(d, { month: "short", day: "numeric" });
}

function titleOf(thread: { kind: string; title: string }): string {
  return thread.kind === "main"
    ? t("web.threads.mainChat")
    : thread.title || t("web.threads.untitled");
}

export function ThreadList(props: {
  hidden?: boolean;
  currentThreadId: string | null;
  onOpen: (threadId: string) => void;
  onNew: () => void;
}): ReactElement {
  const threads = useShellState((s) => s.threads);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const live = threads.filter((x) => x.thread.archivedAt === null);
  const archived = threads.length - live.length;
  const q = query.trim().toLowerCase();
  const shown = q
    ? live.filter((x) =>
        `${titleOf(x.thread)} ${x.lastMessage?.text ?? ""}`.toLowerCase().includes(q),
      )
    : live;
  const now = new Date();
  return (
    <aside
      className="threads"
      hidden={props.hidden ?? false}
      aria-label={t("web.threads.label")}
      data-testid="thread-list"
    >
      <div className="threads-header">
        <strong>{t("web.threads.label")}</strong>
        <button
          type="button"
          className="pill"
          onClick={props.onNew}
          title={t("web.threads.newSideChatTitle")}
        >
          {t("web.threads.newSideChat")}
        </button>
      </div>
      <div className="threads-search">
        <label htmlFor={searchId} className="sr-only">
          {t("web.threads.searchLabel")}
        </label>
        <input
          id={searchId}
          type="search"
          placeholder={t("web.threads.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {live.length === 0 ? (
        <p style={{ padding: "0 12px", color: "var(--shell-muted)" }}>{t("web.threads.empty")}</p>
      ) : shown.length === 0 ? (
        <p style={{ padding: "0 12px", color: "var(--shell-muted)" }}>
          {t("web.threads.noMatch", { query: query.trim() })}
        </p>
      ) : null}
      <ul aria-label={t("web.threads.listLabel")}>
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
                  {thread.kind === "incognito" ? (
                    <span className="thread-row-badge" title={t("web.threads.incognitoHint")}>
                      {t("web.threads.incognito")}
                    </span>
                  ) : null}
                  {busy ? (
                    <span
                      className="thread-row-dot"
                      role="img"
                      aria-label={t("web.threads.busy")}
                    />
                  ) : null}
                  {at ? (
                    <time className="thread-row-time" dateTime={at}>
                      {rowTime(at, now)}
                    </time>
                  ) : null}
                </span>
                {lastMessage ? (
                  <span className="thread-row-line">
                    {lastMessage.role === "user"
                      ? t("web.threads.fromYou", { text: lastMessage.text })
                      : lastMessage.text}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {archived > 0 ? (
        <p style={{ padding: "0 12px", color: "var(--shell-muted)" }}>
          {t("web.threads.archived", { count: archived })}
        </p>
      ) : null}
    </aside>
  );
}

/**
 * docs/06 §3.0 Offline: the composer is disabled; tasks keep running. On the desktop, `run` is
 * the supervisor's view of the Gateway process: a start that failed says why, with "Show logs".
 */
export function OfflineBanner({
  status,
  run,
  onShowLogs,
  pairingGrace = false,
}: {
  status: GatewayStatus;
  run?: GatewayRunView;
  /**
   * Desktop: a `pending` handshake is a reconnect in progress, not a pairing request, until it
   * persists (#539); show "Connecting…" instead of the pairing code meanwhile.
   */
  pairingGrace?: boolean;
  onShowLogs?: () => void;
}): ReactElement | null {
  if (status.phase === "paired") return null;
  if (run?.kind === "stopped" && run.reason && run.reason !== "quit")
    return (
      <div className="banner" role="alert" data-testid="gateway-failed-banner">
        {t("web.banner.startFailed", { reason: run.reason })}{" "}
        {run.logs && onShowLogs ? (
          <button type="button" className="banner-action" onClick={onShowLogs}>
            {t("web.banner.showLogs")}
          </button>
        ) : null}
      </div>
    );
  if (run?.kind === "starting")
    return (
      <div className="banner" role="status" data-testid="gateway-starting-banner">
        {t("web.banner.starting")}
      </div>
    );
  if (status.phase === "pending" && pairingGrace)
    return (
      <div className="banner" role="status" data-testid="connecting-banner">
        {t("web.banner.connecting")}
      </div>
    );
  if (status.phase === "pending")
    return (
      <div className="banner" role="status" data-testid="pairing-banner">
        {t("web.banner.pairing")} <code>{status.pairingCode}</code>
      </div>
    );
  if (status.phase === "denied")
    return (
      <div className="banner" role="alert">
        {t("web.banner.denied")}
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
      {t("web.banner.offline")}
    </div>
  );
}

export function GatewayPill({ status }: { status: GatewayStatus }): ReactElement {
  const tone = status.phase === "paired" ? "ok" : status.phase === "pending" ? "warn" : "error";
  const label = t("web.gateway.phase", { phase: status.phase });
  return <StatusPill tone={tone} label={label} title={t("web.gateway.title")} />;
}

export function Toasts(): ReactElement {
  const { store } = useShell();
  const toasts = useShellState((s) => s.toasts);
  return (
    // One region per kind (no nested live regions); errors are alerts and say so in words, and
    // the timers pause while the pointer or focus is here (docs/a11y-audit.md T1–T3).
    <section
      aria-label={t("web.toast.region")}
      className="toasts"
      data-testid="toasts"
      onMouseEnter={() => store.holdToasts(true)}
      onMouseLeave={() => store.holdToasts(false)}
      onFocus={() => store.holdToasts(true)}
      onBlur={() => store.holdToasts(false)}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast"
          role={toast.tone === "error" ? "alert" : "status"}
          data-tone={toast.tone}
        >
          {toast.tone === "error" ? <span className="sr-only">{t("web.toast.error")}</span> : null}
          {toast.text}{" "}
          <button
            type="button"
            className="pill"
            aria-label={t("web.toast.dismissLabel", { text: toast.text })}
            onClick={() => store.dismissToast(toast.id)}
          >
            {t("common.dismiss")}
          </button>
        </div>
      ))}
    </section>
  );
}

/** Placeholder for screens other sessions build (Feed, Ideas, Goals, Library, Settings). */
export function SectionPlaceholder({ route }: { route: string }): ReactElement {
  return (
    <section className="chat" aria-label={route} data-testid="section">
      <header>
        <strong>{route}</strong>
      </header>
      <p style={{ padding: 16, color: "var(--shell-muted)" }}>{t("web.section.placeholder")}</p>
    </section>
  );
}
