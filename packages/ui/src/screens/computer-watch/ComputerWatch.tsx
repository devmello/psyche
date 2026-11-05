import type { VscreenApp, VscreenFrame, VscreenInputEvent, VscreenStatus } from "@psyche/protocol";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";

/** The Gateway's `vscreen.*` methods, injected so the pane has no Gateway wiring of its own. */
export interface ComputerWatchClient {
  status(): Promise<VscreenStatus>;
  frame(since: number | undefined, maxWidth?: number): Promise<VscreenFrame>;
  input(events: VscreenInputEvent[]): Promise<void>;
  setTakenOver(on: boolean): Promise<void>;
  stop(): Promise<void>;
}

/** At most 4 frames a second (docs/design/linux-desktop-2026.md §7.5). */
export const FRAME_INTERVAL_MS = 250;
/** The open-apps list and the take-over flag refresh about once a second. */
export const STATUS_INTERVAL_MS = 1000;
/** Pointer moves are forwarded at most this often. */
const MOVE_INTERVAL_MS = 50;
/** `vscreen.input` text events carry at most 1000 characters. */
const TEXT_CHUNK = 1000;
/** The watch view never needs more than this many pixels across. */
const MAX_FRAME_WIDTH = 1280;

export interface ComputerWatchProps {
  client: ComputerWatchClient;
  /** Only a visible pane polls: nothing runs, and nothing costs, while it is hidden. */
  visible: boolean;
  /** Set while a task is parked on an app's "Save changes?" dialog. */
  parked?: boolean;
  /** "Look": the owner wants to see the app that is asking. */
  onLook?: () => void;
  onDiscard?: () => void;
  onKeepOpen?: () => void;
}

interface Shown {
  src: string;
  width: number;
  height: number;
}

const BUTTONS = ["left", "middle", "right"] as const;

