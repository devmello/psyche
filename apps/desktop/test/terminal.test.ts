import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLUSH_BYTES,
  FLUSH_INTERVAL_MS,
  type GatewayCall,
  MAX_SESSIONS,
  MAX_WRITE_BYTES,
  MESSAGES,
  type PtyProcess,
  type PtySpawn,
  type PtySpawnOptions,
  parseTerminalTarget,
  TerminalHost,
} from "../src/main/terminal.ts";

class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  #data = new Set<(data: string) => void>();
  #exit = new Set<(e: { exitCode: number }) => void>();

  onData(listener: (data: string) => void) {
    this.#data.add(listener);
    return { dispose: () => this.#data.delete(listener) };
  }
  onExit(listener: (e: { exitCode: number }) => void) {
    this.#exit.add(listener);
    return { dispose: () => this.#exit.delete(listener) };
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  kill() {
    this.killed = true;
  }
  emitData(data: string) {
    for (const cb of this.#data) cb(data);
  }
  emitExit(exitCode: number) {
    for (const cb of this.#exit) cb({ exitCode });
  }
}

interface Spawned {
  file: string;
  args: string[];
  options: PtySpawnOptions;
  pty: FakePty;
}

const sandboxTarget = {
  target: "sandbox",
  argv: ["/usr/local/bin/container", "exec", "-it", "task-1", "/bin/sh"],
  cwd: "/Users/me/.psyche/workspaces/t1",
  env: { PSYCHE_TASK: "t1" },
  label: "container · network: none · ~/workspace",
};

function setup(call: GatewayCall = async () => sandboxTarget) {
  const spawned: Spawned[] = [];
  const spawn: PtySpawn = (file, args, options) => {
    const pty = new FakePty();
    spawned.push({ file, args, options, pty });
    return pty;
  };
  const callSpy = vi.fn(call);
  const host = new TerminalHost({ call: callSpy, spawn });
  return { host, spawned, call: callSpy };
}

function codeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`failed: ${code}`), { code });
}

async function openOk(host: TerminalHost): Promise<string> {
  const res = await host.open({ cols: 80, rows: 24 });
  if (!("sessionId" in res)) throw new Error(`unavailable: ${res.unavailable}`);
  return res.sessionId;
}

describe("TerminalHost.open", () => {
  it("spawns exactly the argv and cwd the Gateway returned", async () => {
    const { host, spawned, call } = setup();
    const res = await host.open({ threadId: "thr_1", cwd: "/x", cols: 100, rows: 30 });
    expect(res).toMatchObject({ target: "sandbox", label: sandboxTarget.label });
    expect(call).toHaveBeenCalledWith("terminal.open", {
      threadId: "thr_1",
      cwd: "/x",
      cols: 100,
      rows: 30,
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.file).toBe("/usr/local/bin/container");
    expect(spawned[0]?.args).toEqual(["exec", "-it", "task-1", "/bin/sh"]);
    expect(spawned[0]?.options).toMatchObject({ cwd: sandboxTarget.cwd, cols: 100, rows: 30 });
  });

  describe("environment", () => {
    beforeEach(() => {
      process.env.PSYCHE_SECRET_TEST = "s3cret";
    });
    afterEach(() => {
      delete process.env.PSYCHE_SECRET_TEST;
    });

    it("passes a minimal base plus the Gateway env, never process.env", async () => {
      const { host, spawned } = setup();
      await openOk(host);
      const env = spawned[0]?.options.env ?? {};
      expect(env.PSYCHE_SECRET_TEST).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(["LANG", "PATH", "PSYCHE_TASK", "TERM"]);
      expect(env.TERM).toBe("xterm-256color");
      expect(env.PSYCHE_TASK).toBe("t1");
      expect(Object.values(env)).not.toContain("s3cret");
    });
  });

  it.each([
    ["unknown_method", MESSAGES.notImplemented],
    ["not_implemented", MESSAGES.notImplemented],
    ["unavailable", MESSAGES.noSandbox],
  ])("maps %s to its message and spawns nothing", async (code, message) => {
    const { host, spawned } = setup(async () => {
      throw codeError(code);
    });
    expect(await host.open({ cols: 80, rows: 24 })).toEqual({ unavailable: message });
    expect(spawned).toHaveLength(0);
  });

  it("maps other errors to a short message", async () => {
    const { host, spawned } = setup(async () => {
      throw Object.assign(new Error("x".repeat(500)), { code: "internal" });
    });
    const res = await host.open({ cols: 80, rows: 24 });
    expect("unavailable" in res && res.unavailable.length).toBe(200);
    const { host: h2 } = setup(async () => {
      throw { code: "forbidden" };
    });
    expect(await h2.open({ cols: 80, rows: 24 })).toEqual({ unavailable: MESSAGES.failed });
    expect(spawned).toHaveLength(0);
  });

  it.each([
    ["null", null],
    ["a string", "/bin/sh"],
    ["an unknown target", { ...sandboxTarget, target: "vm" }],
    ["empty argv", { ...sandboxTarget, argv: [] }],
    ["relative argv[0]", { ...sandboxTarget, argv: ["sh", "-l"] }],
    ["non-string args", { ...sandboxTarget, argv: ["/bin/sh", 1] }],
    ["NUL in an arg", { ...sandboxTarget, argv: ["/bin/sh", "a\0b"] }],
    ["relative cwd", { ...sandboxTarget, cwd: "workspace" }],
    ["missing label", { ...sandboxTarget, label: "" }],
    ["array env", { ...sandboxTarget, env: ["A=1"] }],
    ["bad env key", { ...sandboxTarget, env: { "A=B": "1" } }],
    ["non-string env value", { ...sandboxTarget, env: { A: 1 } }],
  ])("rejects %s from the Gateway", async (_name, result) => {
    const { host, spawned } = setup(async () => result);
    expect(await host.open({ cols: 80, rows: 24 })).toEqual({
      unavailable: MESSAGES.invalidTarget,
    });
    expect(spawned).toHaveLength(0);
  });

  it("accepts a host target without env", () => {
    const { env: _env, ...rest } = sandboxTarget;
    expect(parseTerminalTarget({ ...rest, target: "host" })).toEqual({ ...rest, target: "host" });
  });

  it("reports a spawn failure without retrying anything else", async () => {
    const spawn = vi.fn<PtySpawn>(() => {
      throw new Error("posix_spawnp failed");
    });
    const host = new TerminalHost({ call: async () => sandboxTarget, spawn });
    const res = await host.open({ cols: 80, rows: 24 });
    expect(res).toEqual({ unavailable: `${MESSAGES.failed} posix_spawnp failed` });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it(`caps concurrent sessions at ${MAX_SESSIONS}, counting pending opens`, async () => {
    const { host, spawned } = setup();
    const opens = Array.from({ length: MAX_SESSIONS + 2 }, () => host.open({ cols: 80, rows: 24 }));
    const results = await Promise.all(opens);
    expect(results.filter((r) => "sessionId" in r)).toHaveLength(MAX_SESSIONS);
    expect(results.filter((r) => "unavailable" in r)).toEqual([
      { unavailable: MESSAGES.tooMany },
      { unavailable: MESSAGES.tooMany },
    ]);
    expect(spawned).toHaveLength(MAX_SESSIONS);
    const first = results.find((r) => "sessionId" in r);
    if (first && "sessionId" in first) host.close(first.sessionId);
    expect("sessionId" in (await host.open({ cols: 80, rows: 24 }))).toBe(true);
  });

  it("clamps the requested size before asking the Gateway", async () => {
    const { host, call } = setup();
    await host.open({ cols: 9999, rows: 0 });
    expect(call).toHaveBeenCalledWith("terminal.open", { cols: 500, rows: 1 });
  });
});

describe("TerminalHost sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clamps resize to 1..500 x 1..200", async () => {
    const { host, spawned } = setup();
    const id = await openOk(host);
    host.resize(id, 10_000, 10_000);
    host.resize(id, 0, -5);
    host.resize(id, Number.NaN, 40.7);
    expect(spawned[0]?.pty.resizes).toEqual([
      [500, 200],
      [1, 1],
      [1, 40],
    ]);
    expect(host.resize("term_nope", 80, 24)).toBe(false);
  });

  it("writes keystrokes and drops writes over 64 KB or to unknown sessions", async () => {
    const { host, spawned } = setup();
    const id = await openOk(host);
    expect(host.write(id, "ls\r")).toBe(true);
    expect(host.write(id, "a".repeat(MAX_WRITE_BYTES + 1))).toBe(false);
    expect(host.write("term_nope", "x")).toBe(false);
    expect(spawned[0]?.pty.writes).toEqual(["ls\r"]);
  });

  it(`batches output for ${FLUSH_INTERVAL_MS} ms`, async () => {
    const { host, spawned } = setup();
    const id = await openOk(host);
    const got: Array<[string, string]> = [];
    host.onData((sid, data) => got.push([sid, data]));
    const pty = spawned[0]?.pty;
    pty?.emitData("a");
    pty?.emitData("b");
    pty?.emitData("c");
    expect(got).toEqual([]);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(got).toEqual([[id, "abc"]]);
  });

  it(`flushes immediately at ${FLUSH_BYTES / 1024} KB`, async () => {
    const { host, spawned } = setup();
    await openOk(host);
    const got: string[] = [];
    host.onData((_sid, data) => got.push(data));
    spawned[0]?.pty.emitData("x".repeat(FLUSH_BYTES - 1));
    expect(got).toHaveLength(0);
    spawned[0]?.pty.emitData("y");
    expect(got).toHaveLength(1);
    expect(got[0]).toHaveLength(FLUSH_BYTES);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(got).toHaveLength(1);
    expect(host.sessionCount).toBe(1);
  });

  it("flushes pending output before the exit event and forgets the session", async () => {
    const { host, spawned } = setup();
    const id = await openOk(host);
    const events: string[] = [];
    host.onData((_sid, data) => events.push(`data:${data}`));
    host.onExit((sid, code) => events.push(`exit:${sid === id}:${code}`));
    spawned[0]?.pty.emitData("bye");
    spawned[0]?.pty.emitExit(3);
    expect(events).toEqual(["data:bye", "exit:true:3"]);
    expect(host.sessionCount).toBe(0);
    expect(host.write(id, "x")).toBe(false);
  });

  it("close kills the PTY without an exit event; closeAll closes everything", async () => {
    const { host, spawned } = setup();
    const a = await openOk(host);
    await openOk(host);
    const exits: string[] = [];
    host.onExit((sid) => exits.push(sid));
    host.close(a);
    expect(spawned[0]?.pty.killed).toBe(true);
    expect(host.sessionCount).toBe(1);
    host.closeAll();
    expect(spawned[1]?.pty.killed).toBe(true);
    expect(host.sessionCount).toBe(0);
    expect(exits).toEqual([]);
  });

  it("unsubscribes listeners", async () => {
    const { host, spawned } = setup();
    await openOk(host);
    const cb = vi.fn();
    const off = host.onData(cb);
    off();
    spawned[0]?.pty.emitData("z");
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(cb).not.toHaveBeenCalled();
  });
});
