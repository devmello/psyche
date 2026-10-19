import { PROTOCOL_VERSION } from "@psyche/protocol";
import type { CommandSpec } from "../command.ts";
import { kv } from "../output.ts";
import { CLI_VERSION } from "../version.ts";

export const versionCommands: CommandSpec[] = [
  {
    path: ["version"],
    summary: "Show the CLI and Gateway versions",
    async run(ctx) {
      let gateway: unknown = null;
      try {
        const probe = await ctx.probe();
        gateway = probe.reachable ? (probe.version ?? { version: "unknown" }) : null;
      } catch {
        gateway = null;
      }
      const data = {
        cli: {
          version: CLI_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          node: process.versions.node,
        },
        gateway,
      };
      const g = gateway as { version?: string; protocolVersion?: number } | null;
      return {
        data,
        human: kv({
          psyche: `${CLI_VERSION} (protocol ${PROTOCOL_VERSION})`,
          gateway: g
            ? `${g.version ?? "unknown"}${g.protocolVersion ? ` (protocol ${g.protocolVersion})` : ""}`
            : "not reachable",
        }),
      };
    },
  },
];
