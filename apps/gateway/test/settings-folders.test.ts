import { homedir } from "node:os";
import { openDb } from "@psyche/db";
import { describe, expect, it } from "vitest";
import type { Call } from "../src/context.ts";
import { settingsHandlers } from "../src/handlers/settings.ts";

/** Settings → File access cannot add a sensitive root either (security §3.5). */

function callWith(db: ReturnType<typeof openDb>): Call {
  return {
    ctx: { db, config: { home: `${homedir()}/.psyche` }, bus: { bumpStateVersion: () => 1 } },
    identity: { scopes: ["operator.admin"] },
    emit: () => undefined,
  } as unknown as Call;
}

const setRun = (c: Call, p: unknown) => {
  const run = settingsHandlers["settings.set"]?.run as unknown as
    | ((c: Call, p: unknown) => Promise<unknown>)
    | undefined;
  if (run === undefined) throw new Error("no settings.set handler");
  return run(c, p);
};

describe("settings.set permissions.policy folders", () => {
  it("refuses the home root, ~/.ssh and ~/Library before any approval is raised", async () => {
    const db = openDb(":memory:");
    for (const path of [homedir(), `${homedir()}/.ssh`, `${homedir()}/Library`, "/"]) {
      await expect(
        setRun(callWith(db), {
          key: "permissions.policy",
          value: { folders: [{ path, mode: "ro" }] },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });
});
