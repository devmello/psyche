import { describe, expect, it } from "vitest";
import { methodSpec, requiresIdempotencyKey, validateParams } from "../src/index.ts";

describe("devices.bootstrapAdmin", () => {
  it("takes no params, needs only operator.write and is side-effecting", () => {
    expect(() => validateParams("devices.bootstrapAdmin", {})).not.toThrow();
    expect(methodSpec("devices.bootstrapAdmin").scope).toBe("operator.write");
    expect(requiresIdempotencyKey("devices.bootstrapAdmin")).toBe(true);
  });
});
