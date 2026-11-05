import { deflateSync } from "node:zlib";
import { imageSize } from "@psyche/agent-core";
import { describe, expect, it } from "vitest";
import { downscaleImage, windowsPowerShell } from "../src/session/image-resize.ts";

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
