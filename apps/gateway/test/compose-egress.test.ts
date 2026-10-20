import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedSandbox, composeSandbox } from "../src/compose/sandbox.ts";
import { createLogger } from "../src/log.ts";

/** #217 / K4: the sandbox egress proxy registered in the composition root. */

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const noContainers = {
  start: () => ({
    pid: 1,
    done: Promise.resolve({
      exitCode: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    }),
    kill: () => undefined,
  }),
  stream: () => {
    throw new Error("no container in this test");
  },
};

/** One raw request through the proxy, as the in-container shim would hand it over. */
async function through(part: ComposedSandbox, scopeId: string, request: string): Promise<string> {
  const server = createServer((s) => part.egress.proxy.handle({ kind: "task", id: scopeId }, s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve) => {
      const s = connect(port, "127.0.0.1", () => s.write(request));
      const chunks: Buffer[] = [];
      s.on("data", (d) => chunks.push(d));
      s.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
      s.on("error", () => resolve(Buffer.concat(chunks).toString("latin1")));
    });
  } finally {
    server.close();
  }
}

describe("sandbox egress in the Gateway (#217)", () => {
  it("blocks a host off the scope's allowlist with a receipt and a log line", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-egress-"));
    const logs: string[] = [];
    let part: ComposedSandbox | undefined;
    composed = await composeGateway({
      logger: createLogger((line) => logs.push(line), "debug"),
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [
        (s) => {
          part = composeSandbox(s, {
            exec: false,
            runner: { driver: noContainers, detect: async () => [], idleTimeoutMs: 0 },
          });
          return part;
        },
      ],
    });
    const sandbox = part as ComposedSandbox;
    sandbox.egress.egressAllowlist({ kind: "task", id: "task_1" }, ["pypi.org"]);

    const reply = await through(sandbox, "task_1", "CONNECT evil.test:443 HTTP/1.1\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 403 /);
    expect(reply).toContain("X-Proxy-Error: blocked-by-allowlist");
    await new Promise((r) => setTimeout(r, 50));
    const receipts = await composed.broker.listReceipts({ taskId: "task_1" });
    expect(receipts.map((r) => [r.kind, r.outcome])).toEqual([["sandbox.egress", "failed"]]);
    expect(logs.join("\n")).toMatch(/sandbox\.egress.*blocked/);
  });
});
