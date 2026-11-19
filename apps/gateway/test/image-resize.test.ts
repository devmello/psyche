import { deflateSync } from "node:zlib";
import { imageSize } from "@psyche/agent-core";
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
