import {
  type ContainerSandboxRunner,
  type ContainerSandboxRunnerOptions,
  createSandboxRunner,
  type DevServerEvent,
} from "@psyche/sandbox";
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
}

export interface ComposedSandbox extends ComposedPart {
  readonly runner: ContainerSandboxRunner;
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
 * never runs anything on the host, so the egress and `exec_host` policies are unchanged.
 */
export function composeSandbox(
  _services: ComposeServices,
  setup: SandboxSetup = {},
): ComposedSandbox {
  const runner = createSandboxRunner({
    ...setup.runner,
    ...(setup.devServers === undefined ? {} : { onDevServer: devServerBridge(setup.devServers) }),
  });
  return {
    runner,
    // Stops the containers this process started; their servers are announced `stopped`.
    stop: () => runner.dispose(),
  };
}
