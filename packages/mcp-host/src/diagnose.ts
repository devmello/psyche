import { RUNTIME_MISSING_TEXT } from "./runtime.ts";

/**
 * Why a stdio server did not start, from the error the host recorded and the server's stderr
 * tail. `next` names the owner's next step (the UI has the words, keyed by this code).
 */
export type LaunchFailure =
  | "no_srt"
  | "node_missing"
  | "uv_missing"
  | "command_not_found"
  | "network_blocked"
  | "timeout"
  | "exited"
  | "failed";

export interface LaunchDiagnosis {
  failure: LaunchFailure;
  /** One English sentence for logs and non-UI clients. */
  summary: string;
  exitCode?: number;
}

const NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|getaddrinfo|network is unreachable|could not resolve|failed to fetch|403 forbidden|proxy|unable to get local issuer|registry\.npmjs\.org|pypi\.org/i;

export function diagnoseLaunch(error: string, stderr: string): LaunchDiagnosis {
  const text = `${error}\n${stderr}`;
  const code = /exit(?:ed)?(?: with)?(?: status| code)?[: ]+(\d{1,3})\b/i.exec(text)?.[1];
  const exitCode = code === undefined ? undefined : Number(code);
  const withCode = exitCode === undefined ? {} : { exitCode };
  if (error.includes(RUNTIME_MISSING_TEXT.node)) {
    return { failure: "node_missing", summary: RUNTIME_MISSING_TEXT.node };
  }
  if (error.includes(RUNTIME_MISSING_TEXT.uv)) {
    return { failure: "uv_missing", summary: RUNTIME_MISSING_TEXT.uv };
  }
  if (/srt is not available/i.test(error)) {
    return { failure: "no_srt", summary: "The sandbox (srt) is not installed yet" };
  }
  if (/ENOENT|not found|no such file/i.test(error) && !NETWORK.test(stderr)) {
    return { failure: "command_not_found", summary: "The server's command was not found" };
  }
  if (NETWORK.test(stderr)) {
    return {
      failure: "network_blocked",
      summary: "The server could not download its package or reach the network",
      ...withCode,
    };
  }
  if (/timed? ?out|-32001|ETIMEDOUT/i.test(text)) {
    return { failure: "timeout", summary: "The server took too long to start", ...withCode };
  }
  if (stderr.trim() !== "" || /closed|exit/i.test(error)) {
    return { failure: "exited", summary: "The server stopped right after it started", ...withCode };
  }
  return { failure: "failed", summary: "The server did not start", ...withCode };
}
