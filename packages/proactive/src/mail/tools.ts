import type { ToolLookup } from "../proposals/service.ts";

/** Runs a read tool outside the agent loop (no model; the result is untrusted data). */
export async function readTool(
  tools: ToolLookup,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const reg = tools.get(tool);
  if (reg === undefined) return undefined;
  const callId = `workflow:${tool}:${Math.random().toString(36).slice(2)}`;
  const signal = new AbortController().signal;
  const r =
    "run" in reg && reg.run !== undefined
      ? await reg.run(params, {
          callId,
          threadId: "system:mail",
          runId: "mail-workflow",
          taint: true,
          permissionMode: "balanced",
          mode: "unattended",
          signal,
          onUpdate: () => {},
        })
      : await reg.execute(callId, params, signal, () => {});
  if (r.isError === true) throw new Error(`${tool} failed`);
  return r.output;
}
