import { chmodSync, mkdirSync } from "node:fs";
import { formatSetupCode, PsycheError } from "@psyche/protocol";
import { isClaimedHome, makeSetupCode } from "@psyche/protocol/claim-node";
import { bool, type CommandSpec, type OptionSpec, str } from "../command.ts";
import { readConfig, setPath, validateConfig, writeConfig } from "../config-file.ts";
import type { Ctx } from "../context.ts";
import { CliError } from "../errors.ts";
import { readAll } from "../prompt.ts";
import { detectSupervisor, resolvePsyched, startService } from "../supervisor.ts";
import { enableLan } from "./devices.ts";
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

const ONBOARD_OPTIONS: Record<string, OptionSpec> = {
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
};

export const onboardCommands: CommandSpec[] = [
  {
    path: ["onboard"],
    summary: "Guided setup: data dir, Gateway service, pairing, a model key, persona basics",
    description:
      "Interactive by default. Non-interactive: --yes --start --provider anthropic --key-stdin --agent-name Pip --user-name Ada.",
    options: ONBOARD_OPTIONS,
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
  {
    path: ["setup"],
    summary: "Set up a Host from the terminal: model key, public origin, LAN, linger, disk check",
    description:
      "Runs `psyche onboard` first (service, pairing, model key, persona), then: gateway.publicOrigin (with the Tailscale Serve command), LAN on one interface, whether the user service keeps running after logout (linger), and a warning when the disk is not encrypted. Non-interactive: --yes --public-origin https://lab-box.tailnet.ts.net --lan --interface eth0.",
    options: {
      ...ONBOARD_OPTIONS,
      "public-origin": {
        type: "string",
        description: "https origin other computers reach this Host at (gateway.publicOrigin)",
      },
      lan: { type: "boolean", description: "Also allow computers on this network" },
      interface: { type: "string", description: "Interface for --lan (eth0, 192.168.1.20)" },
    },
    async run(ctx, input) {
      const { opts } = input;
      const first = await (onboardCommands[0] as CommandSpec).run(ctx, input);
      const steps = ((first.data as { steps?: Step[] }).steps ?? []).slice();
      if ((first.exitCode ?? 0) !== 0) return finish(steps, first.exitCode ?? 1);
      const ask = !bool(opts, "yes") && ctx.deps.prompter.interactive;
      const p = ctx.deps.prompter;

      // gateway.publicOrigin lives in config.json (restart to apply). The Serve command is a hint,
      // never run for the user: Serve changes what the whole tailnet can reach.
      const port = ctx.gatewayUrl().port || "7777";
      const { config } = readConfig(ctx.home);
      const stored = (config.gateway as Record<string, unknown> | undefined)?.publicOrigin;
      let origin = str(opts, "public-origin");
      if (origin === undefined && typeof stored !== "string" && ask) {
        origin = await p.text(
          "Public https address of this Host (blank to skip; for Tailscale, the .ts.net name)",
          "",
        );
      }
      if (origin) {
        const normalized = parsePublicOrigin(origin);
        const next = setPath(config, "gateway.publicOrigin", normalized);
        const problems = validateConfig(next);
        if (problems.length) throw new CliError("usage", `Invalid config: ${problems.join("; ")}`);
        writeConfig(ctx.home, next);
        steps.push({
          step: "publicOrigin",
          status: "done",
          detail: `${normalized} (restart the Gateway to apply: psyche restart)`,
        });
      } else if (typeof stored === "string") {
        steps.push({ step: "publicOrigin", status: "done", detail: stored });
      } else {
        steps.push({ step: "publicOrigin", status: "skipped", detail: "not set" });
      }
      steps.push({
        step: "tailscale",
        status: "pending",
        detail: `to serve it over HTTPS on your tailnet, run: tailscale serve --bg --https=443 http://127.0.0.1:${port}`,
      });

      // LAN on one interface (the existing gateway.lan setting).
      const wantLan =
        bool(opts, "lan") || (ask && (await p.confirm("Allow computers on this network?", false)));
      if (wantLan) {
        try {
          const lan = await enableLan(await ctx.gateway(), str(opts, "interface"), (t) =>
            ctx.deps.io.err(t),
          );
          steps.push({
            step: "lan",
            status: "done",
            detail: lan.origin ?? `on (${lan.interfaces.join(", ") || "primary interface"})`,
          });
        } catch (err) {
          steps.push({
            step: "lan",
            status: "failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        steps.push({ step: "lan", status: "skipped", detail: "off; `psyche lan on` turns it on" });
      }

      // Linux only: linger keeps the user service running after logout, and disk encryption
      // protects the vault key file. Both are checks and hints; setup changes neither.
      if (ctx.deps.platform === "linux") {
        const user = ctx.env.USER ?? ctx.env.LOGNAME ?? "$USER";
        const linger = await ctx.deps.exec("loginctl", [
          "show-user",
          user,
          "-p",
          "Linger",
          "--value",
        ]);
        steps.push(
          linger.code === 0 && linger.stdout.trim() === "yes"
            ? { step: "linger", status: "done", detail: "the service keeps running after logout" }
            : {
                step: "linger",
                status: "pending",
                detail: `the Gateway stops when you log out; run: loginctl enable-linger ${user}`,
              },
        );
        const disk = await ctx.deps.exec("lsblk", ["-J", "-s", "-o", "TYPE,MOUNTPOINT"]);
        const enc = disk.code === 0 ? diskEncryptionOf(disk.stdout, ctx.home) : "unknown";
        steps.push(
          enc === "encrypted"
            ? { step: "disk", status: "done", detail: "encrypted (LUKS)" }
            : enc === "not_encrypted"
              ? {
                  step: "disk",
                  status: "pending",
                  detail:
                    "WARNING: this disk is not encrypted. The vault key is a file here, so anyone who images or steals the disk can read your secrets. Encrypt it (LUKS) before storing real keys.",
                }
              : {
                  step: "disk",
                  status: "skipped",
                  detail:
                    "could not tell whether the disk is encrypted (lsblk unavailable); check it yourself",
                },
        );
      }
      return finish(steps, 0);
    },
  },
  {
    path: ["setup", "code"],
    summary: "A new one-time setup code, for setting this server up from the Psyche app",
    description:
      "On a psyche-server that is not set up yet: makes a new setup code and prints it. In the Psyche app on your Mac, choose Connect to a Psyche server (or Settings → Server & remote access → Set up a remote server) and type it. The code works once, for 24 hours; making a new one stops the old one. Only a hash of it is kept, so it is shown only now. Refused once the server is set up.",
    async run(ctx) {
      if (isClaimedHome(ctx.home)) {
        throw new CliError(
          "usage",
          "This server is set up already. Add another computer with `psyche devices link`.",
        );
      }
      const { code, expiresAt } = await makeSetupCode(ctx.home, ctx.deps.now());
      const shown = formatSetupCode(code);
      return {
        data: { code: shown, expiresAt },
        human: [
          `Setup code: ${shown}`,
          `It works once, until ${expiresAt}. Any earlier code no longer works.`,
          "In the Psyche app on your Mac: Connect to a Psyche server, then type this code.",
        ].join("\n"),
      };
    },
  },
];

interface LsblkNode {
  type?: string;
  mountpoint?: string | null;
  mountpoints?: (string | null)[];
  children?: LsblkNode[];
}

/**
 * Whether the volume holding `home` sits on LUKS: `lsblk -J -s -o TYPE,MOUNTPOINT` lists each
 * device with what it sits on as `children`. The longest mount that covers `home` decides.
 * Mirrors the desktop's onboarding check (the CLI cannot import the desktop app).
 */
export function diskEncryptionOf(
  json: string,
  home: string,
): "encrypted" | "not_encrypted" | "unknown" {
  let tree: { blockdevices?: LsblkNode[] };
  try {
    tree = JSON.parse(json) as { blockdevices?: LsblkNode[] };
  } catch {
    return "unknown";
  }
  const hasCrypt = (n: LsblkNode): boolean =>
    n.type === "crypt" || (n.children ?? []).some(hasCrypt);
  let best: { mount: string; node: LsblkNode } | undefined;
  for (const node of tree.blockdevices ?? []) {
    const mounts = [...(node.mountpoints ?? []), node.mountpoint ?? null].filter(
      (m): m is string => typeof m === "string" && m !== "",
    );
    for (const mount of mounts) {
      const covers = mount === "/" || home === mount || home.startsWith(`${mount}/`);
      if (covers && (best === undefined || mount.length > best.mount.length))
        best = { mount, node };
    }
  }
  if (best === undefined) return "unknown";
  return hasCrypt(best.node) ? "encrypted" : "not_encrypted";
}

/** An https origin with no path, as `gateway.publicOrigin` requires (passkeys need HTTPS). */
function parsePublicOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CliError("usage", `--public-origin is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new CliError(
      "usage",
      "--public-origin must be an https:// origin without a path, such as https://lab-box.tailnet.ts.net",
    );
  }
  return url.origin;
}

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
