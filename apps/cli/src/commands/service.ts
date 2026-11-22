import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { isClaimedHome, readSetupCode } from "@psyche/protocol/claim-node";
import { bool, type CommandSpec, str } from "../command.ts";
import type { Ctx } from "../context.ts";
import { CliError } from "../errors.ts";
import { identityPath } from "../identity.ts";
import { kv } from "../output.ts";
import {
  bundleOfThisCli,
  serverInstallStatus,
  serverInstallText,
  serverUpdate,
} from "../server-update.ts";
import {
  resolvePsyched,
  restartService,
  resumeService,
  type SupervisorEnv,
  SYSTEMD_UNIT,
  serviceState,
  startService,
  stopService,
} from "../supervisor.ts";

export function supervisorEnv(ctx: Ctx): SupervisorEnv {
  return {
    env: ctx.env,
    exec: ctx.deps.exec,
    platform: ctx.deps.platform,
    uid: ctx.deps.uid,
    home: ctx.home,
  };
}

async function waitHealthy(ctx: Ctx, want: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await ctx.probe();
    if (p.healthy === want) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const serviceCommands: CommandSpec[] = [
  {
    path: ["start"],
    summary:
      "Install and start the Gateway service (LaunchAgent / systemd user unit / scheduled task)",
    options: {
      psyched: { type: "string", description: "Path of the psyched executable" },
      "no-wait": { type: "boolean", description: "Do not wait for /healthz" },
    },
    async run(ctx, { opts }) {
      const s = supervisorEnv(ctx);
      const program = await resolvePsyched(s, str(opts, "psyched"));
      const file = await startService(s, program);
      const healthy = bool(opts, "no-wait")
        ? null
        : await waitHealthy(ctx, true, ctx.opts.timeoutMs);
      const data = { started: true, file, program, healthy };
      if (healthy === false) {
        return {
          data,
          human: `Service started from ${file}, but /healthz did not answer within ${ctx.opts.timeoutMs / 1000}s. Check \`psyche logs\`.`,
          exitCode: 1,
        };
      }
      return { data, human: `Gateway started (${file})` };
    },
  },
  {
    path: ["stop"],
    summary: "Stop the Gateway service; it stays stopped until `psyche start`",
    async run(ctx) {
      await stopService(supervisorEnv(ctx));
      const stopped = await waitHealthy(ctx, false, ctx.opts.timeoutMs);
      return {
        data: { stopped },
        human: stopped
          ? "Gateway stopped"
          : "Stop requested, but /healthz still answers (another Gateway may be running)",
        exitCode: stopped ? 0 : 1,
      };
    },
  },
  {
    path: ["restart"],
    summary: "Restart the Gateway service",
    async run(ctx) {
      await restartService(supervisorEnv(ctx));
      const healthy = await waitHealthy(ctx, true, ctx.opts.timeoutMs);
      return {
        data: { restarted: true, healthy },
        human: healthy
          ? "Gateway restarted"
          : "Restarted, but /healthz did not answer yet. Check `psyche logs`.",
        exitCode: healthy ? 0 : 1,
      };
    },
  },
  {
    path: ["status"],
    summary: "Gateway health, version, service state and this CLI's pairing",
    description:
      "Exits 1 when the Gateway is not healthy. Connects only when this CLI already has a device key.",
    async run(ctx) {
      const url = ctx.gatewayUrl();
      const probe = await ctx.probe();
      const service = await serviceState(supervisorEnv(ctx)).catch((err: unknown) => ({
        kind: "none" as const,
        installed: false,
        running: false,
        detail: err instanceof Error ? err.message : String(err),
      }));
      let cli: { paired: boolean; scopes?: readonly string[]; deviceId?: string; detail?: string } =
        {
          paired: false,
          detail: "no CLI identity yet (run `psyche onboard`)",
        };
      if (probe.healthy && existsSync(identityPath(ctx.home))) {
        const { client, error } = await ctx.tryGateway();
        cli = client
          ? { paired: true, scopes: client.scopes, deviceId: client.deviceId }
          : { paired: false, detail: error instanceof Error ? error.message : String(error) };
      }
      const install =
        ctx.deps.platform === "linux" ? serverInstallStatus(bundleOfThisCli()) : undefined;
      // A psyche-server waiting to be set up from the app (remote-gateway design §3.6). Only a hash
      // of the code is kept, so this says a code is waiting, never which.
      const setup = install === undefined || cli.paired ? undefined : setupState(ctx);
      const data = {
        gateway: { url: url.origin, ...probe },
        service,
        cli,
        ...(install === undefined ? {} : { install }),
        ...(setup === undefined ? {} : { setup }),
      };
      const v = probe.version;
      return {
        data,
        human: kv({
          gateway: probe.healthy
            ? `healthy at ${url.origin}`
            : probe.reachable
              ? `unhealthy at ${url.origin}`
              : `not reachable at ${url.origin}${probe.error ? ` (${probe.error})` : ""}`,
          version: v ? `${v.version ?? "?"} (protocol ${v.protocolVersion ?? "?"})` : "-",
          service: `${service.kind}${service.kind === "none" ? "" : `: ${service.running ? "running" : "not running"}${"pid" in service && service.pid ? ` (pid ${service.pid})` : ""}${service.installed ? "" : ", not installed"}`}`,
          cli: cli.paired ? `paired (${cli.scopes?.join(", ")})` : `not paired: ${cli.detail}`,
          ...(install === undefined ? {} : { install: serverInstallText(install) }),
          ...(setup === undefined ? {} : { setup: setupText(setup) }),
        }),
        exitCode: probe.healthy ? 0 : 1,
      };
    },
  },
  {
    path: ["update"],
    summary: "Update a psyche-server install: verified, after a pre-update snapshot of your data",
    description:
      "Linux server installs only (the psyche-server deb, rpm or tarball). Checks the release's signed update manifest against the keys this install ships, downloads and verifies the package, stops the Gateway and copies your data to backups/pre-update (psyched snapshot), then installs the tarball in place, or prints the apt or dnf command for a deb or rpm. A tarball update that does not come up healthy is undone. --rollback goes back to the previous release.",
    options: {
      check: { type: "boolean", description: "Only say whether an update is available" },
      rollback: {
        type: "boolean",
        description: "Go back to the previous release (tarball), or show how (deb, rpm)",
      },
      from: {
        type: "string",
        description:
          "Read update-manifest.json, its .sig and the package from this folder instead of the release page (still verified)",
      },
      "manifest-url": {
        type: "string",
        description: "Another https address for update-manifest.json (still verified)",
      },
    },
    async run(ctx, { opts }) {
      if (ctx.deps.platform !== "linux")
        throw new CliError(
          "usage",
          "psyche update is for psyche-server on Linux. The desktop app updates itself.",
        );
      const s = supervisorEnv(ctx);
      const from = str(opts, "from");
      const manifestUrl = str(opts, "manifest-url");
      const result = await serverUpdate(
        bundleOfThisCli(),
        {
          check: bool(opts, "check"),
          rollback: bool(opts, "rollback"),
          ...(from === undefined ? {} : { from: resolve(from) }),
          ...(manifestUrl === undefined ? {} : { manifestUrl }),
        },
        {
          stop: async () => {
            await stopService(s);
            await waitHealthy(ctx, false, ctx.opts.timeoutMs);
          },
          start: () => resumeService(s),
          healthy: (ms) => waitHealthy(ctx, true, ms),
          running: async () => (await ctx.probe().catch(() => ({ reachable: false }))).reachable,
          exec: ctx.deps.exec,
          fetch: ctx.deps.fetch,
          env: ctx.env,
          home: ctx.home,
          uid: ctx.deps.uid,
          log: (line) => {
            if (!ctx.json) ctx.deps.io.err(line);
          },
        },
      );
      return result;
    },
  },
  {
    path: ["logs"],
    summary: "Show Gateway logs (files under $PSYCHE_HOME/logs, or the systemd journal)",
    options: {
      lines: { type: "string", short: "n", description: "Number of lines (default 100)" },
      follow: { type: "boolean", short: "f", description: "Keep printing new lines" },
    },
    async run(ctx, { opts }) {
      const n = Number(str(opts, "lines") ?? "100");
      if (!Number.isInteger(n) || n < 1)
        throw new CliError("usage", "--lines must be a positive integer");
      const files = logFiles(ctx.home);
      let lines: string[];
      if (files.length > 0) {
        lines = files.flatMap((f) => tail(f, n)).slice(-n);
      } else if (ctx.deps.platform === "linux") {
        const r = await ctx.deps.exec("journalctl", [
          "--user",
          "-u",
          SYSTEMD_UNIT,
          "-n",
          String(n),
          "-o",
          "cat",
          "--no-pager",
        ]);
        if (r.code !== 0)
          throw new CliError(
            "failure",
            `No log files in ${join(ctx.home, "logs")} and journalctl failed. With Compose: docker compose logs gateway`,
          );
        lines = r.stdout.split("\n").filter(Boolean);
      } else {
        throw new CliError("failure", `No log files in ${join(ctx.home, "logs")}`);
      }
      if (bool(opts, "follow") && !ctx.json && files.length > 0) {
        for (const line of lines) ctx.deps.io.out(line);
        await follow(files, (line) => ctx.deps.io.out(line));
        return { data: null, human: "" };
      }
      const data = lines.map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return l;
        }
      });
      return { data: { lines: data }, human: lines.join("\n") };
    },
  },
];

