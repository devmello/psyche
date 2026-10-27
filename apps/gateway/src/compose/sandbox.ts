import { join } from "node:path";
import type { DecisionContext, SandboxBackend, SandboxScope } from "@psyche/protocol";
import {
  type ContainerSandboxRunner,
  type ContainerSandboxRunnerOptions,
  createSandboxEgress,
  createSandboxRunner,
  type DetectDeps,
  type DevServerEvent,
  FileProvenanceStore,
  inspectBackends,
  type SandboxEgress,
  systemDetectDeps,
} from "@psyche/sandbox";
import type { Gateway } from "../server.ts";
import { execTool } from "./exec-tool.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";
import type { ComposedVm } from "./vm.ts";

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
  /**
   * VM mode (L1–L5): calls whose Task runs in the sandbox Mac go to its runner. With it, `exec`
   * is offered while a container backend exists or VM mode is on, and follows `vm.enabled`.
   */
  vm?: ComposedVm;
  /** Whether this host has a container backend (`composeSandboxIfAvailable` detects it). */
  containers?: boolean;
  /** How `sandbox.setup` looks at this Mac; tests mock the runtime here. */
  detectDeps?: DetectDeps;
}

/**
 * `sandbox.setup` (guided setup): looks at the runtimes again on every call, so "Check again"
 * sees one the owner just installed or started. `active` is what this Gateway booted with; a
 * runtime found now that it did not boot with needs a Gateway restart before it is used.
 * Read-only: it never installs or starts anything.
 */
export function sandboxSetupHandler(active: () => Promise<SandboxBackend>, deps?: DetectDeps) {
  return {
    run: async () => {
      const d = deps ?? systemDetectDeps();
      const backends = (await inspectBackends(d)).map((b) => ({
        kind: b.kind,
        supported: b.supported,
        installed: b.installed,
        running: b.running,
        version: b.version,
      }));
      const now = await active();
      const ready = backends.some((b) => b.running);
      // Apple's `container` where it runs (ADR-008); Docker through Colima or Docker Desktop elsewhere.
      const recommended = backends.find((b) => b.kind === "apple-container")?.supported
        ? ("apple-container" as const)
        : ("docker" as const);
      return { recommended, backends, ready, active: now, restartNeeded: ready && now === "none" };
    },
  };
}

export interface ComposedSandbox extends ComposedPart {
  readonly runner: ContainerSandboxRunner;
  /**
   * The host-side egress proxy for `network: "proxy"` sandboxes (K4): allowlists per scope
   * (`egressAllowlist`, also what `containerLauncher` takes for MCP servers), new origins
   * through the broker with the running command's taint, `sandbox.egress` receipts and logs.
   */
  readonly egress: SandboxEgress;
  /**
   * Registers the decision context of a command running in `scope` while it runs, so the egress
   * proxy decides that sandbox's new origins with the turn's taint (the coding helper's networked
   * `code.run` uses it); returns the release function.
   */
  readonly track: (scope: SandboxScope, ctx: DecisionContext) => () => void;
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
    // A bind mount (the coding helper's repositories) never exposes Psyche's own state.
    ...(services.home === undefined ? {} : { protectedMountRoots: [services.home] }),
    // File provenance survives a restart (S23 design-07).
    ...(setup.exec === false
      ? {}
      : { provenanceStore: new FileProvenanceStore(join(services.home, "sandbox", "provenance")) }),
    ...setup.runner,
    ...(setup.devServers === undefined ? {} : { onDevServer: devServerBridge(setup.devServers) }),
  });
  const tool = execTool({
    runner,
    vault: services.vault,
    broker: services.broker,
    track,
    ...(setup.vm === undefined
      ? {}
      : {
          runnerFor: (ctx: { taskId?: string }) =>
            setup.vm?.workspaceFor(ctx) === "vm" ? setup.vm.runner : runner,
        }),
  });
  let unregister: (() => unknown) | undefined;
  // Offered while something can run it: a container backend, or the sandbox Mac when on.
  const sync = () => {
    const want =
      setup.exec !== false && (setup.containers !== false || setup.vm?.settings().enabled === true);
    if (want && unregister === undefined) unregister = services.tools.register(tool);
    if (!want && unregister !== undefined) {
      unregister();
      unregister = undefined;
    }
  };
  sync();
  let unsubscribe: (() => void) | undefined;
  const backend = async (): Promise<SandboxBackend> => {
    const first = (await runner.backends().catch(() => []))[0];
    return first === "apple-container" || first === "docker" || first === "podman" ? first : "none";
  };
  const setupHandler = sandboxSetupHandler(backend, setup.detectDeps);
  return {
    runner,
    egress,
    track,
    handlers: {
      // For `psyche security audit` (security §5): the backend, and that the egress proxy for
      // `network: "proxy"` sandboxes runs (it is created with every sandbox part).
      "sandbox.status": {
        run: async () => {
          const b = await backend();
          return { backend: b, available: b !== "none", sandbox: null, egress: true };
        },
      },
      "sandbox.setup": setupHandler,
    },
    start(gateway: Gateway) {
      if (setup.vm === undefined) return;
      unsubscribe = gateway.bus.subscribe(["operator.read"], (frame) => {
        const f = JSON.parse(frame) as { event?: string };
        if (f.event === "settings.changed") sync();
      });
    },
    // Stops the containers this process started; their servers are announced `stopped`.
    stop: async () => {
      unsubscribe?.();
      unregister?.();
      unregister = undefined;
      await runner.dispose();
    },
  };
}

/**
 * Mounts the sandbox only where a container backend exists (default off otherwise): without
 * one there is no `exec` tool at all, never a host fallback, unless VM mode can run it in the
 * guest. `PSYCHE_SANDBOX=off` skips it.
 */
export async function composeSandboxIfAvailable(
  services: ComposeServices,
  setup: SandboxSetup = {},
): Promise<ComposedSandbox | ComposedPart> {
  const probe = createSandboxRunner({ ...setup.runner });
  const backends = await probe.backends().catch(() => []);
  await probe.dispose();
  if (backends.length > 0) {
    services.logger?.log("info", "sandbox: exec enabled", { backend: backends[0] ?? null });
    return composeSandbox(services, { ...setup, containers: true });
  }
  if (setup.vm !== undefined) {
    // No container here: `exec` exists only while VM mode is on, and runs only in the guest.
    services.logger?.log("info", "sandbox: no container backend; exec follows VM mode");
    return composeSandbox(services, { ...setup, containers: false });
  }
  services.logger?.log("info", "sandbox: no container backend; exec is off");
  // Still answer, so the audit reports "no backend" rather than "not checked".
  return {
    handlers: {
      "sandbox.status": {
        run: () => ({ backend: "none" as const, available: false, sandbox: null, egress: false }),
      },
      "sandbox.setup": sandboxSetupHandler(async () => "none", setup.detectDeps),
    },
  };
}
