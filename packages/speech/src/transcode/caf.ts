import { PsycheError } from "@psyche/protocol";

/**
 * Ogg/Opus → CAF/Opus remuxer (no re-encoding). ffmpeg's CAF muxer refuses Opus
 * (`cafenc.c`: "muxing codec currently unsupported"), and `afconvert` exists only on macOS, so
 * the iMessage voice-bubble container is written here. The chunk layout mirrors what
 * `afconvert -f caff -d opus` produces on macOS 27: `desc`, `kuki`, `chan` (mono), `pakt`,
 * `data`. Opus-in-CAF as the iMessage voice-bubble format is community-reported (research KQ2);
 * Apple documents only "CAF".
 */

export interface OpusStream {
  /** Raw Opus packets in order (no OpusHead / OpusTags). */
  packets: Uint8Array[];
  channels: number;
  /** Encoder delay in 48 kHz samples (OpusHead pre-skip). */
  preSkip: number;
  /** Final granule position (48 kHz samples incl. pre-skip); -1 when unknown. */
  granule: number;
}

const OGG_CAPTURE = 0x5367674f; // "OggS" read little-endian

/** Splits an Ogg/Opus file (first logical stream) into Opus packets. */
export function parseOggOpus(file: Uint8Array): OpusStream {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const packets: Uint8Array[] = [];
  let serial: number | undefined;
  let granule = -1;
  let pending: Uint8Array[] = [];
  let off = 0;
  while (off + 27 <= file.byteLength) {
    if (v.getUint32(off, true) !== OGG_CAPTURE) throw bad("missing OggS capture pattern");
    const pageSerial = v.getUint32(off + 14, true);
    const nsegs = v.getUint8(off + 26);
    const lacing = file.subarray(off + 27, off + 27 + nsegs);
    let body = off + 27 + nsegs;
    if (serial === undefined) serial = pageSerial;
    const mine = pageSerial === serial;
    if (mine) {
      const g = v.getBigInt64(off + 6, true);
      if (g >= 0n) granule = Number(g);
    }
    for (const lace of lacing) {
      if (body + lace > file.byteLength) throw bad("truncated Ogg page");
      if (mine) pending.push(file.subarray(body, body + lace));
      body += lace;
      if (lace < 255 && mine) {
        packets.push(join(pending));
        pending = [];
      }
    }
    off = body;
  }
  const [head, tags, ...audio] = packets;
  if (head === undefined || !startsWith(head, "OpusHead") || head.byteLength < 19) {
    throw bad("not an Ogg/Opus stream");
  }
  if (tags === undefined || !startsWith(tags, "OpusTags")) throw bad("missing OpusTags");
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return {
    packets: audio,
    channels: hv.getUint8(9),
    preSkip: hv.getUint16(10, true),
    granule,
  };
}

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 0;
  const config = toc >> 3;
  let frame: number;
  if (config < 12) frame = [480, 960, 1920, 2880][config % 4] as number;
  else if (config < 16) frame = config % 2 === 0 ? 480 : 960;
  else frame = [120, 240, 480, 960][config % 4] as number;
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frame * count;
}

/** Writes Opus packets into a CAF file shaped like afconvert's output. */
export function opusToCaf(stream: OpusStream): Uint8Array {
  if (stream.packets.length === 0) throw bad("no Opus packets to remux");
  const sizes = stream.packets.map((p) => p.byteLength);
  const frames = stream.packets.map(opusPacketSamples);
  const constant = frames.every((f) => f === frames[0]) ? (frames[0] ?? 0) : 0;
  const total = frames.reduce((a, b) => a + b, 0);
  const valid =
    stream.granule >= 0
      ? Math.max(0, Math.min(total - stream.preSkip, stream.granule - stream.preSkip))
      : total - stream.preSkip;
  const remainder = total - stream.preSkip - valid;

  const parts: Uint8Array[] = [];
  const header = new Uint8Array(8);
  ascii(header, 0, "caff");
  new DataView(header.buffer).setUint16(4, 1);
  parts.push(header);

  const desc = new DataView(new ArrayBuffer(32));
  desc.setFloat64(0, 48_000);
  ascii(new Uint8Array(desc.buffer), 8, "opus");
  desc.setUint32(12, 0); // format flags
  desc.setUint32(16, 0); // bytes per packet (variable)
  desc.setUint32(20, constant); // frames per packet (0 = listed in pakt)
  desc.setUint32(24, stream.channels);
  desc.setUint32(28, 0);
  parts.push(chunk("desc", new Uint8Array(desc.buffer)));

  // Magic cookie as afconvert writes it: application (VOIP), rate, frame size, bitrate (auto),
  // channels, two reserved words.
  const kuki = new DataView(new ArrayBuffer(28));
  kuki.setInt32(0, 2048);
  kuki.setInt32(4, 48_000);
  kuki.setInt32(8, constant === 0 ? 960 : constant);
  kuki.setInt32(12, -1000);
  kuki.setInt32(16, stream.channels);
  parts.push(chunk("kuki", new Uint8Array(kuki.buffer)));

  if (stream.channels <= 2) {
    const chan = new DataView(new ArrayBuffer(12));
    // kAudioChannelLayoutTag_Mono = (100 << 16) | 1, _Stereo = (101 << 16) | 2
    chan.setUint32(0, stream.channels === 1 ? (100 << 16) | 1 : (101 << 16) | 2);
    parts.push(chunk("chan", new Uint8Array(chan.buffer)));
  }

  const table: number[] = [];
  for (let i = 0; i < sizes.length; i++) {
    table.push(...varint(sizes[i] as number));
    if (constant === 0) table.push(...varint(frames[i] as number));
  }
  const pakt = new Uint8Array(24 + table.length);
  const pv = new DataView(pakt.buffer);
  pv.setBigInt64(0, BigInt(sizes.length));
  pv.setBigInt64(8, BigInt(valid));
  pv.setInt32(16, stream.preSkip);
  pv.setInt32(20, remainder);
  pakt.set(table, 24);
  parts.push(chunk("pakt", pakt));

  const data = new Uint8Array(4 + sizes.reduce((a, b) => a + b, 0));
  new DataView(data.buffer).setUint32(0, 1); // edit count
  let off = 4;
  for (const p of stream.packets) {
    data.set(p, off);
    off += p.byteLength;
  }
  parts.push(chunk("data", data));
  return join(parts);
}

export function oggOpusToCaf(file: Uint8Array): Uint8Array {
  return opusToCaf(parseOggOpus(file));
}

/** CAF variable-length integer: 7 bits per byte, big-endian, high bit = more bytes follow. */
function varint(n: number): number[] {
  const out = [n & 0x7f];
  let rest = Math.floor(n / 128);
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  ascii(out, 0, type);
  new DataView(out.buffer).setBigInt64(4, BigInt(body.byteLength));
  out.set(body, 12);
  return out;
}

function ascii(buf: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
}

function startsWith(buf: Uint8Array, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (buf[i] !== s.charCodeAt(i)) return false;
  return true;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function bad(message: string): PsycheError {
  return new PsycheError("invalid_params", `caf remux: ${message}`);
}
