import { execFile } from "node:child_process";
import type { ConnectorRegistry } from "@psyche/connectors";
import { modelSetupFromEnv } from "@psyche/gateway/compose";
import { afterAll, describe, expect, it } from "vitest";
import {
  composeConnectors,
  MemoryTokenVault,
} from "../../../apps/gateway/src/compose/connectors.ts";
import { answer, type PartsSkeleton, startWithParts } from "./harness.ts";

/**
 * Scenario 2 against real Google and a live model. Opt in with `PSYCHE_LIVE_TESTS=1`,
 * `PSYCHE_GOOGLE_CLIENT_ID=<desktop client id>` (package README "Google setup guide") and
 * `PSYCHE_MODEL` plus its key variable, as in ../walking-skeleton/live.test.ts. The consent page
 * opens in the default browser; the owner signs in and the loopback receiver gets the code.
 *
 * Skeleton only: tokens live in an in-memory token vault (the composed Gateway keeps them in
 * the S06 vault, which this rig does not set up), and a Desktop client whose token
 * exchange insists on the client secret cannot connect until the secret can come from the vault
 * (`{{cred:…}}` with `approveSecret`, S06). It checks the reads and prints timings; the write
 * path through the loop (issue #78, fixed) is covered by google.test.ts.
 */

const LIVE =
  process.env.PSYCHE_LIVE_TESTS === "1" &&
  !!process.env.PSYCHE_GOOGLE_CLIENT_ID &&
  !!process.env.PSYCHE_MODEL;

const openBrowser = (url: URL) =>
  new Promise<void>((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [url.href], (err) => (err ? reject(err) : resolve()));
  });

let sk: PartsSkeleton | undefined;
afterAll(async () => {
  await sk?.stop();
});

describe.skipIf(!LIVE)("scenario 2: Google (live OAuth, live model)", () => {
  it("connects through the browser and triages the inbox", { timeout: 600_000 }, async () => {
    const model = modelSetupFromEnv(process.env);
    if (model === null) throw new Error("PSYCHE_MODEL is not set");
    let registry: ConnectorRegistry | undefined;
    sk = await startWithParts({
      model,
      parts: [
        (s) => {
          const part = composeConnectors(s, {
            openBrowser,
            syncIntervalMs: 0,
            tokens: new MemoryTokenVault(),
          });
          registry = part.registry;
          return part;
        },
      ],
    });
    const c = sk.client;
    const t0 = performance.now();
    const record = await registry?.connect({
      catalogueId: "google",
      scopeMode: "read_act",
      config: { clientId: String(process.env.PSYCHE_GOOGLE_CLIENT_ID) },
    });
    const connectedMs = Math.round(performance.now() - t0);
    expect(record?.status).toBe("connected");

    // Approve every card once, as the owner would.
    const answered = new Set<string>();
    const pump = setInterval(() => {
      for (const e of c.events) {
        const id = (e.payload as { approval?: { id: string } }).approval?.id;
        if (e.event !== "approval.created" || id === undefined || answered.has(id)) continue;
        answered.add(id);
        void answer(c, id, "approve").catch(() => undefined);
      }
    }, 200);
    try {
      const { thread } = await c.call<{ thread: { id: string } }>(
        "threads.create",
        { kind: "main" },
        true,
      );
      const from = c.mark;
      const t1 = performance.now();
      await c.call(
        "chat.send",
        {
          threadId: thread.id,
          content: "triage my inbox and draft replies to anything from Alice",
        },
        true,
      );
      await c.event<{ run: { status: string } }>(
        "run.updated",
        (p) => p.run.status === "done" || p.run.status === "failed",
        from,
        300_000,
      );
      const turnMs = Math.round(performance.now() - t1);
      const gmailCalls = c.events
        .slice(from)
        .filter((e) => e.event === "tool_call.updated")
        .map((e) => (e.payload as { toolCall: { tool: string } }).toolCall.tool)
        .filter((t) => t.includes("__gmail_"));
      expect(gmailCalls.length).toBeGreaterThan(0);
      // biome-ignore lint/suspicious/noConsole: the timings go to docs/status (INT-2).
      console.log(`INT-2 live timings ${JSON.stringify({ connectedMs, turnMs })}`);
    } finally {
      clearInterval(pump);
    }
  });
});
