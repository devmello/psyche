import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { fileTools, isProtectedPath } from "@psyche/files";
import { CLI_HOME_DIRS } from "@psyche/model-router";
import { createPermissionBroker } from "@psyche/permissions";
import { describe, expect, it } from "vitest";
import { protectedRoots } from "../src/compose/protected-paths.ts";

/**
 * A folder the owner granted under `/opt` before it was refused (#1384): the broker leaves it
 * out of `grantedFolders()`, and every reader the Gateway wires uses that list, so the file
 * executor, the exec_host executor, the harness mounts and the rest never see it.
 */

const ctx = {
  signal: new AbortController().signal,
  taint: false,
  threadId: "t",
} as unknown as ToolRunContext;

describe("an old /opt/homebrew rw grant", () => {
  const broker = createPermissionBroker({
    approvers: { device: async () => undefined, isOwnerSender: async () => false },
    policy: {
      folders: [
        { path: "/opt/homebrew", mode: "rw" },
        { path: "/Users/o/Projects", mode: "rw" },
      ],
    },
    hostProgram: { home: "/Users/o" },
  });

  it("is not in the list the executors and the harness mounts get", () => {
    expect(broker.grantedFolders()).toEqual([{ path: "/Users/o/Projects", mode: "rw" }]);
  });

  it("the file executor wired on that list refuses list_dir and write_file there", async () => {
    const tools = Object.fromEntries(
      fileTools({ folders: () => broker.grantedFolders(), protectedRoots: () => [] }).map((t) => [
        t.spec.name,
        t,
      ]),
    ) as Record<string, AgentToolRegistration>;
    await expect(tools.list_dir?.run?.({ path: "/opt/homebrew" }, ctx)).rejects.toMatchObject({
      code: "forbidden",
    });
    // A parent that does not exist: if the refusal ever regressed, nothing real is written.
    // `forbidden` (not `not_found`) is what proves the grant was ignored.
    await expect(
      tools.write_file?.run?.({ path: "/opt/homebrew/.psyche-never/op", content: "x" }, ctx),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("no compose module reads the raw policy folders or the raw session folders", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/compose");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/(rawBroker|broker\??)\.policy\??\.folders/);
      expect(src, f).not.toMatch(/rawBroker\.sessionFolders\(/);
    }
  });
});

describe("a legacy home-root rw grant and the CLI binary folders", () => {
  it("the file executor's protected roots cover them, so a wide grant cannot reach them", () => {
    const roots = protectedRoots(join(homedir(), ".psyche"));
    for (const dir of CLI_HOME_DIRS) {
      // Only the pure path check runs here: nothing is written under the real home.
      const p = join(homedir(), ...dir, ".psyche-never", "x");
      expect(isProtectedPath(p, roots), p).toBe(true);
    }
    expect(isProtectedPath(join(homedir(), "Projects", "x"), roots)).toBe(false);
    expect(isProtectedPath(join(homedir(), ".npm-global", "lib", "x"), roots)).toBe(true);
  });
});