function logFiles(home: string): string[] {
  const dir = join(home, "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("gateway") && f.endsWith(".log"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/** Last `n` lines of a file, reading at most 1 MiB from its end. */
export function tail(file: string, n: number): string[] {
  const size = statSync(file).size;
  const len = Math.min(size, 1 << 20);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n").filter(Boolean);
  if (len < size) lines.shift(); // first line is probably cut
  return lines.slice(-n);
}

function follow(files: string[], emit: (line: string) => void): Promise<void> {
  const offsets = new Map(files.map((f) => [f, statSync(f).size]));
  return new Promise((resolve) => {
    const watchers = files.map((f) =>
      watch(f, () => {
        const size = statSync(f).size;
        const from = offsets.get(f) ?? 0;
        if (size <= from) {
          offsets.set(f, size);
          return;
        }
        const buf = Buffer.alloc(size - from);
        const fd = openSync(f, "r");
        try {
          readSync(fd, buf, 0, buf.length, from);
        } finally {
          closeSync(fd);
        }
        offsets.set(f, size);
        for (const line of buf.toString("utf8").split("\n").filter(Boolean)) emit(line);
      }),
    );
    process.once("SIGINT", () => {
      for (const w of watchers) w.close();
      resolve();
    });
  });
}

type SetupState =
  | { state: "waiting"; expiresAt: string }
  | { state: "expired" }
  | { state: "no_code" };

/** Whether this unclaimed server has a setup code waiting; undefined once it is set up. */
export function setupState(ctx: Pick<Ctx, "home" | "deps">): SetupState | undefined {
  if (isClaimedHome(ctx.home)) return undefined;
  const code = readSetupCode(ctx.home, ctx.deps.now());
  if (code === "expired") return { state: "expired" };
  if (code === null) return { state: "no_code" };
  return { state: "waiting", expiresAt: code.expiresAt };
}

export function setupText(s: SetupState): string {
  if (s.state === "waiting") {
    return `not set up yet: a setup code is waiting until ${s.expiresAt} (it was shown at install; \`psyche setup code\` makes a new one)`;
  }
  if (s.state === "expired")
    return "not set up yet: the setup code expired. Run `psyche setup code`";
  return "not set up yet: run `psyche setup code`, then Connect to a Psyche server in the app";
}
