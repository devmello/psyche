import { join } from "node:path";
import type { DecisionContext, SandboxScope } from "@psyche/protocol";
import {
  type ContainerSandboxRunner,
  type ContainerSandboxRunnerOptions,
  createSandboxEgress,
  createSandboxRunner,
  type DevServerEvent,
  FileProvenanceStore,
  type SandboxEgress,
} from "@psyche/sandbox";
import { execTool } from "./exec-tool.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Where dev servers the sandbox starts are announced: the browser part's dev-preview registry
 * (`ComposedBrowser.devServers`, feature I12). Structural, so this part does not depend on how
 * the browser stores them; the registry keeps what it knows (`pid` is passed for those that
 * record it).
 */
export interface DevServerSink {
  started(server: {
    port: number;
    pid?: number;
    cwd?: string;
    name?: string;
    taskId?: string;
  }): void;
  stopped(port: number): void;
}

export interface SandboxSetup {
  /** The browser's dev-preview registry; absent means no dev-server forwarding at all. */
  devServers?: DevServerSink;
  /** Runner options (backend, image, limits); tests pass a fake driver. */
  runner?: Omit<ContainerSandboxRunnerOptions, "onDevServer">;
  /** Register the agent's `exec` tool (default true). */
  exec?: boolean;
}

export interface ComposedSandbox extends ComposedPart {
  readonly runner: ContainerSandboxRunner;
  /**
   * The host-side egress proxy for `network: "proxy"` sandboxes (K4): allowlists per scope
   * (`egressAllowlist`, also what `containerLauncher` takes for MCP servers), new origins
   * through the broker with the running command's taint, `sandbox.egress` receipts and logs.
   */
  readonly egress: SandboxEgress;
}

/**
 * Turns the runner's dev-server events into registry calls. The port is the runner's own
 * `127.0.0.1` forward, never the container's port number, so the preview opens exactly the
 * server Psyche started (security §3.10) and nothing else that holds that number on the host.
 * A server in a task's sandbox is previewable by that task only.
 */
export function devServerBridge(sink: DevServerSink): (event: DevServerEvent) => void {
  return (event) => {
    const { server } = event;
    if (event.type === "stopped") {
      sink.stopped(server.port);
      return;
    }
    sink.started({
      port: server.port,
      pid: server.pid,
      cwd: server.cwd,
      name: `${server.argv.join(" ")} (sandbox port ${server.containerPort})`.slice(0, 200),
      ...(server.scope.kind === "task" ? { taskId: server.scope.id } : {}),
    });
  };
}

/**
 * The sandbox runner as the Gateway mounts it (K1–K3). With `devServers`, servers an `exec`
 * leaves listening are forwarded to host loopback and announced for dev preview (I12). The
 * container keeps network `none` (the forward is inbound from host loopback only) and this path
 * never runs anything on the host. A sandbox started with `network: "proxy"` reaches only its
 * scope's allowlist through `egress` (K4); the agent's `exec` keeps network `none`, since tasks
 * declare no egress hosts yet.
 */
export function composeSandbox(
  services: ComposeServices,
  setup: SandboxSetup = {},
): ComposedSandbox {
  // The decision context of the command running in each scope. A scope with none (a server
  // left running between turns, an MCP server) counts as tainted, so its new origins ask.
  const live = new Map<string, DecisionContext[]>();
  const key = (scope: SandboxScope) => `${scope.kind}:${scope.id}`;
  const egress = createSandboxEgress({
    broker: services.broker,
    context: (scope) => live.get(key(scope))?.at(-1),
    surfaces: ["desktop", "web"],
    ...(services.logger === undefined ? {} : { logger: services.logger }),
  });
  const track = (scope: SandboxScope, ctx: DecisionContext) => {
    const list = live.get(key(scope)) ?? [];
    list.push(ctx);
    live.set(key(scope), list);
    return () => {
      list.splice(list.indexOf(ctx), 1);
      if (list.length === 0) live.delete(key(scope));
    };
  };
  const runner = createSandboxRunner({
    egressTunnel: egress.egressTunnel,
    // File provenance survives a restart (S23 design-07).
    ...(setup.exec === false
      ? {}
      : { provenanceStore: new FileProvenanceStore(join(services.home, "sandbox", "provenance")) }),
    ...setup.runner,
    ...(setup.devServers === undefined ? {} : { onDevServer: devServerBridge(setup.devServers) }),
  });
  const unregister =
    setup.exec === false
      ? undefined
      : services.tools.register(
          execTool({ runner, vault: services.vault, broker: services.broker, track }),
        );
  return {
    runner,
    egress,
    // Stops the containers this process started; their servers are announced `stopped`.
    stop: async () => {
      unregister?.();
      await runner.dispose();
    },
  };
}

/**
 * Mounts the sandbox only where a container backend exists (default off otherwise): without
 * one there is no `exec` tool at all, never a host fallback. `PSYCHE_SANDBOX=off` skips it.
 */
export async function composeSandboxIfAvailable(
  services: ComposeServices,
  setup: SandboxSetup = {},
): Promise<ComposedPart> {
  const part = composeSandbox(services, setup);
  const backends = await part.runner.backends().catch(() => []);
  if (backends.length > 0) {
    services.logger?.log("info", "sandbox: exec enabled", { backend: backends[0] ?? null });
    return part;
  }
  services.logger?.log("info", "sandbox: no container backend; exec is off");
  await part.stop?.();
  return {};
}
