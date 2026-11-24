import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execTailscale, MAX_STATUS_BYTES, STATUS_TIMEOUT_MS } from "../src/lib/tailnet.ts";

// The real tailscale binary is never run: execFile is replaced for this file.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

type Callback = (err: unknown, stdout?: string) => void;

function answer(err: unknown, stdout = "") {
  vi.mocked(execFile).mockImplementationOnce(((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: Callback,
  ) => {
    cb(err, stdout);
  }) as unknown as typeof execFile);
}

describe("execTailscale", () => {
  beforeEach(() => vi.mocked(execFile).mockReset());

  it("runs the CLI with an argument array, no shell, a timeout and a stdout cap", async () => {
    answer(null, '{"BackendState":"Running"}');
    const res = await execTailscale("/usr/local/bin/tailscale", ["status", "--json"]);
    expect(res).toEqual({ ok: true, stdout: '{"BackendState":"Running"}' });
    const [file, args, opts] = vi.mocked(execFile).mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(file).toBe("/usr/local/bin/tailscale");
    expect(args).toEqual(["status", "--json"]);
    expect(opts.shell).toBeUndefined();
    expect(opts.timeout).toBe(STATUS_TIMEOUT_MS);
    expect(opts.maxBuffer).toBe(MAX_STATUS_BYTES);
    expect(STATUS_TIMEOUT_MS).toBe(3_000);
    expect(MAX_STATUS_BYTES).toBe(1024 * 1024);
  });

  it("maps a missing binary, a timeout, an oversized output and a failure", async () => {
    answer(Object.assign(new Error("spawn"), { code: "ENOENT" }));
    expect(await execTailscale("x", [])).toEqual({ ok: false, error: "enoent" });

    answer(Object.assign(new Error("big"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
    expect(await execTailscale("x", [])).toEqual({ ok: false, error: "too_large" });

    answer(Object.assign(new Error("slow"), { killed: true, signal: "SIGTERM" }));
    expect(await execTailscale("x", [])).toEqual({ ok: false, error: "timeout" });

    answer(Object.assign(new Error("exit 1"), { code: 1 }));
    expect(await execTailscale("x", [])).toEqual({ ok: false, error: "failed" });
  });
});
