import { t } from "@psyche/ui";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../context.tsx";
import { MeetingRecorderClient, type MeetingRecordView } from "../meeting-record.ts";
import type { ShellStore } from "../store.ts";
import { useDialogFocus } from "./Overlays.tsx";

/**
 * Record meeting in the shell (§4.6): the consent dialog and the recording pill. Anything can
 * ask for the dialog with `requestRecordMeeting(meetingId?)` (the prep card, the toolbar's ⋯
 * menu); nothing records until the owner confirms "I've told everyone".
 */

export const RECORD_MEETING_EVENT = "psyche:record-meeting";

/** Opens the consent dialog; `meetingId` is the calendar event the recording starts from. */
export function requestRecordMeeting(meetingId?: string): void {
  document.dispatchEvent(
    new CustomEvent(RECORD_MEETING_EVENT, { detail: meetingId === undefined ? {} : { meetingId } }),
  );
}

const clients = new WeakMap<ShellStore, MeetingRecorderClient>();

/** One client per shell store, so every caller sees the same recording. */
export function meetingRecorder(store: ShellStore): MeetingRecorderClient {
  let client = clients.get(store);
  if (client === undefined) {
    client = new MeetingRecorderClient({ call: (m, p) => store.call(m, p) });
    clients.set(store, client);
  }
  return client;
}

export function useMeetingRecorder(): {
  view: MeetingRecordView;
  client: MeetingRecorderClient;
} {
  const { store } = useShell();
  const client = useMemo(() => meetingRecorder(store), [store]);
  const [view, setView] = useState(client.view);
  useEffect(() => {
    setView(client.view);
    const off = client.subscribe(setView);
    // Every device sees a recording start and end; a stop from another one releases this mic.
    const offEvents = store.tap((e) => {
      if (e.event === "meetings.recording.updated") {
        client.apply(e.payload as Parameters<MeetingRecorderClient["apply"]>[0]);
      }
    });
    const onRequest = (e: Event) =>
      void client.request((e as CustomEvent<{ meetingId?: string }>).detail?.meetingId);
    document.addEventListener(RECORD_MEETING_EVENT, onRequest);
    return () => {
      off();
      offEvents();
      document.removeEventListener(RECORD_MEETING_EVENT, onRequest);
    };
  }, [client, store]);
  return { view, client };
}

function elapsed(startedAt: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${ss}` : `${m}:${ss}`;
}

export function MeetingRecord(): ReactElement | null {
  const { view, client } = useMeetingRecorder();
  const rec = view.recording;
  return (
    <>
      {rec.phase === "consent" ? (
        <ConsentDialog
          line={rec.consentLine}
          onConfirm={() => void client.confirm()}
          onCancel={() => client.cancel()}
        />
      ) : null}
      {rec.phase === "recording" || rec.phase === "stopping" || rec.phase === "starting" ? (
        <RecordingPill view={view} onStop={() => void client.stop()} />
      ) : null}
      {view.error ? (
        <div role="alert" className="pill" data-testid="meeting-record-error">
          {t(`meetingRecord.${view.error}`)}
        </div>
      ) : null}
      {rec.phase === "idle" && view.notes?.notes === "processing" ? (
        <div role="status" className="pill" data-testid="meeting-record-notes">
          {t("meetingRecord.notes.processing")}
        </div>
      ) : null}
    </>
  );
}

function ConsentDialog(props: {
  line: string;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useDialogFocus(dialog, props.onCancel);
  const copy = () => {
    void navigator.clipboard?.writeText(props.line).then(() => setCopied(true));
  };
  return (
    // biome-ignore lint/a11y: backdrop click closes; Esc closes through useDialogFocus
    <div className="overlay" onClick={props.onCancel} data-testid="meeting-record-consent">
      {/* biome-ignore lint/a11y: stops the backdrop click */}
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="psyche-record-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="psyche-record-title" style={{ marginTop: 0 }}>
          {t("meetingRecord.title")}
        </h2>
        <p>{t("meetingRecord.intro")}</p>
        <blockquote data-testid="meeting-record-line">{props.line}</blockquote>
        <p>{t("meetingRecord.privacy")}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="pill" onClick={copy}>
            {copied ? t("meetingRecord.copied") : t("meetingRecord.copy")}
          </button>
          <button type="button" className="pill" onClick={props.onCancel}>
            {t("meetingRecord.cancel")}
          </button>
          <button type="button" className="pill" onClick={props.onConfirm}>
            {t("meetingRecord.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The visible recording indicator: it is on screen for as long as the microphone is open. */
function RecordingPill(props: { view: MeetingRecordView; onStop: () => void }): ReactElement {
  const rec = props.view.recording;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const time = rec.phase === "recording" ? elapsed(rec.startedAt, now) : "0:00";
  return (
    <div role="status" className="pill" data-testid="meeting-record-pill">
      <span aria-hidden="true" style={{ color: "var(--destructive, #d33)" }}>
        ●
      </span>{" "}
      {t("meetingRecord.pill", { time })}
      <button
        type="button"
        className="pill"
        onClick={props.onStop}
        disabled={rec.phase !== "recording"}
      >
        {rec.phase === "stopping" ? t("meetingRecord.stopping") : t("meetingRecord.stop")}
      </button>
    </div>
  );
}
