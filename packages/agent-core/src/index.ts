import { NotImplementedError, type AgentLoop } from "@psyche/protocol";

/**
 * Placeholder for the `AgentLoop` implementation owned by S02.
 * Build against `FakeAgentLoop` from `@psyche/testing` until this lands.
 */
export function createAgentLoop(): AgentLoop {
  throw new NotImplementedError("@psyche/agent-core", "createAgentLoop");
}
