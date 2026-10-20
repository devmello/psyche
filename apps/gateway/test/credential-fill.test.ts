import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBrowser, MockDesktop } from "@psyche/browser/testing";
import { presenceChallenge } from "@psyche/permissions";
import type { ModelEvent, ModelRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ComposedBrowser,
  type ComposedGateway,
  composeBrowser,
  composeGateway,
} from "../src/compose/index.ts";
import { createLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * G4: a credential fill through the real loop, the composed vault and the browser bridge. The
 * secret must reach the page and nothing the model, the owner's devices or the logs can see.
 */

const SECRET = "Zq9-hunter2-Psyche-SECRET-7731";
const ORIGIN = "https://shop-a.example.com";
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

function lastResult(req: ModelRequest): Record<string, unknown> {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const parts = req.messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p?.type === "tool_result") return p.output as Record<string, unknown>;
    }
  }
  throw new Error("no tool result yet");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let home = "";
let composed: ComposedGateway | null = null;
let desktop: MockDesktop | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  desktop?.disconnect();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("credential fill end to end (G4)", () => {
  it("fills the page and leaks the secret into no model-visible byte, event or log", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-fill-"));
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    const logs: string[] = [];
    const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
    let tabId = "";
    let slug = "";
    model.script([
      call("c1", "browser.open_tab", { url: `${ORIGIN}/login` }),
      (req) => {
        tabId = String((lastResult(req).tab as { id: string }).id);
        return call("c2", "browser.snapshot", { tabId });
      },
      (req) => {
        const snapshot = String(lastResult(req).snapshot ?? "");
        const ref = /"Password"[^\n]*?\[ref=(ref_\d+)\]/.exec(snapshot)?.[1];
        if (ref === undefined) throw new Error(`no Password field in:\n${snapshot}`);
        return call("c3", "browser.fill_credential", {
          tabId,
          ref,
          placeholder: `{{cred:${slug}.password}}`,
        });
      },
      say("Filled the password."),
    ]);

    let browser: ComposedBrowser | undefined;
    composed = await composeGateway({
      env: { PSYCHE_VAULT_KEY_FILE: keyFile },
      logger: createLogger((line) => logs.push(line), "debug"),
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "fake/model" },
      vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
      // Stands in for Touch ID / a passkey: the card's presence challenge, "signed".
      presence: { verify: async (a, challenge) => a.signature === `ok:${challenge}` },
      parts: [
        (s) => {
          browser = composeBrowser(s, { socketPath: false, record: true });
          return browser;
        },
      ],
    });
    await composed.vault.setup();
    const item = await composed.vault.add({
      kind: "login",
      name: "Shop A",
      bindings: [{ origin: ORIGIN }],
      secret: { username: "owner@example.test", password: SECRET },
    });
    slug = item.slug;

    const site = new MockBrowser({
      site: {
        pages: {
          "a/login": {
            title: "Shop A: sign in",
            body: [
              {
                kind: "form",
                action: "/session",
                method: "post",
                children: [
                  { kind: "input", label: "Email", name: "email", type: "email" },
                  { kind: "input", label: "Password", name: "password", type: "password" },
                  { kind: "button", text: "Sign in", type: "submit" },
                ],
              },
            ],
          },
        },
        redirects: {},
        downloads: {},
      },
    });
    site.origin = (h) => (h === "a" ? ORIGIN : "https://other.example.org");
    desktop = new MockDesktop({ browser: site, quarantineDir: join(home, "quarantine") });
    browser?.attach(await desktop.connect());

    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    // Presence is bound to the answering device.
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
    await owner.call("chat.send", { threadId: thread.id, content: "Sign me in to shop A." }, ik());

    // Approve every card (new origin, then the fill) with presence until the agent is done.
    const answered = new Set<string>();
    const until = Date.now() + 15_000;
    while (
      !owner.events.some(
        (e) =>
          e.event === "chat.message" && JSON.stringify(e.payload).includes("Filled the password."),
      )
    ) {
      if (Date.now() > until) throw new Error("the fill did not finish");
      const card = owner.events
        .filter((e) => e.event === "approval.created")
        .map(
          (e) =>
            e.payload as { approval: { id: string; bindingHash: string }; answerToken?: string },
        )
        .find((p) => !answered.has(p.approval.id) && p.answerToken !== undefined);
      if (card === undefined) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      answered.add(card.approval.id);
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
    await composed.gateway.context.sessions.idle();

    // The page got the secret: the fill went through CDP and the tool reported success.
    expect(desktop.sent).toContain("Input.insertText");
    expect(desktop.tab(tabId).fieldValue("password")).toBe(SECRET);
    const fillResult =
      model.requests.at(-1) === undefined ? {} : lastResult(model.requests.at(-1) as ModelRequest);
    expect(JSON.stringify(fillResult)).not.toMatch(/error/i);

    // Nothing anyone else can see carries it.
    const history = await owner.call("chat.history", { threadId: thread.id });
    const seen: Record<string, string> = {
      "model requests": JSON.stringify(model.requests),
      transcript: JSON.stringify(history),
      events: JSON.stringify(owner.events),
      logs: logs.join("\n"),
      "tool calls": JSON.stringify(composed.db.sqlite.prepare("SELECT * FROM tool_calls").all()),
      "agent state": JSON.stringify(
        composed.db.sqlite.prepare("SELECT * FROM agent_thread_state").all(),
      ),
    };
    for (const dir of ["audit", "library"]) {
      try {
        for (const f of walk(join(home, dir))) {
          if (/\.(jsonl?|txt|md)$/.test(f)) seen[f] = readFileSync(f, "utf8");
        }
      } catch {
        // absent
      }
    }
    for (const [where, text] of Object.entries(seen)) {
      expect(text.includes(SECRET), `secret found in ${where}`).toBe(false);
    }
  }, 30_000);
});
