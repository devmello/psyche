import { PassThrough } from "node:stream";
import type { CliDriver, CliOptions, CliResult, CliStream } from "../src/cli.ts";
import { FILES_HELPER } from "../src/scripts.ts";

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
 * Nothing is spawned. Invocations of the in-container file helper that the responder leaves
 * unanswered are served from `workspace`, an in-memory `/workspace` (list, stat, read, write,
 * edit), so file-API tests need no container.
 */
export class FakeDriver implements CliDriver {
  readonly calls: RecordedCall[] = [];
  respond: Responder = () => undefined;
  /** Workspace-relative path → bytes. Mutate it to simulate writes the runner did not see. */
  readonly workspace = new Map<string, Buffer>();

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
        ...(r ?? this.#filesHelper(call.args, options)),
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

  #filesHelper(args: string[], options: CliOptions): Partial<CliResult> | undefined {
    const at = args.indexOf(FILES_HELPER);
    if (at < 0) return undefined;
    const [op, rel, cap] = args.slice(at + 1);
    const failWith = (code: string, message: string): Partial<CliResult> => ({
      exitCode: 3,
      stderr: Buffer.from(JSON.stringify({ code, message })),
    });
    const json = (value: unknown): Partial<CliResult> => ({
      stdout: Buffer.from(JSON.stringify(value)),
    });
    const input = Buffer.from(options.input ?? "");
    switch (op) {
      case "list": {
        const prefix = rel === "" || rel === undefined ? "" : `${rel}/`;
        const names = new Map<string, { kind: "file" | "dir"; size: number }>();
        for (const [path, bytes] of this.workspace) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash < 0) names.set(rest, { kind: "file", size: bytes.length });
          else names.set(rest.slice(0, slash), { kind: "dir", size: 0 });
        }
        const entries = [...names]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, e]) => ({ name, kind: e.kind, size: e.size, mtimeMs: 0 }));
        return json({ entries, truncated: false });
      }
      case "stat": {
        const bytes = this.workspace.get(rel ?? "");
        if (bytes !== undefined) return json({ kind: "file", size: bytes.length, mtimeMs: 0 });
        const isDir = rel === "" || [...this.workspace.keys()].some((p) => p.startsWith(`${rel}/`));
        return isDir
          ? json({ kind: "dir", size: 0, mtimeMs: 0 })
          : failWith("not_found", `${rel} does not exist`);
      }
      case "read": {
        const bytes = this.workspace.get(rel ?? "");
        if (bytes === undefined) return failWith("not_found", `${rel} does not exist`);
        return { stdout: Buffer.from(bytes) };
      }
      case "write": {
        if (input.length > Number(cap)) return failWith("invalid_params", "content too large");
        this.workspace.set(rel as string, Buffer.from(input));
        return json({ size: input.length });
      }
      case "edit": {
        const bytes = this.workspace.get(rel ?? "");
        if (bytes === undefined) return failWith("not_found", `${rel} does not exist`);
        const req = JSON.parse(input.toString("utf8")) as {
          old: string;
          new: string;
          all?: boolean;
        };
        const text = bytes.toString("utf8");
        const n = text.split(req.old).length - 1;
        if (n === 0) return failWith("not_found", "the text to replace was not found");
        if (n > 1 && req.all !== true) return failWith("conflict", "ambiguous");
        const out =
          req.all === true ? text.replaceAll(req.old, req.new) : text.replace(req.old, req.new);
        this.workspace.set(rel as string, Buffer.from(out, "utf8"));
        return json({ replacements: req.all === true ? n : 1 });
      }
      default:
        return failWith("invalid_params", `unknown op ${op}`);
    }
  }
}
