import { NEVER_STAGED_KINDS } from "@psyche/agent-core";
import { AUTH_KINDS } from "@psyche/permissions";
import { describe, expect, it } from "vitest";

/**
 * Night shift W1 (night-shift-2026 §3.1): agent-core cannot import `AUTH_KINDS`, so its
 * never-staged list carries a copy. This keeps the copy a superset of the real list.
 */
describe("staging never-staged kinds", () => {
  it("cover every AUTH_KINDS kind and purchase", () => {
    for (const kind of [...AUTH_KINDS, "purchase" as const]) {
      expect(NEVER_STAGED_KINDS, kind).toContain(kind);
    }
  });
});
