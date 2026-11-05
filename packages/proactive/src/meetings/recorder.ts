import { PsycheError } from "@psyche/protocol";

/**
 * "Record meeting" (docs/workflows/mail-and-meetings-2026.md §4.6 inputs). Capture never starts
 * on its own: before every recording the owner sees the consent line to say or paste and
 * confirms "I've told everyone". The capture source (the helper's microphone) ends the
 * recording itself after 5 minutes of silence or when the conference app quits.
 */

export const CONSENT_LINE =
  "Quick note: I'm recording this meeting so I can take notes afterwards. Tell me if you'd rather I didn't.";

/**
 * Conference apps (macOS bundle ids) whose quitting ends a Record meeting (§4.6). A browser call
 * has no app of its own to watch, so it ends by silence only.
 */
export const CONFERENCE_APP_BUNDLES: readonly string[] = [
  "us.zoom.xos",
  "com.microsoft.teams2",
  "com.microsoft.teams",
  "com.cisco.webexmeetingsapp",
  "com.apple.FaceTime",
];

/**
 * The same apps on Windows, where the helper names an app by its AppUserModelID or, without one,
 * its executable path (apps/win-helper `apps.list` `bundleId`): the executables and the AUMID
 * package-family prefixes (case-insensitive).
 */
const CONFERENCE_EXES = [
  "zoom.exe",
  "ms-teams.exe",
  "teams.exe",
  "webex.exe",
  "ciscocollabhost.exe",
];
const CONFERENCE_AUMID_PREFIXES = ["msteams_8wekyb3d8bbwe!", "microsoftteams_8wekyb3d8bbwe!"];

/** Whether an app identity (`bundleId` from `apps.list`) is a conference app, Mac or Windows. */
export function isConferenceApp(id: string): boolean {
  if (CONFERENCE_APP_BUNDLES.includes(id)) return true;
  const lower = id.toLowerCase();
  const exe = lower.split(/[\\/]/).pop() ?? "";
  return (
    CONFERENCE_EXES.includes(exe) || CONFERENCE_AUMID_PREFIXES.some((p) => lower.startsWith(p))
  );
}

export interface CapturedAudio {
  path: string;
  startedAt: string;
  durationMs: number;
  reason: "stopped" | "source_ended" | "silence" | "app_quit";
  /** The Library item the capture already wrote (a Gateway-side capture); none for a bare file. */
  itemId?: string;
}

export interface AudioCapture {
  start(): Promise<{
    /** `reason` is why the capturing side stopped (default `stopped`). */
    stop(reason?: CapturedAudio["reason"]): Promise<CapturedAudio>;
    ended: Promise<CapturedAudio>;
  }>;
}

export interface MeetingRecording {
  /** Resolves when the recording ends, by `stop()` or because the source ended. */
  readonly done: Promise<CapturedAudio>;
  stop(reason?: CapturedAudio["reason"]): Promise<CapturedAudio>;
}

export class MeetingRecorder {
  readonly #capture: AudioCapture;
  #active: MeetingRecording | null = null;

  constructor(options: { capture: AudioCapture }) {
    this.#capture = options.capture;
  }

  consentLine(): string {
    return CONSENT_LINE;
  }

  get recording(): boolean {
    return this.#active !== null;
  }

  /** Starts capture only after the owner confirmed they told everyone. */
  async start(input: { consentConfirmed: boolean }): Promise<MeetingRecording> {
    if (input.consentConfirmed !== true) {
      throw new PsycheError(
        "forbidden",
        "Recording starts after you confirm you've told everyone (copy the consent line first).",
      );
    }
    if (this.#active !== null) throw new PsycheError("conflict", "a recording is already running");
    const session = await this.#capture.start();
    let release: (a: CapturedAudio) => void = () => {};
    const stoppedByOwner = new Promise<CapturedAudio>((resolve) => {
      release = resolve;
    });
    const done = Promise.race([session.ended, stoppedByOwner]).finally(() => {
      this.#active = null;
    });
    let stopped: Promise<CapturedAudio> | null = null;
    const recording: MeetingRecording = {
      done,
      stop: (reason) => {
        stopped ??= session.stop(reason).then((a) => {
          release(a);
          return a;
        });
        return stopped;
      },
    };
    this.#active = recording;
    return recording;
  }
}
