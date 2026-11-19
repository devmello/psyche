import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { fileTools } from "@psyche/files";
import { createPermissionBroker } from "@psyche/permissions";
import { describe, expect, it } from "vitest";

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
    approvers: [],
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
    await expect(
      tools.write_file?.run?.({ path: "/opt/homebrew/bin/op", content: "x" }, ctx),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("compose never reads the raw policy folders again", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../src/compose/index.ts"), "utf8");
    expect(src).not.toMatch(/rawBroker\.policy\.folders/);
    expect(src).not.toMatch(/rawBroker\.sessionFolders\(/);
  });
});
