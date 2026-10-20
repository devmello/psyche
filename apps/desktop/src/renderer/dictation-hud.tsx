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

class Capture {
  #stop: (() => void) | undefined;
  #buf: Int16Array[] = [];
  #samples = 0;

  async start(send: (chunk: string) => void): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    const ctx = new AudioContext();
    await ctx.resume();
    const input = ctx.createMediaStreamSource(stream);
    // ScriptProcessor keeps this free of worklet module URLs (the CSP allows 'self' scripts only).
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (ev) => {
      const pcm = toPcm16(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
      this.#buf.push(pcm);
      this.#samples += pcm.length;
      if (this.#samples >= RATE / 10) this.#flush(send);
    };
    input.connect(node);
    node.connect(ctx.destination);
    this.#stop = () => {
      node.disconnect();
      input.disconnect();
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
      this.#flush(send);
    };
  }

  #flush(send: (chunk: string) => void): void {
    if (this.#samples === 0) return;
    const out = new Int16Array(this.#samples);
    let o = 0;
    for (const b of this.#buf) {
      out.set(b, o);
      o += b.length;
    }
    this.#buf = [];
    this.#samples = 0;
    send(pcmToBase64(out));
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }
}

export function DictationHud(): ReactElement | null {
  const [state, setState] = useState<HudState>(null);
  const capture = useRef(new Capture());

  useEffect(() => {
    const bridge = window.psyche.dictation;
    const offState = bridge.onState((s) => setState(s as HudState));
    const offCapture = bridge.onCapture((command) => {
      if (command === "start") {
        capture.current
          .start((chunk) => bridge.sendAudio(chunk))
          .then(
            () => bridge.captured(true),
            () => bridge.captured(false),
          );
      } else if (command === "stop") {
        capture.current.stop();
        bridge.captured(true);
      }
    });
    return () => {
      offState();
      offCapture();
      capture.current.stop();
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
