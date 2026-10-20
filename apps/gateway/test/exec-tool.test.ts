import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presenceChallenge } from "@psyche/permissions";
import type { ModelEvent } from "@psyche/protocol";
import { FakeModelProvider, FakeSandboxRunner } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { execTool } from "../src/compose/exec-tool.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composeSandboxIfAvailable } from "../src/compose/sandbox.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { createLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * The sandbox's `exec` tool through the real loop and policy (K1–K2), with a vault secret in
 * the command's env (§4.6). No container runs here: the runner is the scripted fake.
 */

const SECRET = "tok-Psyche-SANDBOX-SECRET-4410";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const call = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name, input },
  { type: "usage", usage },
  { type: "finish", reason: "tool_calls" },
];
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function gateway(
  model: FakeModelProvider,
  part: (s: ComposeServices) => Promise<object> | object,
  logs: string[] = [],
): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-exec-"));
  const keyFile = join(home, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 9), { mode: 0o600 });
  composed = await composeGateway({
    env: { PSYCHE_VAULT_KEY_FILE: keyFile },
    logger: createLogger((line) => logs.push(line), "debug"),
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    presence: { verify: async (a, challenge) => a.signature === `ok:${challenge}` },
    parts: [part],
  });
  return composed;
}

describe("exec in the sandbox (K1, §4.6)", () => {
  it("runs through the policy, fills the secret into the env only and masks it in output", async () => {
    const runner = new FakeSandboxRunner();
    // The command echoes its token: the output must come back masked.
    runner.script(["deploy"], { stdout: `using ${SECRET}\n`, exitCode: 0 });
    const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
    let slug = "";
    model.script([
      () =>
        call("c1", "exec", {
          argv: ["deploy", "--prod"],
          env: { API_TOKEN: `{{cred:${slug}}}`, MODE: "prod" },
        }),
      say("Deployed."),
    ]);
    const logs: string[] = [];
    const tracked: { scope: { kind: string; id: string }; taint: boolean; live: boolean }[] = [];
    const gw = await gateway(
      model,
      (s) => {
        s.tools.register(
          execTool({
            runner,
            vault: s.vault,
            broker: s.broker,
            track: (scope, ctx) => {
              tracked.push({ scope, taint: ctx.taint, live: true });
              return () => {
                const t = tracked.at(-1);
                if (t !== undefined) t.live = false;
              };
            },
          }),
        );
        return {};
      },
      logs,
    );
    await gw.vault.setup();
    slug = (
      await gw.vault.add({
        kind: "api_key",
        name: "Deploy",
        bindings: [{ host: "api.example.test" }],
        secret: { token: SECRET },
      })
    ).slug;

    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const devices = await owner.call<{ devices: { id: string; scopes: string[] }[] }>(
      "devices.list",
      {},
    );
    const ownerId = devices.devices.find((d) => d.scopes.includes("operator.admin"))?.id as string;
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await owner.call("chat.send", { threadId: thread.id, content: "Deploy it." }, ik());

    // The exec card, then the secret's own credential_fill card (presence-bound).
    const answered: string[] = [];
    const until = Date.now() + 15_000;
    while (
      !owner.events.some(
        (e) => e.event === "chat.message" && JSON.stringify(e.payload).includes("Deployed."),
      )
    ) {
      if (Date.now() > until) throw new Error("exec did not finish");
      const card = owner.events
        .filter((e) => e.event === "approval.created")
        .map(
          (e) =>
            e.payload as {
              approval: { id: string; kind: string; bindingHash: string };
              answerToken?: string;
            },
        )
        .find((p) => !answered.includes(p.approval.kind) && p.answerToken !== undefined);
      if (card === undefined) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      answered.push(card.approval.kind);
      await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
      const challenge = presenceChallenge(
        card.approval.id,
        card.approval.bindingHash,
        card.answerToken as string,
      );
      await owner.call("approvals.answer", {
        approvalId: card.approval.id,
        answerToken: card.answerToken,
        decision: "approve",
        scope: "once",
        presence: { kind: "webauthn", deviceId: ownerId, signature: `ok:${challenge}` },
      });
    }
    await gw.gateway.context.sessions.idle();

    expect(answered).toEqual(["exec", "credential_fill"]);
    // The egress proxy saw this command's context while it ran, then let it go.
    expect(tracked).toEqual([
      { scope: { kind: "thread", id: thread.id }, taint: false, live: false },
    ]);
    const ran = runner.execs[0];
    expect(ran?.argv).toEqual(["deploy", "--prod"]);
    expect(ran?.env).toEqual({ MODE: "prod", PSYCHE_SECRET_API_TOKEN: SECRET });
    // The model sees the masked output and the env names, never the value.
    const seen = {
      "model requests": JSON.stringify(model.requests),
      events: JSON.stringify(owner.events),
      logs: logs.join("\n"),
      "tool calls": JSON.stringify(gw.db.sqlite.prepare("SELECT * FROM tool_calls").all()),
    };
    expect(seen["model requests"]).toContain("PSYCHE_SECRET_API_TOKEN");
    expect(seen["model requests"]).toContain("using •••");
    for (const [where, text] of Object.entries(seen)) {
      expect(text.includes(SECRET), `secret found in ${where}`).toBe(false);
    }
  }, 30_000);
});

describe("composeSandboxIfAvailable", () => {
  const fakeCli = {
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

  it("registers exec only when a container backend exists", async () => {
    const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
    let services: ComposeServices | undefined;
    await gateway(model, async (s) => {
      services = s;
      return composeSandboxIfAvailable(s, {
        runner: { driver: fakeCli, detect: async () => [], idleTimeoutMs: 0 },
      });
    });
    expect(services?.tools.get("exec")).toBeUndefined();
    await composed?.stop("test");
    composed = null;
    rmSync(home, { recursive: true, force: true });

    await gateway(model, async (s) => {
      services = s;
      return composeSandboxIfAvailable(s, {
        runner: {
          driver: fakeCli,
          detect: async () => [{ kind: "docker", cli: "/usr/bin/docker", version: "29" }],
          idleTimeoutMs: 0,
        },
      });
    });
    expect(services?.tools.get("exec")).toBeDefined();
  });
});
