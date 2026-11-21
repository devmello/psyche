import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { bindingFor } from "../src/binding.ts";
import { machineCardOf } from "../src/broker.ts";
import {
  HOST_PROGRAM_ROOTS,
  type HostProgramFacts,
  hostProgramGrantCovers,
  hostProgramRefusal,
} from "../src/host-program.ts";
import { CTX, call, makeBroker, memoryDb, sqliteBroker } from "./helpers.ts";

/**
 * H5 (linux-helper-only §5.1): a machine command's binding and program-grant key carry the
 * machine. Must-refuse and must-allow rows.
 */

const SHA = `sha256:${"b".repeat(64)}`;

describe("exec_host binding on a machine", () => {
  const base = { argv: ["ls"], cwd: "/home/dev/proj" };
  const allow: [string, Record<string, unknown>][] = [
    [
      "a machine command bound to the box's hash",
      { ...base, machine: "dev_a", executableSha256: SHA },
    ],
    [
      "a machine command with the box's path, hash, network and containment",
      {
        ...base,
        machine: "dev_a",
        executable: "/usr/bin/ls",
        executableSha256: SHA,
        network: "on",
        contained: false,
      },
    ],
    [
      "a Host command with its binary and hash",
      { ...base, executable: "/bin/ls", executableSha256: SHA },
    ],
  ];
  it.each(allow)("allows %s", (_l, args) => {
    expect(() => bindingFor("exec_host", args)).not.toThrow();
  });
  const refuse: [string, string, Record<string, unknown>][] = [
    ["a Host command without a hash", "exec_host", { ...base, executable: "/bin/ls" }],
    ["a Host command without a binary", "exec_host", { ...base, executableSha256: SHA }],
    // Review r1 finding 10: the card binds the hash of the file the box will run.
    ["a machine command without the box's hash", "exec_host", { ...base, machine: "dev_a" }],
    [
      "a machine command with only a path",
      "exec_host",
      { ...base, machine: "dev_a", executable: "/bin/ls" },
    ],
    [
      "a machine command with the Host's proxy network",
      "exec_host",
      { ...base, machine: "dev_a", executableSha256: SHA, network: "proxy" },
    ],
    [
      "a Host command with a machine's network",
      "exec_host",
      { ...base, executable: "/bin/ls", executableSha256: SHA, network: "on" },
    ],
    [
      "a Host command claiming containment",
      "exec_host",
      { ...base, executable: "/bin/ls", executableSha256: SHA, contained: true },
    ],
    [
      "a non-boolean containment",
      "exec_host",
      { ...base, machine: "dev_a", executableSha256: SHA, contained: "yes" },
    ],
    ["an empty machine", "exec_host", { ...base, machine: "" }],
    ["a sandbox exec on a machine", "exec", { ...base, executable: "/bin/ls", machine: "dev_a" }],
  ];
  it.each(refuse)("refuses %s", (_l, kind, args) => {
    expect(() => bindingFor(kind as "exec_host", args)).toThrow();
  });
  it("the machine is in the binding and the grant key: A, B and the Host differ", () => {
    const a = bindingFor("exec_host", { ...base, machine: "dev_a", executableSha256: SHA });
    const b = bindingFor("exec_host", { ...base, machine: "dev_b", executableSha256: SHA });
    const host = bindingFor("exec_host", { ...base, executable: "/bin/ls", executableSha256: SHA });
    expect(new Set([a.bindingHash, b.bindingHash, host.bindingHash]).size).toBe(3);
    expect(new Set([a.grantKey, b.grantKey, host.grantKey]).size).toBe(3);
    expect(a.fields).toMatchObject({ machine: "dev_a" });
  });
});

