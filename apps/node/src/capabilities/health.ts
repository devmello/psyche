import { hostname } from "node:os";
import type { SkewClock } from "../clock.ts";
import type { CapabilityProvider } from "./types.ts";

export interface HealthOptions {
  version: string;
  clock: SkewClock;
  /** The other providers, whose `status()` is reported. */
  providers: () => CapabilityProvider[];
  startedAt?: number;
}

/** `health`: always offered, no side effects; what the Gateway shows on the node's card. */
export function createHealthProvider(options: HealthOptions): CapabilityProvider {
  const startedAt = options.startedAt ?? Date.now();
  return {
    id: "health",
    async entries() {
      return [
        {
          manifest: {
            name: "health",
            description: "Node version, uptime, clock offset and per-provider status.",
            sideEffect: "none",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          async handler() {
            const providers: Record<string, unknown> = {};
            for (const p of options.providers()) {
              if (!p.status) continue;
              try {
                providers[p.id] = await p.status();
              } catch (err) {
                providers[p.id] = { error: (err as Error).message };
              }
            }
            return {
              ok: true,
              result: {
                version: options.version,
                host: hostname(),
                platform: process.platform,
                arch: process.arch,
                node: process.version,
                uptimeS: Math.round((Date.now() - startedAt) / 1000),
                clockOffsetMs: options.clock.offsetMs,
                providers,
              },
            };
          },
        },
      ];
    },
  };
}
