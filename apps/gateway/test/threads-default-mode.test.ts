import { openDb, setSetting } from "@psyche/db";
import { DEFAULT_AUTO_MODE_ALLOWLIST } from "@psyche/model-router";
import { describe, expect, it } from "vitest";
import type { Call } from "../src/context.ts";
import { defaultThreadMode } from "../src/handlers/threads.ts";

/** Settings → Permissions → "Default mode for new threads" (`permissions.mode`) is read. */

function callWith(mode: unknown, defaultModel?: string): Call {
  const db = openDb(":memory:");
  if (mode !== undefined) setSetting(db, "permissions.mode", mode);
  return {
    ctx: {
      db,
      threadModels: {
        allowsAutoMode: (ref: string) => DEFAULT_AUTO_MODE_ALLOWLIST.some((p) => p.test(ref)),
        defaultModel: () => defaultModel,
      },
    },
  } as unknown as Call;
}

describe("the default mode for new threads", () => {
  it("is the owner's setting, and the database default when unset", () => {
    expect(defaultThreadMode(callWith(undefined))).toBeUndefined();
    expect(defaultThreadMode(callWith("manual"))).toBe("manual");
    expect(defaultThreadMode(callWith("balanced"))).toBe("balanced");
    expect(defaultThreadMode(callWith("plan"))).toBeUndefined();
  });

  it("starts in auto only with an allowlisted model, else balanced", () => {
    expect(defaultThreadMode(callWith("auto", "anthropic/claude-sonnet-5-5"))).toBe("auto");
    expect(defaultThreadMode(callWith("auto", "lmstudio/tiny-7b"))).toBe("balanced");
    expect(defaultThreadMode(callWith("auto"))).toBe("balanced");
    expect(defaultThreadMode(callWith("auto"), "anthropic/claude-sonnet-5-5")).toBe("auto");
  });
});