describe("program grants are keyed on the computer", () => {
  const facts: HostProgramFacts = {
    argv: ["ls", "-la"],
    cwd: "/tmp",
    executable: "/bin/ls",
    sha256: SHA,
    cwdReal: "/tmp",
  };
  const ctx = {
    platform: "darwin" as const,
    roots: HOST_PROGRAM_ROOTS,
    inGrantedFolder: () => false,
  };

  it("is never offered for a machine command, and still is for the Host", () => {
    expect(hostProgramRefusal({ ...facts, machine: "dev_a" }, ctx)).toBe("machine");
    expect(hostProgramRefusal(facts, ctx)).not.toBe("machine");
  });

  it("a Host grant never covers a machine command, nor one machine's another's", () => {
    const grant = { executable: "/bin/ls", sha256: SHA, folder: "/tmp", argv: null };
    // (grant machine, call machine, may cover)
    const rows: [string | null | undefined, string | undefined, boolean][] = [
      [undefined, "dev_a", false],
      [null, "dev_a", false],
      ["dev_a", undefined, false],
      ["dev_a", "dev_b", false],
    ];
    for (const [g, f, want] of rows) {
      const covers = hostProgramGrantCovers(
        { ...grant, ...(g === undefined ? {} : { machine: g }) },
        { ...facts, ...(f === undefined ? {} : { machine: f }) },
      );
      expect(covers, `${g} -> ${f}`).toBe(want);
    }
  });
});

describe("exec_host on a machine: what runs and how is in the grant key", () => {
  const base = { argv: ["ls"], cwd: "/home/dev/proj", machine: "dev_a", executableSha256: SHA };
  it("another hash, containment or network is another grant", () => {
    const keys = [
      base,
      { ...base, executableSha256: `sha256:${"c".repeat(64)}` },
      { ...base, contained: true },
      { ...base, contained: false },
      { ...base, network: "on" },
    ].map((a) => bindingFor("exec_host", a).grantKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("an H5 card names its machine (approval.machine)", () => {
  const m = { deviceId: "dev_a", name: "lab-box" };
  const on = (machine: unknown) => ({ onMachine: true, machine });
  const rows: [string, string, unknown, boolean][] = [
    ["a machine command", "exec_host", on(m), true],
    ["a machine file card", "connector_action", { tool: "machine_files", machine: m }, true],
    ["a machine folder request", "permission_request", { tool: "machine_files", machine: m }, true],
    ["a Host command", "exec_host", { machine: m }, false],
    ["another tool's details", "connector_action", { tool: "other", machine: m }, false],
    ["a name with a bidi control", "exec_host", on({ ...m, name: "lab‮box" }), false],
    ["no device id", "exec_host", on({ name: "lab-box" }), false],
    ["a device id too long", "exec_host", on({ ...m, deviceId: "d".repeat(65) }), false],
  ];
  it.each(rows)("%s", (_l, kind, details, named) => {
    const got = machineCardOf(kind as "exec_host", details);
    if (named) expect(got).toEqual(m);
    else expect(got).toBeUndefined();
  });

  it("the SQLite store gives the machine back after a restart", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const issued = await sqliteBroker(db, clock).requestApproval({
      kind: "exec_host",
      summary: "Run `ls` on lab-box",
      details: { onMachine: true, machine: m, argv: ["ls"], cwd: "/home/dev/proj" },
      bindingHash: SHA,
      grantKey: "exec_host|machine|dev_a",
      requestedBy: { runId: "run_1", taskId: null, threadId: "thr_1", toolCallId: "call_1" },
      sideEffect: "destructive",
      surfaces: ["desktop"],
      taint: false,
    });
    expect(issued.approval.machine).toEqual(m);
    const again = sqliteBroker(db, clock);
    expect((await again.get(issued.approval.id))?.machine).toEqual(m);
  });
});

describe("a file change on a machine asks every time, once only (review r1 finding 5)", () => {
  const onBox = (op: string, se: "write" | "destructive") =>
    call(
      "machine_files",
      se,
      { kind: "path", value: "lab-box:/home/dev/x" },
      { params: { op, machine: "lab-box", path: "/home/dev/x" } },
    );
  it.each(["write", "mkdir", "remove"])("%s", async (op) => {
    const h = makeBroker();
    const d = await h.broker.decide(onBox(op, "destructive"), CTX);
    expect(d).toMatchObject({
      decision: "ask",
      rule: "machine_files:change",
      scopesOffered: ["once"],
    });
  });
  it("a copy into the Library may still be kept (one grant per machine, D4)", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(onBox("copy_to_host", "write"), CTX);
    expect(d.rule).not.toBe("machine_files:change");
  });
});
