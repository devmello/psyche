import type { NodeCapability } from "@psyche/protocol";
import { NodeAgent } from "./agent.ts";
import { createBrowserProvider } from "./capabilities/browser.ts";
import { createExecProvider } from "./capabilities/exec.ts";
import { createFsProvider } from "./capabilities/fs.ts";
import { createHealthProvider } from "./capabilities/health.ts";
import { createHelperProvider } from "./capabilities/helper.ts";
import type { CapabilityProvider } from "./capabilities/types.ts";
import { SkewClock } from "./clock.ts";
import { DEFAULT_GATEWAY_URL, type NodeConfig } from "./config.ts";
import type { NodeIdentity } from "./identity.ts";
import type { Logger } from "./log.ts";
import { channelFactory, planTransports } from "./transports/select.ts";
import { detectVmGuest } from "./transports/vsock.ts";

export const NODE_VERSION = "0.1.0";

export interface RuntimeInput {
  config: NodeConfig;
  identity: NodeIdentity;
  log: Logger;
  localSocket?: string | undefined;
  isGuest?: boolean;
}

export interface NodeRuntime {
  agent: NodeAgent;
  providers: CapabilityProvider[];
  detect(): Promise<NodeCapability[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Wires providers, transports and the agent from a `NodeConfig`. */
export async function createNodeRuntime(input: RuntimeInput): Promise<NodeRuntime> {
  const { config, identity, log } = input;
  const isGuest = input.isGuest ?? detectVmGuest();
  const clock = new SkewClock();
  const providers: CapabilityProvider[] = [];

  let sandboxRunner = null;
  if (config.exec.sandbox) {
    const { createSandboxRunner } = await import("@psyche/sandbox");
    sandboxRunner = createSandboxRunner();
  }
  providers.push(
    createExecProvider({
      runner: sandboxRunner,
      hostExec: { enabled: config.exec.host.enabled, allowedCwdRoots: config.exec.host.cwdRoots },
    }),
  );
  providers.push(createFsProvider({ roots: config.fs.roots }));
  if (config.browser.enabled !== false) {
    providers.push(
      createBrowserProvider({ home: config.home, enabled: config.browser.enabled === true }),
    );
  }
  const helperWanted =
    config.helper.enabled === true ||
    (config.helper.enabled === "auto" && process.platform === "darwin");
  const helper = helperWanted
    ? createHelperProvider({
        home: config.home,
        ...(config.helper.socket ? { socketPath: config.helper.socket } : {}),
        log: (msg, fields) => log.log("info", msg, fields),
      })
    : null;
  if (helper) providers.push(helper);
  const all = [
    createHealthProvider({ version: NODE_VERSION, clock, providers: () => providers }),
    ...providers,
  ];

  const plans = planTransports({
    ...config.gateway,
    isGuest,
    localSocket: input.localSocket,
    defaultUrl: DEFAULT_GATEWAY_URL,
  });
  log.log("info", "transports", { order: plans.map((p) => p.describe), isGuest });

  const agent = new NodeAgent({
    identity,
    name: config.name,
    platform: process.platform === "darwin" ? "macos" : "linux",
    deviceFamily: isGuest ? "vm-guest" : "psyche-node",
    version: NODE_VERSION,
    providers: all,
    connect: channelFactory(plans),
    clock,
    log,
  });

  return {
    agent,
    providers: all,
    async detect() {
      const out: NodeCapability[] = [];
      for (const p of all) for (const e of await p.entries()) out.push(e.manifest);
      return out;
    },
    async start() {
      if (helper) {
        await helper.start();
        // Give a helper launched alongside us a moment to connect, so the first manifest has it.
        await helper.waitForHelper(3_000);
      }
      await agent.start();
    },
    stop: () => agent.stop(),
  };
}
