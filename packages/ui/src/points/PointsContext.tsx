import type { PointsEntry, PointsWindow } from "@psyche/protocol";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { useCall, useSettings } from "../data/hooks.ts";
import { useHostOs } from "../data/host-os.ts";
import { useStore } from "../data/provider.tsx";
import { activeI18n, t } from "../i18n/core.ts";
import type { TccPermission } from "../screens/settings/types.ts";
import { type PointsHelperState, usePersona, useSlots } from "../slots.tsx";
import { pointsCardStrings } from "./card-strings.ts";
import { HelperPermissionRow } from "./HelperPermissionRow.tsx";
import { POINTS_ENABLED_KEY } from "./PointsSettings.tsx";
import {
  POINTS_GOAL_MAX,
  type PointsSessionView,
  PointsStartSheet,
  type PointsWindowList,
} from "./PointsStartSheet.tsx";

/** What opens the start sheet. */
export interface PointsOpenOptions {
  entry: PointsEntry;
  /** The goal the sheet starts with (the Chat offer card's text, or whatever ⌘K was typed with). */
  goal?: string;
  /** `offer`: the goal is the agent's `points_offer` text, passed on unedited. */
  goalSource?: "owner" | "offer";
  threadId?: string;
  /** A window ref to preselect (the tray's "window behind"); used only when it is still listed. */
  window?: string;
}

export interface PointsApi {
  /**
   * Psyche points may be offered here: a Mac Host's own desktop (not a window onto another
   * Gateway) with the helper's permission port, and `points.enabled` on. Nothing is offered
   * otherwise: the palette action, the offer card's button and the sheet all stay away.
   */
  available: boolean;
  open: (options: PointsOpenOptions) => void;
  close: () => void;
}

const UNAVAILABLE: PointsApi = { available: false, open: () => {}, close: () => {} };

const PointsContext = createContext<PointsApi>(UNAVAILABLE);

/** The Points entry points of this window; inert without a provider. */
export function usePoints(): PointsApi {
  return useContext(PointsContext);
}

const helperGranted = (s: PointsHelperState | undefined, p: "accessibility" | "screenRecording") =>
  s?.helper === "online" && s[p] === "granted";

/**
 * Owns the start sheet and the session's state for one window (docs/design/psyche-points-2026.md
 * §6). It calls only `points.windows`, `points.start`, `points.stop` and `points.status`; the
 * desktop shell's own channel is what lets those through (the Gateway refuses anyone else), so a
 * window onto another Mac's Gateway has no port and shows none of this.
 */
