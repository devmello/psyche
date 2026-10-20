import { existsSync } from "node:fs";
import type { PsycheAgentLoop } from "@psyche/agent-core";
import { getSetting, type PsycheDb } from "@psyche/db";
import {
  CLAUDE_EGRESS,
  ClaudeCodeHarness,
  type SandboxClaudeDeps,
  SandboxClaudeTransport,
} from "@psyche/harnesses";
import { type PermissionBroker, PsycheError } from "@psyche/protocol";
import { buildSecretEnv, type Vault } from "@psyche/vault";
import type { Gateway } from "../server.ts";
import type { ComposedSandbox } from "./sandbox.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Coding harnesses (feature C10): Claude Code behind `harness.delegate`, registered only while
 * the owner configured it with the admin setting `harness.claudeCode`
 * (`{enabled: true, credential: "<vault item slug>", model?: "sonnet"}`) and a container backend
 * exists. Each session runs the `claude` CLI in its own sandbox with the repository mounted and
 * network only to the Anthropic API; its key is filled from the vault for that session after a
 * `credential_fill` card (device-only, like every fill). Every tool call it makes asks Psyche
 * first (`@psyche/harnesses`). Codex and pi are not implemented and are not registered.
 */

export const CLAUDE_CODE_SETTING = "harness.claudeCode";
/** How long one session's key may live (the CLI's run); the lease wipes it afterwards. */
const SESSION_LEASE_MS = 60 * 60_000;
const API_ORIGIN = "https://api.anthropic.com";

interface ClaudeCodeConfig {
  enabled?: boolean;
  credential?: string;
  model?: string;
}

export interface HarnessesSetup {
  db: PsycheDb;
  loop: PsycheAgentLoop;
  vault: Vault;
  broker: PermissionBroker;
  sandbox: ComposedSandbox | undefined;
  folders: () => readonly { path: string; mode: "ro" | "rw" }[];
}

function config(db: PsycheDb): ClaudeCodeConfig | undefined {
  const v = getSetting(db, CLAUDE_CODE_SETTING)?.value;
  return typeof v === "object" && v !== null ? (v as ClaudeCodeConfig) : undefined;
}

export function composeHarnesses(setup: HarnessesSetup): ComposedPart {
  let unregister: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  const credential =
    (slug: string): SandboxClaudeDeps["credential"] =>
    async (run) => {
      if (run === undefined) throw new PsycheError("internal", "a harness session needs its run");
      const issued = await setup.vault.requestFill({
        slug,
        target: API_ORIGIN,
        executor: "sandbox",
        requestedBy: {
          runId: run.runId,
          taskId: run.taskId ?? null,
          threadId: run.threadId,
          toolCallId: run.callId,
        },
        taint: run.taint,
      });
      const done = await setup.broker.awaitDecision(issued.approval.id);
      if (done.status !== "approved") {
        throw new PsycheError("policy_denied", `the Claude Code key's fill was ${done.status}`);
      }
      const secret = await buildSecretEnv({
        broker: setup.vault,
        entries: [
          {
            name: "ANTHROPIC_API_KEY",
            placeholder: `{{cred:${slug}}}`,
            approvalId: issued.approval.id,
          },
        ],
        target: { kind: "origin", value: API_ORIGIN },
        ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
        lease: { timeoutMs: SESSION_LEASE_MS },
      });
      // The CLI reads ANTHROPIC_API_KEY; both copies go when the session ends.
      const env = { ANTHROPIC_API_KEY: secret.env.PSYCHE_SECRET_ANTHROPIC_API_KEY ?? "" };
      return {
        env,
        dispose: () => {
          env.ANTHROPIC_API_KEY = "";
          secret.dispose();
        },
      };
    };

  const sync = () => {
    const c = config(setup.db);
    const sandbox = setup.sandbox;
    const want = c?.enabled === true && typeof c.credential === "string" && sandbox !== undefined;
    unregister?.();
    unregister = undefined;
    if (!want || sandbox === undefined || c?.credential === undefined) return;
    const runner = sandbox.runner;
    const transport = new SandboxClaudeTransport({
      runner: {
        backends: () => runner.backends(),
        ensureSandbox: (scope, options) => runner.ensureSandbox(scope, options),
        openStdio: (id, options) => runner.openStdio(id, options),
      },
      egressAllowlist: (scope, hosts) => sandbox.egress.egressAllowlist(scope, hosts),
      folders: setup.folders,
      credential: credential(c.credential),
      hasGitDir: (path) => existsSync(`${path}/.git`),
    });
    unregister = setup.loop.harnesses.register(
      new ClaudeCodeHarness({ transport, ...(c.model === undefined ? {} : { model: c.model }) }),
    );
  };
  sync();

  return {
    start(gateway: Gateway) {
      unsubscribe = gateway.bus.subscribe(["operator.read"], (frame) => {
        const f = JSON.parse(frame) as {
          event?: string;
          payload?: { entries?: { key: string }[] };
        };
        if (
          f.event === "settings.changed" &&
          f.payload?.entries?.some((e) => e.key === CLAUDE_CODE_SETTING)
        ) {
          sync();
        }
      });
    },
    stop() {
      unsubscribe?.();
      unregister?.();
    },
  };
}

export { CLAUDE_EGRESS };
