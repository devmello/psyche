import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { silentLogger } from "../src/log.ts";

/** #287: the host Gateway grants no implicit /workspace, and no folder list means no folders. */

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("host file policy (#287)", () => {
  it("has no workspace root unless the owner names one, and file tools fail closed", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-host-policy-"));
    let services: ComposeServices | undefined;
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [
        (s) => {
          services = s;
          return {};
        },
      ],
    });
    const s = services as ComposeServices;
    expect(s.rawBroker.policy.workspaceRoots).toEqual([]);
    const read = s.tools.get("read_file") as { run?: (p: unknown, c: unknown) => Promise<unknown> };
    await expect(
      read.run?.(
        { path: "/workspace/notes.md" },
        { signal: new AbortController().signal, taint: false },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
