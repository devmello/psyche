import type { SandboxScope } from "@psyche/protocol";
import type { EgressTunnelHandler } from "../runner.ts";
import { type EgressLogEntry, EgressProxy, type EgressProxyOptions } from "./proxy.ts";

export {
  type AddressClass,
  type AllowEntry,
  canonicalHost,
  classifyAddress,
  matchAllowlist,
  parseAllowlist,
} from "./policy.ts";
export { type EgressLogEntry, EgressProxy, type EgressProxyOptions } from "./proxy.ts";

export interface SandboxEgress {
  readonly proxy: EgressProxy;
  /** Pass as `egressTunnel` in the runner options (`composeSandbox({ runner: { egressTunnel } })`). */
  readonly egressTunnel: EgressTunnelHandler;
  /**
   * Sets a scope's allowlist. Same shape as `@psyche/mcp-host`'s `containerLauncher` option
   * `egressAllowlist(scope, domains)`, and what a task's declared egress hosts go through.
   */
  egressAllowlist(scope: SandboxScope, domains: readonly string[]): void;
}

/**
 * The composition hook for the Gateway (feature K4): one host-side egress proxy for every
 * sandbox. Give it the broker (new-origin decisions, approval cards, receipts), a `context`
 * lookup from a sandbox scope to its task's decision context (taint, run, thread), and a log
 * sink for per-connection host and byte counts.
 */
export function createSandboxEgress(
  options: EgressProxyOptions & {
    /** The Gateway's structured logger (`services.logger`): metadata only, never bodies. */
    logger?: {
      log(
        level: "debug" | "info" | "warn" | "error",
        msg: string,
        fields?: Record<string, string | number | boolean | null>,
      ): void;
    };
  } = {},
): SandboxEgress {
  const { logger, onLog, ...rest } = options;
  const proxy = new EgressProxy({
    ...rest,
    onLog: (e: EgressLogEntry) => {
      onLog?.(e);
      logger?.log(e.decision === "blocked" ? "warn" : "info", "sandbox.egress", {
        scope: `${e.scope.kind}:${e.scope.id}`,
        origin: e.origin,
        decision: e.decision,
        ...(e.reason === undefined ? {} : { reason: e.reason }),
        bytesUp: e.bytesUp,
        bytesDown: e.bytesDown,
        durationMs: e.durationMs,
      });
    },
  });
  return {
    proxy,
    egressTunnel: proxy,
    egressAllowlist: (scope, domains) => proxy.setAllowlist(scope, domains),
  };
}
