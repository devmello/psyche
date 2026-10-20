import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type ComposedBrowser, composeBrowser } from "@psyche/gateway/compose";
import { canonicalUrl } from "@psyche/permissions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Skeleton, startSkeleton } from "../walking-skeleton/harness.ts";
import { MAIN, ScriptedModel } from "../walking-skeleton/scripted-model.ts";

/**
 * Dev preview through the composed Gateway's real broker (I12; security §3.10, S23 design-03).
 * The broker's localhost rule used to have no probes, so every loopback target was refused
 * (`loopback_not_owned`). The browser part now supplies them: a server Psyche spawned and
 * registered passes, a listener Psyche did not spawn is still refused. Real `lsof` and `ps`.
 */
const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"].some((p) => existsSync(p));

describe.skipIf(!lsof || process.platform === "win32")("I12: the broker's localhost rule", () => {
  let sk: Skeleton;
  let browser: ComposedBrowser;
  let child: ChildProcess;
  let port = 0;

  beforeAll(async () => {
    sk = await startSkeleton({
      model: { provider: new ScriptedModel(), model: MAIN },
      parts: [
        (s) => {
          browser = composeBrowser(s, { socketPath: false });
          return browser;
        },
      ],
    });
    child = spawn(
      process.execPath,
      [
        "-e",
        "const s=require('node:http').createServer((q,r)=>r.end('vite'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    port = await new Promise<number>((resolve, reject) => {
      child.stdout?.once("data", (d) => resolve(Number(String(d).trim())));
      child.once("error", reject);
    });
  }, 30_000);
  afterAll(async () => {
    child?.kill();
    await sk?.stop();
  });

  const decide = (origin: string) =>
    sk.composed.broker.decide(
      {
        tool: "browser.dev_preview",
        sideEffect: "read",
        targetKind: "origin",
        target: { kind: "origin", value: origin },
        params: { url: `${origin}/` },
        paramsHash: `sha256:${createHash("sha256").update(`${origin}/`).digest("hex")}`,
        kind: "new_origin",
        grantKey: `browser.dev_preview|new_origin|${origin}`,
      },
      { threadId: "thr_dev", runId: "run_dev", permissionMode: "balanced", taint: false },
    );

  it("refuses a dev server Psyche did not start, and accepts one it did", async () => {
    const origin = `http://127.0.0.1:${port}`;
    expect(await browser.localProject.check(canonicalUrl(`${origin}/`))).toEqual({
      ok: false,
      reason: "listener_not_spawned_by_psyche",
    });
    const before = await decide(origin);
    expect(before.decision).toBe("deny");
    expect(before.rule).toContain("loopback_not_owned");

    // What the sandbox / exec layer does when it starts the owner's dev server.
    browser.devServers.started({ port, pid: child.pid ?? 0, name: "pnpm dev" });
    expect(await browser.localProject.check(canonicalUrl(`${origin}/`))).toEqual({
      ok: true,
      reason: "own_project",
    });
    const after = await decide(origin);
    expect(after.rule ?? "").not.toContain("loopback_not_owned");
    expect(after.decision).not.toBe("deny");
  });

  it("still refuses other local listeners and Psyche's own ports", async () => {
    const other = createServer(() => undefined);
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherPort = (other.address() as AddressInfo).port;
    try {
      const d = await decide(`http://localhost:${otherPort}`);
      expect(d.decision).toBe("deny");
      expect(d.rule).toContain("loopback_not_owned");
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
    // Ollama's well-known port is never "the owner's project", whatever listens there.
    expect(await browser.localProject.check(canonicalUrl("http://127.0.0.1:11434/"))).toEqual({
      ok: false,
      reason: "local_service_port",
    });
  });
});
