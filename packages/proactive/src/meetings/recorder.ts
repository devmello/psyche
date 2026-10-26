import { PsycheError } from "@psyche/protocol";

/**
 * "Record meeting" (docs/workflows/mail-and-meetings-2026.md §4.6 inputs). Capture never starts
 * on its own: before every recording the owner sees the consent line to say or paste and
 * confirms "I've told everyone". The capture source (the helper's microphone) ends the
 * recording itself after 5 minutes of silence or when the conference app quits.
 */

export const CONSENT_LINE =
  "Quick note: I'm recording this meeting so I can take notes afterwards. Tell me if you'd rather I didn't.";

export interface CapturedAudio {
  path: string;
  startedAt: string;
  durationMs: number;
  reason: "stopped" | "source_ended" | "silence" | "app_quit";
}

export interface AudioCapture {
  start(): Promise<{ stop(): Promise<CapturedAudio>; ended: Promise<CapturedAudio> }>;
}

export interface MeetingRecording {
  /** Resolves when the recording ends, by `stop()` or because the source ended. */
  readonly done: Promise<CapturedAudio>;
  stop(): Promise<CapturedAudio>;
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
      stop: () => {
        stopped ??= session.stop().then((a) => {
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
