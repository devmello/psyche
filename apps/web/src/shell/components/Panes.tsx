import type { Task } from "@psyche/protocol";
import { activeI18n, t } from "@psyche/ui";
import {
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useShell } from "../context.tsx";
import {
  findPane,
  type LayoutAction,
  type LayoutStore,
  type PaneInstance,
  presentation,
} from "../layout/index.ts";
import { TerminalPane } from "../panes/TerminalPane.tsx";
import { BrowserPane } from "./BrowserPane.tsx";

const PANE_KINDS: readonly PaneInstance["pane"][] = [
  "browser",
  "terminal",
  "files",
  "editor",
  "diff",
  "plan",
  "tasks",
  "subagents",
  "artifact",
  "vm",
];

/** Pane names by kind, localized when read. */
const PANE_TITLES = Object.defineProperties(
  {},
  Object.fromEntries(
    PANE_KINDS.map((kind) => [kind, { enumerable: true, get: () => t(`web.panes.title.${kind}`) }]),
  ),
) as Readonly<Record<PaneInstance["pane"], string>>;

/** A horizontal pointer or arrow-key delta along the reading direction (start → end). */
function inlineDelta(dx: number): number {
  return activeI18n().dir === "rtl" ? -dx : dx;
}

/** Tasks / Activity pane (feature D5): live from `tasks.list` and `task.updated`. */
export function TasksPane(): ReactElement {
  const { store } = useShell();
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    void store
      .call<{ tasks: Task[] }>("tasks.list", {})
      .then((r) => r && setTasks(r.tasks))
      .catch(() => undefined);
    return store.tap((e) => {
      if (e.event !== "task.updated") return;
      const task = (e.payload as { task: Task }).task;
      setTasks((all) => [task, ...all.filter((x) => x.id !== task.id)]);
    });
  }, [store]);
  if (tasks.length === 0)
    return <p style={{ padding: 16, color: "var(--shell-muted)" }}>{t("web.tasks.empty")}</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 8 }} data-testid="tasks-pane">
      {tasks.map((task) => (
        <li
          key={task.id}
          style={{ padding: "6px 0", borderBottom: "1px solid var(--shell-border)" }}
        >
          <strong>{task.title}</strong>{" "}
          <span style={{ color: "var(--shell-muted)" }}>{task.status}</span>
          {task.status === "running" || task.status === "paused" ? (
            <button
              type="button"
              className="pill"
              style={{ marginInlineStart: 8 }}
              onClick={() =>
                void store.call(task.status === "running" ? "tasks.pause" : "tasks.resume", {
                  taskId: task.id,
                })
              }
            >
              {task.status === "running" ? t("web.tasks.pause") : t("web.tasks.resume")}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PaneBody(props: {
  pane: PaneInstance;
  threadId: string;
  covered: boolean;
  onClose: () => void;
  renderPane?: PaneRenderer;
  navigate?: (to: string) => void;
}): ReactElement {
  const { platform } = useShell();
  const custom = props.renderPane?.(props.pane, {
    threadId: props.threadId,
    covered: props.covered,
    navigate: props.navigate ?? (() => undefined),
  });
  if (custom !== null && custom !== undefined) return <>{custom}</>;
  switch (props.pane.pane) {
    case "browser":
      return <BrowserPane covered={props.covered} onClose={props.onClose} />;
    case "terminal":
      return platform.terminal ? (
        <TerminalPane
          port={platform.terminal}
          threadId={props.threadId}
          {...(props.pane.target ? { cwd: props.pane.target } : {})}
        />
      ) : (
        <p style={{ padding: 16, color: "var(--shell-muted)" }}>
          {t("web.panes.terminalDesktopOnly")}
        </p>
      );
    case "tasks":
    case "plan":
      return <TasksPane />;
    case "vm":
      return <p style={{ padding: 16, color: "var(--shell-muted)" }}>{t("web.panes.vmOff")}</p>;
    default:
      // Files, editor, diff, artifact and subagent viewers are S13's (@psyche/viewers).
      return (
        <p style={{ padding: 16, color: "var(--shell-muted)" }}>
          {props.pane.target
            ? t("web.panes.viewerPendingTarget", {
                pane: PANE_TITLES[props.pane.pane],
                target: props.pane.target,
                package: "@psyche/viewers",
              })
            : t("web.panes.viewerPending", {
                pane: PANE_TITLES[props.pane.pane],
                package: "@psyche/viewers",
              })}
        </p>
      );
  }
}

/** A keyboard-operable pane divider (docs/a11y-audit.md W5): drag it, or focus it and use ← →. */
function PaneResizer({
  onPointerDown,
  onStep,
  value,
  label = t("web.panes.resize"),
}: {
  onPointerDown: (e: PointerEvent) => void;
  onStep: (delta: number) => void;
  /** Share of the width before the divider, 0–100. */
  value: number;
  label?: string;
}): ReactElement {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no native element
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onStep(inlineDelta(-24));
        else if (e.key === "ArrowRight") onStep(inlineDelta(24));
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** The composed app's pane bodies (ShellSlots.pane). */
export type PaneRenderer = (
  pane: PaneInstance,
  ctx: { threadId: string; covered: boolean; navigate: (to: string) => void },
) => ReactNode | null | undefined;

export function PaneArea(props: {
  layout: LayoutStore;
  threadId: string;
  width: number;
  covered: boolean;
  dispatch: (action: LayoutAction) => void;
  renderPane?: PaneRenderer;
  navigate?: (to: string) => void;
}): ReactElement | null {
  const { platform } = useShell();
  const state = useSyncExternalStore(
    (cb) => props.layout.subscribeThread(props.threadId, cb),
    () => props.layout.forThread(props.threadId),
  );
  const pres = presentation(state, props.width);
  if (pres.groups.length === 0) return null;

  const startDrag = (boundary: number) => (e: PointerEvent) => {
    let last = e.clientX;
    const move = (ev: globalThis.PointerEvent) => {
      props.dispatch({ type: "resize", boundary, delta: inlineDelta(ev.clientX - last) });
      last = ev.clientX;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className="panes"
      style={{
        width: pres.mode === "compact" ? "100%" : `${Math.round((1 - pres.chatFraction) * 100)}%`,
      }}
      data-testid="pane-area"
    >
      {pres.mode === "compact" ? null : (
        <PaneResizer
          onPointerDown={startDrag(0)}
          onStep={(delta) => props.dispatch({ type: "resize", boundary: 0, delta })}
          value={Math.round(pres.chatFraction * 100)}
          label={t("web.panes.resizeChat")}
        />
      )}
      {pres.groups.map((g, gi) => {
        const active = findPane(state, g.activePaneId);
        return (
          <section
            key={g.groupId}
            className="pane"
            style={{ flex: g.size }}
            aria-label={active ? PANE_TITLES[active.pane] : t("web.panes.pane")}
            data-testid="pane-group"
          >
            {gi > 0 ? (
              <PaneResizer
                onPointerDown={startDrag(gi)}
                onStep={(delta) => props.dispatch({ type: "resize", boundary: gi, delta })}
                value={Math.round(g.size * 100)}
              />
            ) : null}
            <header>
              {/* biome-ignore lint/a11y/useSemanticElements: a button row, not a form group */}
              <div className="tabs" role="group" aria-label={t("web.panes.group")}>
                {g.paneIds.map((id) => {
                  const p = findPane(state, id);
                  if (!p) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-current={id === g.activePaneId ? "true" : undefined}
                      onClick={() => props.dispatch({ type: "activateTab", paneId: id })}
                      data-testid="pane-tab"
                      data-pane={p.pane}
                    >
                      {p.title ?? PANE_TITLES[p.pane]}
                    </button>
                  );
                })}
              </div>
              {active && g.paneIds.length > 1 && pres.mode === "double" ? null : active ? (
                <button
                  type="button"
                  title={t("web.panes.split")}
                  aria-label={t("web.panes.splitPane")}
                  onClick={() => props.dispatch({ type: "split", paneId: active.paneId })}
                >
                  ⧉
                </button>
              ) : null}
              {active && platform.windows ? (
                <button
                  type="button"
                  title={t("web.panes.openInWindow")}
                  aria-label={t("web.panes.openPaneInWindow")}
                  onClick={() => {
                    props.dispatch({ type: "popOut", paneId: active.paneId });
                    void platform.windows?.popOutPane(
                      `/chat/${props.threadId}/pane/${active.paneId}`,
                      active.title ?? PANE_TITLES[active.pane],
                    );
                  }}
                >
                  ⇱
                </button>
              ) : null}
              {active ? (
                <button
                  type="button"
                  title={t("web.panes.closePaneTitle")}
                  aria-label={t("web.panes.closePane")}
                  onClick={() => props.dispatch({ type: "close", paneId: active.paneId })}
                >
                  ×
                </button>
              ) : null}
            </header>
            <div className="body">
              {active ? (
                <PaneBody
                  pane={active}
                  threadId={props.threadId}
                  covered={props.covered}
                  onClose={() => props.dispatch({ type: "close", paneId: active.paneId })}
                  {...(props.renderPane ? { renderPane: props.renderPane } : {})}
                  {...(props.navigate ? { navigate: props.navigate } : {})}
                />
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
