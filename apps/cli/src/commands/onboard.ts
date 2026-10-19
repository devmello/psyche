import { chmodSync, mkdirSync } from "node:fs";
import { PsycheError } from "@psyche/protocol";
import { bool, type CommandSpec, str } from "../command.ts";
import type { Ctx } from "../context.ts";
import { CliError } from "../errors.ts";
import { readAll } from "../prompt.ts";
import { detectSupervisor, resolvePsyched, startService } from "../supervisor.ts";
import { supervisorEnv } from "./service.ts";
import { callIfAvailable } from "./util.ts";

/** Model providers onboarding can store a key for; bindings keep each key to its API host. */
export const PROVIDERS: Record<
  string,
  { name: string; host: string; header?: string; prefix?: string }
> = {
  anthropic: { name: "Anthropic", host: "api.anthropic.com", header: "x-api-key" },
  openai: { name: "OpenAI", host: "api.openai.com", header: "authorization", prefix: "Bearer " },
  openrouter: {
    name: "OpenRouter",
    host: "openrouter.ai",
    header: "authorization",
    prefix: "Bearer ",
  },
  google: {
    name: "Google Gemini",
    host: "generativelanguage.googleapis.com",
    header: "x-goog-api-key",
  },
};

interface Step {
  step: string;
  status: "done" | "skipped" | "pending" | "failed";
  detail?: string;
}

