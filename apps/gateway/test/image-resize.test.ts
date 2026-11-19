import { deflateSync } from "node:zlib";
import { imageSize, normalizeToolOutput } from "@psyche/agent-core";
import { describe, expect, it } from "vitest";
import {
  downscaleImage,
  reencodeToolImage,
  windowsPowerShell,
} from "../src/session/image-resize.ts";

/** A solid-colour PNG of the given size, built by hand (no image library in the Gateway). */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG with a valid signature and IHDR over a garbage body (PR #1397 review round 2, P1). */
function corruptPng(width: number, height: number): Buffer {
  const good = png(width, height);
  const out = Buffer.alloc(4_000);
  good.copy(out, 0, 0, 33);
  for (let i = 33; i < out.length; i++) out[i] = (i * 31) & 0xff;
  return out;
}

/** Only a PNG signature and IHDR claiming the size (a 2 KB file can claim 60000x60000). */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(2_000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Whether `@napi-rs/canvas` loads on this runner (the Linux path needs it). */
const canvas = await import("@napi-rs/canvas").catch(() => undefined);

/**
 * PR #1397 review round 3: a real JPEG behind `FFD8 FF00 0100` and a COM segment hiding a fake
 * 100x100 SOF where a lenient header walk lands; the decoder reads the real SOF.
 */
function hiddenSof(real: Buffer): Buffer {
  const com = Buffer.alloc(2 + 512, 0x20);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(512, 2);
  const b = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x00]),
    com,
    real.subarray(2),
  ]);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0x64, 0x03]).copy(b, 260);
  return b;
}

describe("reencodeToolImage: decompression bombs", () => {
  it("refuses a header over the caps before any decoder runs, on every platform", async () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      await expect(
        reencodeToolImage(pngHeader(60_000, 60_000), "image/png", 1568, platform),
      ).rejects.toThrow("too large");
      await expect(
        reencodeToolImage(pngHeader(7_000, 7_000), "image/png", 1568, platform),
      ).rejects.toThrow("too large");
    }
  });

  it.runIf(canvas !== undefined)(
    "the hidden-SOF JPEG never reaches the canvas decoder as an image",
    async () => {
      const real = (canvas as typeof import("@napi-rs/canvas"))
        .createCanvas(300, 200)
        .encodeSync("jpeg", 80);
      const crafted = hiddenSof(real);
      expect(imageSize(crafted)).toBeUndefined();
      await expect(reencodeToolImage(crafted, "image/jpeg", 1568, "linux")).rejects.toThrow();
      const seen: string[] = [];
      const out = await normalizeToolOutput(
        { blocks: [{ type: "image", data: crafted.toString("base64"), mimeType: "image/jpeg" }] },
        {
          shaper: (b, m) => {
            seen.push(m);
            return reencodeToolImage(b, m, 1568, "linux");
          },
        },
      );
      expect(out).toEqual([
        { type: "text", text: "[image omitted: not a PNG, JPEG, GIF or WebP image]" },
      ]);
      expect(seen).toEqual([]);
      // The same frame without the trick goes through the canvas path as an image.
      const ok = await normalizeToolOutput(
        { blocks: [{ type: "image", data: real.toString("base64"), mimeType: "image/jpeg" }] },
        { shaper: (b, m) => reencodeToolImage(b, m, 1568, "linux") },
      );
      expect(ok).toEqual([expect.objectContaining({ type: "image", mime: "image/jpeg" })]);
    },
  );
});

describe("reencodeToolImage", () => {
  it("throws on a corrupt body under a valid header (Linux: canvas)", async () => {
    await expect(
      reencodeToolImage(corruptPng(800, 600), "image/png", 1568, "linux"),
    ).rejects.toThrow();
  });

  it("re-encodes a good image on Linux with canvas, as new bytes", async () => {
    const small = png(40, 30);
    const out = await reencodeToolImage(small, "image/png", 1568, "linux");
    expect(out).not.toBe(small);
    expect(imageSize(out)).toEqual({ width: 40, height: 30 });
  });

  it.runIf(process.platform === "darwin")(
    "macOS: sips re-encodes even a small image, cuts a big one, keeps JPEG as JPEG",
    async () => {
      const small = png(40, 30);
      const out = await reencodeToolImage(small, "image/png");
      expect(out).not.toBe(small);
      expect(out.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(imageSize(out)).toEqual({ width: 40, height: 30 });
      const big = await reencodeToolImage(png(2000, 1000), "image/png");
      expect(imageSize(big)).toEqual({ width: 1568, height: 784 });
      const jpg = await reencodeToolImage(png(64, 48), "image/jpeg");
      expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    },
    30_000,
  );

  it.runIf(process.platform === "darwin")(
    "macOS: a corrupt body under a valid header throws instead of passing through",
    async () => {
      await expect(reencodeToolImage(corruptPng(800, 600), "image/png")).rejects.toThrow();
    },
    30_000,
  );
});

describe("downscaleImage", () => {
  it("passes small images and GIFs through untouched", async () => {
    const small = png(40, 30);
    expect(await downscaleImage(small, "image/png", 100)).toBe(small);
    const big = png(400, 300);
    expect(await downscaleImage(big, "image/gif", 100)).toBe(big);
  });

  it("finds Windows PowerShell under SystemRoot", () => {
    expect(windowsPowerShell({ SystemRoot: "D:\\Win" })).toMatch(
      /^D:[\\/]Win[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/,
    );
    expect(windowsPowerShell({})).toMatch(/^C:[\\/]Windows[\\/]System32/);
  });

  it.runIf(process.platform === "win32")(
    "Windows: cuts the long edge with WIC and keeps the format",
    async () => {
      const big = png(400, 300);
      const out = await downscaleImage(big, "image/png", 100, "win32");
      expect(out).not.toBe(big);
      expect(out.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(imageSize(out)).toEqual({ width: 100, height: 75 });
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "Windows: WebP (no WIC encoder) passes through unchanged",
    async () => {
      const big = png(400, 300);
      expect(await downscaleImage(big, "image/webp", 100, "win32")).toBe(big);
    },
  );
});
