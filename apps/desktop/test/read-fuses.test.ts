import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types.
import { parseFuses, SENTINEL } from "../../../deploy/scripts/read-fuses.mjs";

const wire = (states: string) =>
  Buffer.concat([
    Buffer.from("junk"),
    Buffer.from(SENTINEL),
    Buffer.from([1, states.length]),
    Buffer.from(states),
    Buffer.from("more"),
  ]);

describe("read-fuses", () => {
  it("reads the fuse wire after the sentinel", () => {
    const f = parseFuses(wire("01001100r")) as Record<string, string>;
    expect(f.RunAsNode).toBe("Disabled");
    expect(f.EnableCookieEncryption).toBe("Enabled");
    expect(f.EnableNodeOptionsEnvironmentVariable).toBe("Disabled");
    expect(f.EnableEmbeddedAsarIntegrityValidation).toBe("Enabled");
    expect(f.OnlyLoadAppFromAsar).toBe("Enabled");
    expect(f.WasmTrapHandlers).toBe("Removed");
  });

  it("throws without a wire or with an unknown version", () => {
    expect(() => parseFuses(Buffer.from("nothing"))).toThrow(/no fuse wire/);
    const bad = wire("0");
    bad[bad.indexOf(Buffer.from(SENTINEL)) + SENTINEL.length] = 9;
    expect(() => parseFuses(bad)).toThrow(/version/);
  });
});