async function pairWithWait(ctx: Ctx, wait: boolean, steps: Step[]): Promise<boolean> {
  const deadline = Date.now() + 5 * 60_000;
  let announced = false;
  for (;;) {
    try {
      const client = await ctx.gateway();
      steps.push({ step: "pair", status: "done", detail: client.scopes.join(", ") });
      return true;
    } catch (err) {
      if (!(err instanceof CliError) || err.kind !== "pairing" || !err.details?.code) throw err;
      if (!wait || !ctx.deps.prompter.interactive) {
        steps.push({ step: "pair", status: "pending", detail: err.message });
        return false;
      }
      if (!announced) {
        ctx.deps.io.err(`${err.message}\nWaiting for approval (Ctrl-C to stop)…`);
        announced = true;
      }
      if (Date.now() > deadline) {
        steps.push({ step: "pair", status: "pending", detail: "timed out waiting for approval" });
        return false;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export const onboardCommands: CommandSpec[] = [
  {
    path: ["onboard"],
    summary: "Guided setup: data dir, Gateway service, pairing, a model key, persona basics",
    description:
      "Interactive by default. Non-interactive: --yes --start --provider anthropic --key-stdin --agent-name Pip --user-name Ada.",
    options: {
      yes: { type: "boolean", short: "y", description: "Accept defaults; never prompt" },
      start: {
        type: "boolean",
        description: "Install and start the Gateway service if it is not running",
      },
      psyched: { type: "string", description: "Path of the psyched executable" },
      "no-wait": { type: "boolean", description: "Do not wait for pairing approval" },
      provider: {
        type: "string",
        description: `Model provider: ${Object.keys(PROVIDERS).join(" | ")} | skip`,
        choices: [...Object.keys(PROVIDERS), "skip"],
      },
      "key-stdin": { type: "boolean", description: "Read the provider API key from stdin" },
      "agent-name": { type: "string", description: "Your agent's name (IDENTITY.md)" },
      "user-name": { type: "string", description: "What the agent calls you (USER.md)" },
    },
    async run(ctx, { opts }) {
      const yes = bool(opts, "yes");
      const p = ctx.deps.prompter;
      const ask = !yes && p.interactive;
      const steps: Step[] = [];

      // 1. Data directory (architecture §12): 0700.
      mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
      chmodSync(ctx.home, 0o700);
      steps.push({ step: "home", status: "done", detail: ctx.home });

      // 2. Gateway service.
      let probe = await ctx.probe();
      if (!probe.healthy) {
        const want =
          bool(opts, "start") ||
          (ask &&
            (await p.confirm(
              "The Gateway is not running. Install and start it as a service?",
              true,
            )));
        const s = supervisorEnv(ctx);
        if (want && (await detectSupervisor(s)) !== "none") {
          const file = await startService(s, await resolvePsyched(s, str(opts, "psyched")));
          const deadline = Date.now() + ctx.opts.timeoutMs;
          for (;;) {
            probe = await ctx.probe();
            if (probe.healthy || Date.now() >= deadline) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          steps.push({ step: "gateway", status: probe.healthy ? "done" : "failed", detail: file });
        } else {
          steps.push({
            step: "gateway",
            status: "skipped",
            detail: "not running; start it with `psyche start` or Docker Compose",
          });
        }
      } else {
        steps.push({
          step: "gateway",
          status: "done",
          detail: `healthy at ${ctx.gatewayUrl().origin}`,
        });
      }
      if (!probe.healthy) return finish(steps, 1);

      // 3. Pair this CLI (owner approves; never auto-approved).
      if (!(await pairWithWait(ctx, !bool(opts, "no-wait"), steps))) return finish(steps, 3);
      const client = await ctx.gateway();

      // 4. Vault.
      const vault = await callIfAvailable<{ status: { state: string } }>(
        client,
        "vault.status",
        {},
      );
      if (vault.ok && vault.value.status.state === "uninitialized") {
        steps.push({
          step: "vault",
          status: "pending",
          detail: "set up the vault in the Psyche app or web UI (it shows the recovery key once)",
        });
      } else if (vault.ok) {
        steps.push({ step: "vault", status: "done", detail: vault.value.status.state });
      } else {
        steps.push({ step: "vault", status: "skipped", detail: vault.message });
      }

      // 5. One model provider key, stored in the vault and bound to the provider's host.
      let provider = str(opts, "provider");
      if (!provider && ask) {
        provider = (
          await p.text(
            `Model provider (${Object.keys(PROVIDERS).join(", ")}, or skip)`,
            "anthropic",
          )
        ).toLowerCase();
      }
      if (provider && provider !== "skip") {
        const spec = PROVIDERS[provider];
        if (!spec) throw new CliError("usage", `Unknown provider ${provider}`);
        const token = bool(opts, "key-stdin")
          ? (await readAll(ctx.deps.io.stdin)).trim()
          : ask
            ? await p.secret(`${spec.name} API key`)
            : "";
        if (!token) {
          steps.push({ step: "model", status: "skipped", detail: "no key given" });
        } else {
          try {
            await client.call("vault.add", {
              kind: "api_key",
              name: `${spec.name} API key`,
              slug: `${provider}-api-key`,
              bindings: [{ host: spec.host }],
              secret: {
                token,
                ...(spec.header ? { headerName: spec.header } : {}),
                ...(spec.prefix ? { headerPrefix: spec.prefix } : {}),
              },
            });
            steps.push({
              step: "model",
              status: "done",
              detail: `{{cred:${provider}-api-key}} bound to ${spec.host}`,
            });
          } catch (err) {
            steps.push({
              step: "model",
              status: "failed",
              detail: err instanceof PsycheError ? `${err.code}: ${err.message}` : String(err),
            });
          }
        }
      } else {
        steps.push({ step: "model", status: "skipped" });
      }

      // 6. Persona basics: IDENTITY.md front matter (if missing) and the user's name in USER.md.
      const agentName =
        str(opts, "agent-name") ?? (ask ? await p.text("Name your agent", "Psyche") : undefined);
      const userName =
        str(opts, "user-name") ?? (ask ? await p.text("What should it call you?", "") : undefined);
      if (agentName) {
        const existing = await callIfAvailable<{ content: string }>(client, "memory.read", {
          path: "IDENTITY.md",
        });
        if (existing.ok && existing.value.content.trim()) {
          steps.push({ step: "persona", status: "skipped", detail: "IDENTITY.md already exists" });
        } else {
          const w = await callIfAvailable(client, "memory.write", {
            path: "IDENTITY.md",
            content: `---\nname: ${agentName.replace(/[\r\n]/g, " ")}\n---\n`,
            mode: "replace",
          });
          steps.push({
            step: "persona",
            status: w.ok ? "done" : "failed",
            ...(w.ok ? { detail: agentName } : { detail: w.message }),
          });
        }
      }
      if (userName) {
        const w = await callIfAvailable(client, "memory.write", {
          path: "USER.md",
          content: `\nName: ${userName.replace(/[\r\n]/g, " ")}\n`,
          mode: "append",
        });
        steps.push({
          step: "user",
          status: w.ok ? "done" : "failed",
          ...(w.ok ? {} : { detail: w.message }),
        });
      }
      return finish(steps, 0);
    },
  },
];

function finish(steps: Step[], exitCode: number) {
  const mark = { done: "ok  ", skipped: "skip", pending: "todo", failed: "FAIL" } as const;
  return {
    data: { ok: exitCode === 0, steps },
    human: [
      ...steps.map((s) => `[${mark[s.status]}] ${s.step}${s.detail ? `: ${s.detail}` : ""}`),
      ...(exitCode === 0 ? ["", "Next: psyche doctor"] : []),
    ].join("\n"),
    exitCode,
  };
}
