import { t } from "@psyche/ui";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useShell } from "../context.tsx";
import type {
  BrowserPort,
  TeachAppChoiceView,
  TeachAppStatusView,
  TeachCapture,
} from "../platform.ts";

/**
 * "Record in an app" (teach by showing, phase 2; docs/design/teach-by-showing-2026.md §13): the
 * owner picks one Mac app they already allowed for computer use and presses Start; the Mac helper
 * watches that app's accessibility events until Stop. The same review screen and the same save
 * path as the browser's take it from there.
 *
 * Owner-only by wiring: these calls go to the desktop's main process, which asks the Gateway,
 * which asks the Mac helper. The agent has no tool for it. A menu-bar item on the Mac shows the
 * recording and has its own Stop, so ending it never depends on this window.
 */

const POLL_MS = 1500;

/** Turns what the helper returned into the review screen's capture. */
export function captureFromApp(r: {
  id: string;
  endedBy: TeachCapture["endedBy"];
  app: { bundleId: string; name: string };
  steps: TeachCapture["steps"];
  skipped: number;
}): TeachCapture {
  return {
    id: r.id,
    endedBy: r.endedBy,
    steps: r.steps,
    app: r.app,
    skippedInput: r.skipped,
  };
}

export interface AppRecordModel {
  available: boolean;
  watching: boolean;
  picking: boolean;
  apps: TeachAppChoiceView[] | null;
  choice: string;
  setChoice: (id: string) => void;
  status: TeachAppStatusView;
  busy: boolean;
  open: () => void;
  close: () => void;
  start: () => void;
  stop: () => void;
  discard: () => void;
}

/** The state behind the button (in the tab row) and the panel (below it). */
export function useAppRecord(props: {
  port: BrowserPort;
  onActive: (active: boolean) => void;
  onCapture: (capture: TeachCapture) => void;
}): AppRecordModel {
  const { port } = props;
  const { store } = useShell();
  const [picking, setPicking] = useState(false);
  const [apps, setApps] = useState<TeachAppChoiceView[] | null>(null);
  const [choice, setChoice] = useState("");
  const [status, setStatus] = useState<TeachAppStatusView>({ active: false });
  const [busy, setBusy] = useState(false);
  const { onActive } = props;

  const poll = useCallback(async () => {
    if (!port.teachAppStatus) return;
    const s = await port.teachAppStatus().catch(() => ({ active: false }) as TeachAppStatusView);
    setStatus(s);
    onActive(s.active || s.ended !== undefined);
  }, [port, onActive]);

  // Pick up a recording that is already running (the window was reloaded) and follow it.
  useEffect(() => {
    void poll();
  }, [poll]);
  const watching = status.active || status.ended !== undefined;
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [watching, poll]);

  const open = () => {
    setPicking(true);
    void port
      .teachAppApps?.()
      .then((r) => {
        setApps(r.apps);
        setChoice(r.apps[0]?.bundleId ?? "");
      })
      .catch(() => setApps([]));
  };

  const start = () => {
    if (choice === "" || busy) return;
    setBusy(true);
    void port
      .teachAppStart?.(choice)
      .then(() => {
        setPicking(false);
        return poll();
      })
      .catch(() => store.toast(t("web.teach.app.startFailed"), "error"))
      .finally(() => setBusy(false));
  };

  const stop = () => {
    if (!port.teachAppStop || busy) return;
    setBusy(true);
    void port
      .teachAppStop()
      .then((r) => {
        setStatus({ active: false });
        props.onActive(false);
        if (r.steps.length === 0) store.toast(t("web.teach.nothingRecorded"), "info");
        else props.onCapture(captureFromApp(r));
      })
      .catch(() => store.toast(t("web.teach.app.stopFailed"), "error"))
      .finally(() => setBusy(false));
  };

  const discard = () => {
    void port
      .teachAppCancel?.()
      .catch(() => undefined)
      .finally(() => {
        setStatus({ active: false });
        props.onActive(false);
      });
  };

  return {
    available: port.teachAppStart !== undefined && port.teachAppApps !== undefined,
    watching,
    picking,
    apps,
    choice,
    setChoice,
    status,
    busy,
    open,
    close: () => setPicking(false),
    start,
    stop,
    discard,
  };
}

/** "Record in an app", next to the browser's Record. */
export function AppRecordButton(props: {
  rec: AppRecordModel;
  disabled: boolean;
}): ReactElement | null {
  const { rec } = props;
  if (!rec.available || rec.watching) return null;
  return (
    <button
      type="button"
      className="pill"
      title={t("web.teach.app.recordHint")}
      aria-expanded={rec.picking}
      disabled={props.disabled}
      onClick={() => (rec.picking ? rec.close() : rec.open())}
      data-testid="teach-app-record"
    >
      {t("web.teach.app.record")}
    </button>
  );
}

/** The app picker before a recording, and the recording bar while it runs. */
export function AppRecordPanel(props: { rec: AppRecordModel }): ReactElement | null {
  const { rec } = props;
  const { status, apps, choice, busy } = rec;
  const appName = status.app?.name ?? "";
  if (rec.watching) {
    return (
      <div className="teach-bar" role="status" data-testid="teach-app-bar">
        <span className="teach-dot" aria-hidden="true" />
        <div className="teach-bar-text">
          <strong>{t("web.teach.app.bar.title", { app: appName })}</strong>{" "}
          <span data-testid="teach-app-count">
            {t("web.teach.bar.steps", { count: status.steps ?? 0 })}
          </span>
          <div className="teach-hint">
            {status.ended === "limit"
              ? t("web.teach.app.bar.endedLimit")
              : status.ended === "timeout"
                ? t("web.teach.app.bar.endedTimeout")
                : status.ended === "interrupted"
                  ? t("web.teach.app.bar.endedInterrupted")
                  : t("web.teach.app.bar.body", { app: appName })}
          </div>
        </div>
        <button type="button" className="pill" onClick={rec.discard} data-testid="teach-app-cancel">
          {t("web.teach.bar.cancel")}
        </button>
        <button
          type="button"
          className="teach-primary"
          disabled={busy}
          onClick={rec.stop}
          data-testid="teach-app-stop"
        >
          {status.ended === undefined ? t("web.teach.bar.stop") : t("web.teach.bar.review")}
        </button>
      </div>
    );
  }

  if (!rec.picking) return null;
  return (
    <>
      {
        <section
          className="teach-review"
          aria-label={t("web.teach.app.pickTitle")}
          data-testid="teach-app-picker"
        >
          <h2>{t("web.teach.app.pickTitle")}</h2>
          {apps !== null && apps.length === 0 ? (
            <p className="teach-hint" data-testid="teach-app-none">
              {t("web.teach.app.none")}
            </p>
          ) : (
            <label className="teach-field">
              <span>{t("web.teach.app.pickLabel")}</span>
              <select
                value={choice}
                data-testid="teach-app-choice"
                onChange={(e) => rec.setChoice(e.target.value)}
              >
                {(apps ?? []).map((a) => (
                  <option key={a.bundleId} value={a.bundleId}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="teach-hint">{t("web.teach.app.pickHint")}</p>
          <div className="teach-actions">
            <button type="button" className="pill" onClick={rec.close}>
              {t("web.teach.app.cancelPick")}
            </button>
            <button
              type="button"
              className="teach-primary"
              disabled={choice === "" || busy}
              onClick={rec.start}
              data-testid="teach-app-start"
            >
              {t("web.teach.app.start")}
            </button>
          </div>
        </section>
      }
    </>
  );
}
