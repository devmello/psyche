import { type ReactElement, useEffect, useRef, useState } from "react";

/**
 * The system-wide dictation HUD (features J9, Q2; UI design §3.18). It runs in a non-focusable
 * panel at `/dictation-hud`: it shows what main tells it (listening / partial text / a short
 * message) and, on `start`, captures the microphone and streams 16 kHz mono PCM s16le chunks of
 * ~100 ms back to main as base64. Audio never touches disk.
 */

type HudState =
  | { phase: "listening"; app: string; text: string }
  | { phase: "finishing"; app: string; text: string }
  | { phase: "message"; text: string }
  | null;

const RATE = 16_000;

/** Averages Float32 [-1, 1] input down to 16 kHz Int16. */
export function toPcm16(input: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / RATE;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    const v = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : 0));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** What getUserMedia + Web Audio hand back, narrowed so tests can fake them. */
export interface MicDevices {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): AudioContext;
}

const browserDevices: MicDevices = {
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  createContext: () => new AudioContext(),
};

/**
 * One microphone session at a time (issue #611: the orange indicator stayed on). Each start gets
 * a generation; a stop, or a newer start, bumps it, so a start still waiting for getUserMedia
 * drops the stream it receives instead of keeping it. `release` is idempotent and stops every
 * track, disconnects both nodes and closes the context on every exit path.
 */
export class Capture {
  readonly #devices: MicDevices;
  #gen = 0;
  #stream: MediaStream | undefined;
  #ctx: AudioContext | undefined;
  #nodes: AudioNode[] = [];
  #processor: ScriptProcessorNode | undefined;
  #buf: Int16Array[] = [];
  #samples = 0;
  #send: ((chunk: string) => void) | undefined;

  constructor(devices: MicDevices = browserDevices) {
    this.#devices = devices;
  }

  /** Whether any microphone track is still live (what macOS shows as the orange dot). */
  get open(): boolean {
    return this.#stream?.getTracks().some((t) => t.readyState === "live") ?? false;
  }

  async start(send: (chunk: string) => void): Promise<void> {
    this.release();
    const gen = ++this.#gen;
    const stream = await this.#devices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (gen !== this.#gen) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error("stopped before the microphone opened");
    }
    this.#stream = stream;
    this.#send = send;
    try {
      const ctx = this.#devices.createContext();
      this.#ctx = ctx;
      await ctx.resume();
      if (gen !== this.#gen) throw new Error("stopped before the microphone opened");
      const input = ctx.createMediaStreamSource(stream);
      // ScriptProcessor keeps this free of worklet module URLs (the CSP allows 'self' scripts only).
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (ev) => {
        const pcm = toPcm16(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
        this.#buf.push(pcm);
        this.#samples += pcm.length;
        if (this.#samples >= RATE / 10) this.#flush();
      };
      input.connect(node);
      node.connect(ctx.destination);
      this.#nodes = [input, node];
      this.#processor = node;
    } catch (err) {
      if (gen === this.#gen) this.release();
      throw err;
    }
  }

  #flush(): void {
    if (this.#samples === 0 || !this.#send) return;
    const out = new Int16Array(this.#samples);
    let o = 0;
    for (const b of this.#buf) {
      out.set(b, o);
      o += b.length;
    }
    this.#buf = [];
    this.#samples = 0;
    this.#send(pcmToBase64(out));
  }

  /** Ends the session: the last audio goes out, then every resource is released. */
  stop(): void {
    this.#flush();
    this.release();
  }

  /** Releases everything without sending audio; safe to call any number of times. */
  release(): void {
    this.#gen++;
    if (this.#processor) this.#processor.onaudioprocess = null;
    this.#processor = undefined;
    for (const n of this.#nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.#nodes = [];
    for (const t of this.#stream?.getTracks() ?? []) t.stop();
    this.#stream = undefined;
    const ctx = this.#ctx;
    this.#ctx = undefined;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
    this.#buf = [];
    this.#samples = 0;
    this.#send = undefined;
  }
}

export function DictationHud(): ReactElement | null {
  const [state, setState] = useState<HudState>(null);
  const capture = useRef(new Capture());

  useEffect(() => {
    const bridge = window.psyche.dictation;
    const mic = capture.current;
    const offState = bridge.onState((s) => setState(s as HudState));
    const offCapture = bridge.onCapture((raw) => {
      const cmd = raw as { command?: unknown; id?: unknown } | null;
      if (typeof cmd?.id !== "number") return;
      const id = cmd.id;
      if (cmd.command === "start") {
        mic
          .start((chunk) => bridge.sendAudio(chunk))
          .then(
            () => bridge.captured({ id, ok: true, open: mic.open }),
            () => bridge.captured({ id, ok: false, open: mic.open }),
          );
      } else if (cmd.command === "stop") {
        mic.stop();
        bridge.captured({ id, ok: true, open: mic.open });
      }
    });
    const onHide = () => mic.release();
    window.addEventListener("pagehide", onHide);
    return () => {
      offState();
      offCapture();
      window.removeEventListener("pagehide", onHide);
      mic.release();
    };
  }, []);

  if (!state) return null;
  const listening = state.phase === "listening";
  const label =
    state.phase === "message"
      ? state.text
      : state.text || (listening ? `Listening… into ${state.app}` : "Finishing…");
  return (
    <output
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: "100vh",
        boxSizing: "border-box",
        padding: "0 16px",
        borderRadius: 14,
        background: "rgba(24, 24, 27, 0.92)",
        color: "#f4f4f5",
        font: "13px/1.3 -apple-system, BlinkMacSystemFont, sans-serif",
        overflow: "hidden",
      }}
    >
      {state.phase === "message" ? null : (
        <span
          aria-hidden
          style={{
            flex: "none",
            width: 10,
            height: 10,
            borderRadius: 5,
            background: listening ? "#ef4444" : "#a1a1aa",
          }}
        />
      )}
      <span
        style={{
          flex: 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          direction: "rtl",
          textAlign: "left",
        }}
      >
        <bdi>{label}</bdi>
      </span>
    </output>
  );
}