/** The Virtual screen watch pane: a live view, Stop, Take over, and the open apps. */
export function ComputerWatch({
  client,
  visible,
  parked,
  onLook,
  onDiscard,
  onKeepOpen,
}: ComputerWatchProps): ReactElement {
  const [docVisible, setDocVisible] = useState(() => document.visibilityState !== "hidden");
  const [status, setStatus] = useState<VscreenStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const seq = useRef<number | undefined>(undefined);
  const toggling = useRef(false);
  const mine = useRef(false);
  const lastMove = useRef(0);
  const active = visible && docVisible;
  const running = status?.state === "running";

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await client.status();
      setStatus(s);
      setFailed(false);
      if (!toggling.current) setTakenOver(s.takenOver);
      if (s.state !== "running") {
        seq.current = undefined;
        setShown(null);
      }
    } catch {
      setFailed(true);
    }
  }, [client]);

  // Status: once a second while the pane is on screen.
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      await refreshStatus();
      if (!stopped) timer = setTimeout(tick, STATUS_INTERVAL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, refreshStatus]);

  // Frames: pulled at up to 4 fps, only while the screen runs and the pane is on screen.
  useEffect(() => {
    if (!active || !running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      const started = Date.now();
      try {
        const f = await client.frame(seq.current, MAX_FRAME_WIDTH);
        if (stopped) return;
        seq.current = f.frameSeq;
        if (f.changed && f.image)
          setShown({ src: `data:image/jpeg;base64,${f.image}`, width: f.width, height: f.height });
      } catch {
        // The next status poll shows the error; a frame is simply tried again.
      }
      if (!stopped)
        timer = setTimeout(tick, Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started)));
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, running, client]);

  // Hiding the pane (or closing it) hands control back: the agent must not stay paused unseen.
  const release = useCallback(() => {
    if (!mine.current) return;
    mine.current = false;
    void client.setTakenOver(false).catch(() => {});
  }, [client]);
  useEffect(() => {
    if (!visible) release();
    return release;
  }, [visible, release]);

  const toggleTakeOver = async () => {
    const on = !takenOver;
    toggling.current = true;
    setTakenOver(on);
    try {
      await client.setTakenOver(on);
      mine.current = on;
    } catch {
      setTakenOver(!on);
    } finally {
      toggling.current = false;
    }
  };

  const stop = async () => {
    try {
      await client.stop();
    } catch {
      // Status shows what is still running.
    }
    mine.current = false;
    await refreshStatus();
  };

  const send = (events: VscreenInputEvent[]) => {
    void client.input(events).catch(() => {});
  };

  /** Displayed-image pixels to the guest screen's pixels. */
  const at = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img || !shown) return null;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.round(((clientX - r.left) / r.width) * shown.width),
      y: Math.round(((clientY - r.top) / r.height) * shown.height),
    };
  };

  const onPointer = (kind: "down" | "up", e: PointerEvent<HTMLElement>) => {
    const p = at(e.clientX, e.clientY);
    if (!p) return;
    if (kind === "down") e.currentTarget.focus();
    send([{ type: kind, ...p, button: BUTTONS[e.button] ?? "left" }]);
  };
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const now = Date.now();
    if (now - lastMove.current < MOVE_INTERVAL_MS) return;
    const p = at(e.clientX, e.clientY);
    if (!p) return;
    lastMove.current = now;
    send([{ type: "move", ...p }]);
  };
  const onWheel = (e: WheelEvent<HTMLElement>) => {
    const p = at(e.clientX, e.clientY);
    if (p) send([{ type: "scroll", ...p, dx: e.deltaX, dy: e.deltaY }]);
  };
  const onKey = (type: "key_down" | "key_up", e: KeyboardEvent<HTMLElement>) => {
    e.preventDefault();
    send([{ type, key: e.key }]);
  };
  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    const events: VscreenInputEvent[] = [];
    for (let i = 0; i < text.length; i += TEXT_CHUNK)
      events.push({ type: "text", text: text.slice(i, i + TEXT_CHUNK) });
    if (events.length > 0) send(events);
  };

  const apps = status?.apps ?? [];
  const unsaved = apps.filter((a) => a.hasUnsavedChanges);

  return (
    <section
      aria-label={t("computerWatch.title")}
      className="flex h-full min-h-0 flex-col gap-3 bg-surface-raised p-3"
    >
      <header className="flex items-center gap-2">
        <h2 className="flex-1 truncate text-callout font-medium text-label-primary">
          {t("computerWatch.title")}
        </h2>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={takenOver}
          disabled={!running}
          onClick={() => void toggleTakeOver()}
        >
          {t("computerWatch.takeOver")}
        </Button>
        <Button variant="destructive" size="sm" disabled={!running} onClick={() => void stop()}>
          {t("computerWatch.stop")}
        </Button>
      </header>

      <p role="status" aria-live="polite" className="text-footnote text-label-secondary">
        {failed
          ? t("computerWatch.error")
          : running
            ? t(takenOver ? "computerWatch.control.you" : "computerWatch.control.agent")
            : status?.state === "starting"
              ? t("computerWatch.starting")
              : ""}
      </p>

      {parked ? (
        <section
          aria-label={t("computerWatch.parked.title")}
          className="flex flex-col gap-2 rounded-md border border-separator-strong p-3"
        >
          <p className="text-callout font-medium text-label-primary">
            {t("computerWatch.parked.title")}
          </p>
          <p className="text-footnote text-label-secondary">{t("computerWatch.parked.body")}</p>
          {unsaved.length > 0 ? (
            <p className="text-footnote text-label-secondary">
              {unsaved.map((a) => a.windowTitle ?? a.appId).join(", ")}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={onLook}>
              {t("computerWatch.parked.look")}
            </Button>
            <Button variant="outline" size="sm" onClick={onDiscard}>
              {t("computerWatch.parked.discard")}
            </Button>
            <Button variant="outline" size="sm" onClick={onKeepOpen}>
              {t("computerWatch.parked.keepOpen")}
            </Button>
          </div>
        </section>
      ) : null}

      {shown && running ? (
        // biome-ignore lint/a11y/useSemanticElements: a focusable region that forwards keys while taken over
        <div
          role="group"
          aria-label={t("computerWatch.frame.alt")}
          tabIndex={takenOver ? 0 : -1}
          className="min-h-0 flex-1 overflow-hidden rounded-md border border-separator-strong bg-black outline-none focus-visible:ring-3 focus-visible:ring-ring"
          {...(takenOver
            ? {
                onPointerDown: (e: PointerEvent<HTMLElement>) => onPointer("down", e),
                onPointerUp: (e: PointerEvent<HTMLElement>) => onPointer("up", e),
                onPointerMove: onMove,
                onWheel,
                onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKey("key_down", e),
                onKeyUp: (e: KeyboardEvent<HTMLElement>) => onKey("key_up", e),
                onPaste,
                onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
              }
            : {})}
        >
          <img
            ref={imgRef}
            src={shown.src}
            alt={t("computerWatch.frame.alt")}
            draggable={false}
            className={`mx-auto h-full w-full object-contain select-none ${takenOver ? "cursor-crosshair" : ""}`}
          />
        </div>
      ) : running ? null : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <p className="text-callout font-medium text-label-primary">
            {t("computerWatch.empty.title")}
          </p>
          <p className="max-w-xs text-footnote text-label-secondary">
            {t("computerWatch.empty.body")}
          </p>
        </div>
      )}

      {running ? <OpenApps apps={apps} /> : null}
    </section>
  );
}

function OpenApps({ apps }: { apps: readonly VscreenApp[] }): ReactElement {
  return (
    <div>
      <h3 className="mb-1 text-caption font-medium text-label-secondary">
        {t("computerWatch.apps.title")}
      </h3>
      {apps.length === 0 ? (
        <p className="text-footnote text-label-tertiary">{t("computerWatch.apps.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {apps.map((a) => (
            <li key={`${a.appId}:${a.pid}`} className="flex items-center gap-2 text-footnote">
              <span className="font-medium text-label-primary">{a.appId}</span>
              {a.windowTitle ? (
                <span className="min-w-0 flex-1 truncate text-label-secondary">
                  {a.windowTitle}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {a.hasUnsavedChanges ? (
                <Badge variant="approval">{t("computerWatch.apps.unsaved")}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
