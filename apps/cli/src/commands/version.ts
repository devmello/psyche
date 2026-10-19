import { PROTOCOL_VERSION } from "@psyche/protocol";
import type { CommandSpec } from "../command.ts";
import { kv } from "../output.ts";
import { CLI_VERSION } from "../version.ts";

export const versionCommands: CommandSpec[] = [
  {
    path: ["version"],
    summary: "Show the CLI and Gateway versions",
    async run(ctx) {
      // A bad --url is a usage error (exit 2); an unreachable Gateway is just "not reachable".
      const probe = await ctx.probe();
      const gateway: unknown = probe.reachable ? (probe.version ?? { version: "unknown" }) : null;
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
