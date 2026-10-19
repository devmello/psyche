import type { Task } from "@psyche/protocol";
import {
  type PointerEvent,
  type ReactElement,
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

const PANE_TITLES: Record<PaneInstance["pane"], string> = {
  browser: "Browser",
  terminal: "Terminal",
  files: "Files",
  editor: "Editor",
  diff: "Diff",
  plan: "Plan",
  tasks: "Tasks",
  subagents: "Subagents",
  artifact: "Artifact",
  vm: "VM",
};

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
      const t = (e.payload as { task: Task }).task;
      setTasks((all) => [t, ...all.filter((x) => x.id !== t.id)]);
    });
  }, [store]);
  if (tasks.length === 0)
    return <p style={{ padding: 16, color: "var(--shell-muted)" }}>No tasks yet.</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 8 }} data-testid="tasks-pane">
      {tasks.map((t) => (
        <li key={t.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--shell-border)" }}>
          <strong>{t.title}</strong> <span style={{ color: "var(--shell-muted)" }}>{t.status}</span>
          {t.status === "running" || t.status === "paused" ? (
            <button
              type="button"
              className="pill"
              style={{ marginLeft: 8 }}
              onClick={() =>
                void store.call(t.status === "running" ? "tasks.pause" : "tasks.resume", {
                  taskId: t.id,
                })
              }
            >
              {t.status === "running" ? "Pause" : "Resume"}
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
}): ReactElement {
  const { platform } = useShell();
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
          The terminal runs in the desktop app.
        </p>
      );
    case "tasks":
    case "plan":
      return <TasksPane />;
    case "vm":
      return <p style={{ padding: 16, color: "var(--shell-muted)" }}>VM mode is off.</p>;
    default:
      // Files, editor, diff, artifact and subagent viewers are S13's (@psyche/viewers).
      return (
        <p style={{ padding: 16, color: "var(--shell-muted)" }}>
          {PANE_TITLES[props.pane.pane]} {props.pane.target ? `· ${props.pane.target}` : ""} — the
          viewer arrives with @psyche/viewers.
        </p>
      );
  }
}

export function PaneArea(props: {
  layout: LayoutStore;
  threadId: string;
  width: number;
  covered: boolean;
  dispatch: (action: LayoutAction) => void;
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
      props.dispatch({ type: "resize", boundary, delta: ev.clientX - last });
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
        <div className="resizer" onPointerDown={startDrag(0)} aria-hidden="true" />
      )}
      {pres.groups.map((g, gi) => {
        const active = findPane(state, g.activePaneId);
        return (
          <section
            key={g.groupId}
            className="pane"
            style={{ flex: g.size }}
            aria-label={active ? PANE_TITLES[active.pane] : "Pane"}
            data-testid="pane-group"
          >
            {gi > 0 ? (
              <div className="resizer" onPointerDown={startDrag(gi)} aria-hidden="true" />
            ) : null}
            <header>
              <div className="tabs" role="tablist">
                {g.paneIds.map((id) => {
                  const p = findPane(state, id);
                  if (!p) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={id === g.activePaneId}
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
                  title="Split"
                  onClick={() => props.dispatch({ type: "split", paneId: active.paneId })}
                >
                  ⧉
                </button>
              ) : null}
              {active && platform.windows ? (
                <button
                  type="button"
                  title="Open in window"
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
                  title="Close pane (⌘\)"
                  aria-label="Close pane"
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
                />
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
