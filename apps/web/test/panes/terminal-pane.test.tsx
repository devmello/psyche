// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalOpenResult, TerminalPort } from "../../src/shell/platform.ts";

// xterm needs canvas and layout that happy-dom lacks: test the wiring against a fake.
const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    written: string[] = [];
    disposed = false;
    #input = new Set<(data: string) => void>();
    constructor() {
      FakeTerminal.instances.push(this);
    }
    loadAddon() {}
    open() {}
    write(data: string) {
      this.written.push(data);
    }
    onData(cb: (data: string) => void) {
      this.#input.add(cb);
      return { dispose: () => this.#input.delete(cb) };
    }
    type(data: string) {
      for (const cb of this.#input) cb(data);
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { FakeTerminal };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const { TerminalPane, splitForWrite } = await import("../../src/shell/panes/TerminalPane.tsx");

function fakePort(openResult: TerminalOpenResult | { unavailable: string }) {
  const data = new Set<(id: string, data: string) => void>();
  const exit = new Set<(id: string, code: number) => void>();
  const port = {
    open: vi.fn(async () => openResult),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onData: (cb: (id: string, data: string) => void) => {
      data.add(cb);
      return () => data.delete(cb);
    },
    onExit: (cb: (id: string, code: number) => void) => {
      exit.add(cb);
      return () => exit.delete(cb);
    },
  } satisfies TerminalPort;
  return {
    port,
    emitData: (id: string, d: string) => {
      for (const cb of data) cb(id, d);
    },
    emitExit: (id: string, code: number) => {
      for (const cb of exit) cb(id, code);
    },
  };
}

const opened: TerminalOpenResult = {
  sessionId: "term_1",
  target: "sandbox",
  label: "container · network: none · ~/workspace",
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  xterm.FakeTerminal.instances.length = 0;
});

describe("TerminalPane", () => {
  it("opens a session for the thread and shows its label", async () => {
    const { port } = fakePort(opened);
    render(<TerminalPane port={port} threadId="thr_1" cwd="~/workspace" />);
    await flush();
    expect(port.open).toHaveBeenCalledWith({
      threadId: "thr_1",
      cwd: "~/workspace",
      cols: 80,
      rows: 24,
    });
    expect(screen.getByText(opened.label)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "shell 1" })).toBeTruthy();
  });

  it("sends keystrokes to the port and writes port data to the terminal", async () => {
    const { port, emitData } = fakePort(opened);
    render(<TerminalPane port={port} threadId="thr_1" />);
    await flush();
    const term = xterm.FakeTerminal.instances[0];
    term?.type("ls\r");
    expect(port.write).toHaveBeenCalledWith("term_1", "ls\r");
    emitData("term_1", "file.txt\r\n");
    emitData("term_other", "not mine");
    expect(term?.written).toEqual(["file.txt\r\n"]);
  });

  it("shows the exit code, keeps the terminal and stops input", async () => {
    const onExit = vi.fn();
    const { port, emitData, emitExit } = fakePort(opened);
    render(<TerminalPane port={port} threadId="thr_1" onExit={onExit} />);
    await flush();
    emitData("term_1", "bye\r\n");
    act(() => emitExit("term_1", 2));
    expect(screen.getByRole("status").textContent).toBe("exit 2");
    expect(onExit).toHaveBeenCalledWith("term_1", 2);
    const term = xterm.FakeTerminal.instances[0];
    expect(term?.disposed).toBe(false);
    expect(term?.written).toEqual(["bye\r\n"]);
    term?.type("x");
    expect(port.write).not.toHaveBeenCalled();
  });

  it("shows the port's message when no terminal is available", async () => {
    const message = "No sandbox backend is available. Psyche never falls back to the host shell.";
    const { port } = fakePort({ unavailable: message });
    render(<TerminalPane port={port} threadId="thr_1" />);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(port.write).not.toHaveBeenCalled();
  });

  it("opens another shell with + and closes sessions on tab close", async () => {
    const { port } = fakePort(opened);
    render(<TerminalPane port={port} threadId="thr_1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New shell" }));
    await flush();
    expect(port.open).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("tab", { name: "shell 2" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close shell 1" }));
    expect(port.close).toHaveBeenCalledWith("term_1");
    expect(xterm.FakeTerminal.instances[0]?.disposed).toBe(true);
  });
});

describe("splitForWrite", () => {
  it("keeps short input whole and never splits a surrogate pair", () => {
    expect(splitForWrite("abc")).toEqual(["abc"]);
    const chunks = splitForWrite(`ab${"😀"}cd`, 3);
    expect(chunks.join("")).toBe(`ab${"😀"}cd`);
    expect(chunks[0]).toBe("ab");
  });
});
