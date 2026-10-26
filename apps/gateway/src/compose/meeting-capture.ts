import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { insertLibraryItem, type PsycheDb } from "@psyche/db";
import type { AudioCapture, CapturedAudio } from "@psyche/proactive";
import type { Clock } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { ulid } from "ulid";

/**
 * Meeting audio captured by the owner's device (the desktop or web shell's microphone) and pushed
 * to the Gateway as 16 kHz mono PCM chunks (`meetings.record.push`, docs/workflows/
 * mail-and-meetings-2026.md §4.6). The Gateway keeps it as a WAV file in the Library
 * (`library/audio/<id>.wav`, 0600), so the helper's `speech.transcribe_file` or any other
 * transcriber that reads a file can use it where it lies, and nothing is held in memory.
 */

export const CAPTURE_SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = CAPTURE_SAMPLE_RATE * 2;
const HEADER_BYTES = 44;
/** Notes work up to 4 hours (§4.6); a recording that long ends itself. */
export const CAPTURE_MAX_MS = 4 * 60 * 60_000;

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(CAPTURE_SAMPLE_RATE, 24);
  h.writeUInt32LE(BYTES_PER_SECOND, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

interface Session {
  id: string;
  rel: string;
  path: string;
  file: FileHandle;
  startedAt: string;
  bytes: number;
  nextSeq: number;
  finish: (reason: CapturedAudio["reason"]) => Promise<CapturedAudio>;
  ended: (a: CapturedAudio) => void;
}

export class ClientAudioCapture implements AudioCapture {
  readonly #db: PsycheDb;
  readonly #library: string;
  readonly #clock: Clock;
  readonly #maxBytes: number;
  #session: Session | null = null;

  constructor(options: { db: PsycheDb; home: string; clock: Clock; maxMs?: number }) {
    this.#db = options.db;
    this.#library = join(options.home, "library");
    this.#clock = options.clock;
    this.#maxBytes = Math.floor(((options.maxMs ?? CAPTURE_MAX_MS) / 1000) * BYTES_PER_SECOND);
  }

  async start() {
    if (this.#session !== null) throw new PsycheError("conflict", "a recording is already running");
    const id = ulid();
    const rel = join("audio", `${id}.wav`);
    const path = join(this.#library, rel);
    await mkdir(join(this.#library, "audio"), { recursive: true, mode: 0o700 });
    const file = await open(path, "w", 0o600);
    await chmod(path, 0o600);
    await file.write(wavHeader(0), 0, HEADER_BYTES, 0);
    const startedAt = new Date(this.#clock.now()).toISOString();
    let end: (a: CapturedAudio) => void = () => {};
    const ended = new Promise<CapturedAudio>((resolve) => {
      end = resolve;
    });
    let finishing: Promise<CapturedAudio> | null = null;
    const session: Session = {
      id,
      rel,
      path,
      file,
      startedAt,
      bytes: 0,
      nextSeq: 0,
      ended: end,
      finish: (reason) => {
        finishing ??= this.#finalize(session, reason);
        return finishing;
      },
    };
    this.#session = session;
    return {
      ended,
      stop: (reason: CapturedAudio["reason"] = "stopped") => session.finish(reason),
    };
  }

  /** One chunk of mono PCM s16le at 16 kHz, in order. Past the length cap the recording ends. */
  async push(seq: number, pcm: Buffer): Promise<void> {
    const s = this.#session;
    if (s === null) throw new PsycheError("conflict", "no recording is running");
    if (seq !== s.nextSeq) {
      throw new PsycheError("invalid_params", `expected chunk ${s.nextSeq}, got ${seq}`);
    }
    if (pcm.length === 0 || pcm.length % 2 !== 0) {
      throw new PsycheError("invalid_params", "audio must be whole 16-bit samples");
    }
    const room = this.#maxBytes - s.bytes;
    const take = Math.min(pcm.length, room - (room % 2));
    if (take > 0) await s.file.write(pcm, 0, take, HEADER_BYTES + s.bytes);
    s.bytes += take;
    s.nextSeq += 1;
    if (take < pcm.length || s.bytes >= this.#maxBytes) {
      s.ended(await s.finish("stopped"));
    }
  }

  async #finalize(s: Session, reason: CapturedAudio["reason"]): Promise<CapturedAudio> {
    if (this.#session === s) this.#session = null;
    await s.file.write(wavHeader(s.bytes), 0, HEADER_BYTES, 0);
    await s.file.close();
    if (s.bytes === 0) {
      await rm(s.path, { force: true });
      throw new PsycheError("invalid_params", "nothing was recorded");
    }
    const durationMs = Math.round((s.bytes / BYTES_PER_SECOND) * 1000);
    const day = s.startedAt.slice(0, 16).replace("T", " ");
    try {
      insertLibraryItem(this.#db, {
        id: s.id,
        kind: "recording",
        name: `Meeting ${day}.wav`,
        mime: "audio/wav",
        path: s.rel,
        size: HEADER_BYTES + s.bytes,
        sha256: await sha256Of(s.path),
        origin: "upload",
        tags: ["recording", "meeting"],
        // Other people's words (§3 rule 3): quarantined like any meeting recording.
        quarantined: true,
        createdAt: s.startedAt,
      });
    } catch (err) {
      await rm(s.path, { force: true }).catch(() => undefined);
      throw err;
    }
    return { path: s.path, startedAt: s.startedAt, durationMs, reason, itemId: s.id };
  }
}