export function PointsProvider({
  children,
  provider,
  local,
}: {
  children?: ReactNode;
  /** The primary model's provider, for the data line. */
  provider?: string;
  local?: boolean;
}): ReactElement {
  const { points: port, remoteHost } = useSlots();
  const hostOs = useHostOs();
  const { settings } = useSettings();
  const call = useCall();
  const store = useStore();
  const persona = usePersona();
  const available =
    port !== undefined &&
    remoteHost === undefined &&
    hostOs === "macos" &&
    settings[POINTS_ENABLED_KEY] === true;

  const [request, setRequest] = useState<PointsOpenOptions | null>(null);
  const [list, setList] = useState<PointsWindowList>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [helper, setHelper] = useState<PointsHelperState | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [session, setSession] = useState<(PointsSessionView & { id: string }) | undefined>(
    undefined,
  );
  const [needsScreen, setNeedsScreen] = useState(false);
  const preselect = useRef<string | undefined>(undefined);

  const open = useCallback(
    (options: PointsOpenOptions) => {
      if (!available) return;
      preselect.current = options.window;
      setGoal((options.goal ?? "").slice(0, POINTS_GOAL_MAX));
      setSelected(null);
      setFailed(false);
      setStarting(false);
      setList({ status: "loading" });
      setRequest(options);
    },
    [available],
  );
  const close = useCallback(() => setRequest(null), []);
  // Turning the feature off, or this window becoming a remote one, closes everything.
  useEffect(() => {
    if (available) return;
    setRequest(null);
    setNeedsScreen(false);
  }, [available]);

  const loadWindows = useCallback(() => {
    setList({ status: "loading" });
    call("points.windows", {}).then(
      ({ windows }) => {
        setList({ status: "ready", windows });
        const wanted = windows.find((w) => w.ref === preselect.current && w.refusal === undefined);
        setSelected((cur) => cur ?? wanted?.ref ?? null);
      },
      () => setList({ status: "error" }),
    );
  }, [call]);

  const readHelper = useCallback(() => {
    port?.helperStatus().then(setHelper, () => setHelper({ ...OFFLINE }));
  }, [port]);

  // While the sheet is open: the window list, the helper's grants (re-read on focus, since the
  // owner comes back from System Settings) and whether a session already runs.
  const isOpen = request !== null && available;
  useEffect(() => {
    if (!isOpen) return;
    loadWindows();
    readHelper();
    call("points.status", {}).then(
      ({ session: s }) =>
        setSession(
          s === undefined
            ? undefined
            : { id: s.sessionId, app: s.app.name, state: s.state, step: s.step, of: s.of },
        ),
      () => undefined,
    );
    window.addEventListener("focus", readHelper);
    return () => window.removeEventListener("focus", readHelper);
  }, [isOpen, loadWindows, readHelper, call]);

  // The session's state comes from `points.updated`, which only the starting device receives.
  useEffect(
    () =>
      store.client.subscribe((e) => {
        if (e.event !== "points.updated") return;
        const p = e.payload;
        if (p.needs === "screenRecording") {
          setNeedsScreen(true);
          readHelper();
        }
        if (p.state === "ended") {
          setSession(undefined);
          return;
        }
        setSession((cur) =>
          cur === undefined || cur.id !== p.sessionId
            ? cur
            : { ...cur, state: p.state, step: p.step, of: p.of },
        );
      }),
    [store, readHelper],
  );

  const start = useCallback(() => {
    if (request === null || selected === null || starting) return;
    const text = goal.trim();
    const unedited =
      request.goalSource === "offer" && request.goal !== undefined && text === request.goal.trim();
    setStarting(true);
    setFailed(false);
    call("points.start", {
      window: selected,
      ...(text === "" ? {} : { goal: text, goalSource: unedited ? "offer" : "owner" }),
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      entry: request.entry,
      locale: activeI18n().messageLocale,
      strings: pointsCardStrings(),
    }).then(
      (r) => {
        setStarting(false);
        setSession({ id: r.sessionId, app: r.app.name, state: "reading", step: 0, of: 0 });
        setRequest(null);
      },
      () => {
        setStarting(false);
        setFailed(true);
      },
    );
  }, [request, selected, starting, goal, call]);

  const stop = useCallback(() => {
    if (session === undefined) return;
    call("points.stop", { sessionId: session.id }).then(
      () => setSession(undefined),
      () => undefined,
    );
  }, [session, call]);

  const allow = useCallback(
    (kind: "accessibility" | "screenRecording") => {
      port?.helperRequest(kind).then(setHelper, readHelper);
    },
    [port, readHelper],
  );

  const api = useMemo<PointsApi>(() => ({ available, open, close }), [available, open, close]);

  const accessibility =
    helper === undefined || helperGranted(helper, "accessibility")
      ? undefined
      : {
          state: helper.accessibility,
          offline: helper.helper === "offline",
          onAllow: (p: TccPermission) => {
            if (p === "accessibility") allow("accessibility");
          },
        };
  const stateKnown = helper !== undefined;

  return (
    <PointsContext.Provider value={api}>
      {children}
      {available ? (
        <>
          <PointsStartSheet
            open={isOpen}
            onOpenChange={(o) => {
              if (!o) setRequest(null);
            }}
            list={list}
            onRetry={loadWindows}
            selected={selected}
            onSelect={setSelected}
            goal={goal}
            onGoal={setGoal}
            {...(stateKnown && accessibility ? { accessibility } : {})}
            persona={persona.name}
            {...(provider === undefined ? {} : { provider })}
            {...(local ? { local } : {})}
            checking={!stateKnown}
            starting={starting}
            failed={failed}
            onStart={start}
            {...(session ? { session } : {})}
            onStopSession={stop}
          />
          <ScreenRecordingSheet
            open={needsScreen}
            onClose={() => setNeedsScreen(false)}
            state={helper?.screenRecording ?? "not_determined"}
            offline={helper?.helper === "offline"}
            persona={persona.name}
            onAllow={() => allow("screenRecording")}
          />
        </>
      ) : null}
    </PointsContext.Provider>
  );
}

const OFFLINE: PointsHelperState = {
  helper: "offline",
  accessibility: "not_determined",
  screenRecording: "not_determined",
};

/**
 * `points.updated {needs: "screenRecording"}`: Let Psyche look found the helper without Screen
 * Recording. The same row as Settings → Computer use, in a small sheet of Psyche's own.
 */
function ScreenRecordingSheet({
  open,
  onClose,
  state,
  offline,
  persona,
  onAllow,
}: {
  open: boolean;
  onClose: () => void;
  state: "granted" | "denied" | "not_determined";
  offline: boolean;
  persona: string;
  onAllow: () => void;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="points-screen-sheet" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("points.needs.screenRecording.title")}</DialogTitle>
          <DialogDescription>{t("points.needs.screenRecording.hint")}</DialogDescription>
        </DialogHeader>
        <HelperPermissionRow
          permission="screenRecording"
          state={state}
          persona={persona}
          offline={offline}
          onAllow={onAllow}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("points.needs.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { PointsWindow };
