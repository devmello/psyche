import type { PluginSummarySchema } from "@psyche/protocol";
import { ago } from "./ids.ts";

/**
 * Settings → Skills → Plugins: installed code plugins (`plugins.list`). One of each status the
 * Gateway reports, so previews and tests show every row state.
 */
export function plugins(): PluginSummarySchema[] {
  return [
    {
      name: "meeting-notes",
      version: "1.2.0",
      description: "Adds the notes from a meeting to the context of the next reply.",
      capabilities: ["context", "agent_end"],
      source: "/opt/psyche-fixtures/plugins/meeting-notes",
      hash: "sha256:3f1c9a2b7d4e",
      enabled: true,
      status: "active",
      installedAt: ago(60 * 24 * 3),
      adds: { skills: 2, commands: 1, mcpServers: 0, hooks: 1 },
    },
    {
      name: "citation-check",
      version: "0.4.1",
      description: "Checks that quoted sources in an answer exist before it is sent.",
      capabilities: ["after_tool_call", "evaluate"],
      source: "/opt/psyche-fixtures/plugins/citation-check",
      hash: "sha256:9b07e4d15a6c",
      enabled: true,
      status: "failed",
      installedAt: ago(60 * 24 * 10),
      error: "The plugin process stopped answering.",
    },
    {
      name: "tone-guard",
      version: "2.0.0",
      description: "Asks before a reply uses a phrase from the owner's blocklist.",
      capabilities: ["before_tool_call"],
      source: "/opt/psyche-fixtures/plugins/tone-guard",
      hash: "sha256:e62d0a8f31b9",
      enabled: false,
      status: "disabled",
      installedAt: ago(60 * 24 * 21),
    },
  ];
}
