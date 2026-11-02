import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@psyche/agent-core";
import {
  assertFolderGrantable,
  createPermissionBroker,
  resolveRequestedFolder,
} from "@psyche/permissions";
import { describe, expect, it } from "vitest";
import { requestFolderAccessTool } from "../src/compose/folder-access.ts";
import { folderAccessEnv, ownWorkdirs } from "../src/compose/protected-paths.ts";

/**
 * The working directory Psyche gives a subscription CLI provider (`<home>/cli/<id>`) can be
 * shared without the "private data or system folder" block; the rest of `$PSYCHE_HOME` cannot.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), "psy-cliwd-")));
const user = join(base, "user");
const psyche = join(user, ".psyche");
const cli = join(psyche, "cli", "claude-code");
for (const d of [
  join(cli, ".claude"),
  join(psyche, "cli", "codex"),
  join(psyche, "vault"),
  join(psyche, "db"),
]) {
  mkdirSync(d, { recursive: true });
}
symlinkSync(join(psyche, "vault"), join(psyche, "cli", "sneaky"));

describe("ownWorkdirs", () => {
  it("lists real direct sub-folders of <home>/cli only", () => {
    const dirs = ownWorkdirs(psyche);
    expect(dirs).toContain(cli);
    expect(dirs).toContain(join(psyche, "cli", "codex"));
    expect(dirs.some((d) => d.endsWith("sneaky"))).toBe(false);
    expect(dirs.some((d) => d.endsWith("vault"))).toBe(false);
    expect(ownWorkdirs(join(base, "nowhere"))).toEqual([]);
  });
});

describe("sharing the CLI workdir", () => {
  it("resolves ok, and Settings accepts it", async () => {
    const env = folderAccessEnv(psyche);
    expect(await resolveRequestedFolder(cli, env)).toEqual({ status: "ok", path: cli });
    await expect(assertFolderGrantable(cli, env)).resolves.toBeUndefined();
  });

  it("still refuses ~/.psyche and everything else under it", async () => {
    const env = folderAccessEnv(psyche);
    for (const p of [
      psyche,
      join(psyche, "cli"),
      join(psyche, "vault"),
      join(psyche, "db"),
      join(psyche, "cli", "sneaky"),
      join(cli, ".claude"),
    ]) {
      expect(await resolveRequestedFolder(p, env), p).toMatchObject({ status: "blocked" });
      await expect(assertFolderGrantable(p, env), p).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("the agent's request card is pre-filled, not blocked", async () => {
    const broker = createPermissionBroker({
      armDelayMs: 0,
      approvers: {
        device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
        isOwnerSender: async () => false,
      },
      folderAccess: { env: () => folderAccessEnv(psyche), persist: async () => undefined },
    });
    const tool = requestFolderAccessTool({
      broker,
      surfaces: ["desktop"],
      folderEnv: () => folderAccessEnv(psyche),
    });
    const abort = new AbortController();
    const ctx = {
      callId: "c1",
      threadId: "t1",
      runId: "r1",
      taint: false,
      permissionMode: "balanced",
      mode: "attended",
      signal: abort.signal,
      onUpdate: () => undefined,
    } as ToolRunContext;
    for (const [path, status] of [
      [cli, "ok"],
      [join(psyche, "vault"), "blocked"],
    ] as const) {
      const pending = tool.run?.({ path, reason: "cwd", access: "read" }, ctx);
      pending?.catch(() => undefined);
      let found: Awaited<ReturnType<typeof broker.list>>[number] | undefined;
      for (let i = 0; i < 50 && found === undefined; i++) {
        found = (await broker.list({ status: "pending" })).find(
          (a) => a.details.requestedPath === path,
        );
        if (found === undefined) await new Promise((r) => setTimeout(r, 5));
      }
      expect(found?.details.folderStatus, path).toBe(status);
    }
    abort.abort();
  });
});
