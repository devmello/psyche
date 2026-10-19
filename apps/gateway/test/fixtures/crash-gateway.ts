// Child process for the restart test: a Gateway whose agent streams a delta, starts a tool
// call and then hangs, so the test can SIGKILL it "between model events".
import { join } from "node:path";
import type { AgentEvent, AgentLoop, StartTurnInput } from "@psyche/protocol";
import { silentLogger } from "../../src/log.ts";
import { startGateway } from "../../src/server.ts";

class HangingLoop implements AgentLoop {
  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    yield {
      type: "chat.delta",
      runId: input.runId,
      messageId: `m_${input.runId}`,
      delta: "half a thought",
    };
    yield {
      type: "tool_call",
      runId: input.runId,
      toolCallId: `tc_${input.runId}`,
      tool: "fs.write",
      status: "running",
      level1: "Writing notes.md",
      details: {
        sideEffect: "write",
        paramsRedacted: { path: "notes.md" },
        paramsHash: "sha256:00",
      },
    };
    await new Promise(() => {}); // never resolves: the process is killed here
  }
  async steer() {}
  async followUp() {}
  async cancel() {}
}

const home = process.env.PSYCHE_HOME as string;
const gateway = await startGateway({
  config: { home, port: 0, dbPath: join(home, "state", "psyche.sqlite"), webRoot: null },
  env: {},
  logger: silentLogger,
  agent: new HangingLoop(),
  retentionIntervalMs: 0,
});
process.stdout.write(`READY ${gateway.port} ${gateway.handshakeSecret}\n`);
