import { PassThrough } from "node:stream";
import type { CliDriver, CliOptions, CliResult, CliStream } from "../src/cli.ts";

export interface RecordedCall {
  file: string;
  args: string[];
  options: CliOptions;
}

export type Responder = (
  args: string[],
  options: CliOptions,
) => Partial<CliResult> | undefined | Promise<Partial<CliResult> | undefined>;

/**
 * Records every CLI invocation and answers from a responder (default: success, empty output).
 * Nothing is spawned.
 */
export class FakeDriver implements CliDriver {
  readonly calls: RecordedCall[] = [];
  respond: Responder = () => undefined;

  start(file: string, args: readonly string[], options: CliOptions = {}) {
    const call = { file, args: [...args], options };
    this.calls.push(call);
    const done = Promise.resolve(this.respond(call.args, options)).then(
      (r): CliResult => ({
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
        ...r,
      }),
    );
    return { pid: 1, done, kill: () => undefined };
  }

  stream(file: string, args: readonly string[]): CliStream {
    this.calls.push({ file, args: [...args], options: {} });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    return {
      stdin,
      stdout,
      stderr,
      exited: new Promise(() => undefined),
      kill: () => undefined,
    };
  }

  /** Calls whose argv starts with `prefix`. */
  find(...prefix: string[]): RecordedCall[] {
    return this.calls.filter((c) => prefix.every((p, i) => c.args[i] === p));
  }
}
