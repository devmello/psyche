import { describe, expect, it } from "vitest";
import { bindingFor } from "../src/binding.ts";
import {
  HOST_PROGRAM_ROOTS,
  type HostProgramFacts,
  hostProgramGrantCovers,
  hostProgramRefusal,
} from "../src/host-program.ts";

/**
 * H5 (linux-helper-only §5.1): a machine command's binding and program-grant key carry the
 * machine. Must-refuse and must-allow rows.
 */

const SHA = `sha256:${"b".repeat(64)}`;

describe("exec_host binding on a machine", () => {
  const base = { argv: ["ls"], cwd: "/home/dev/proj" };
  const allow: [string, Record<string, unknown>][] = [
    ["a machine command without a Host binary", { ...base, machine: "dev_a" }],
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
    [
      "a machine command naming a Host binary",
      "exec_host",
      { ...base, machine: "dev_a", executable: "/bin/ls" },
    ],
    [
      "a machine command naming a Host hash",
      "exec_host",
      { ...base, machine: "dev_a", executableSha256: SHA },
    ],
    ["an empty machine", "exec_host", { ...base, machine: "" }],
    ["a sandbox exec on a machine", "exec", { ...base, executable: "/bin/ls", machine: "dev_a" }],
  ];
  it.each(refuse)("refuses %s", (_l, kind, args) => {
    expect(() => bindingFor(kind as "exec_host", args)).toThrow();
  });
  it("the machine is in the binding and the grant key: A, B and the Host differ", () => {
    const a = bindingFor("exec_host", { ...base, machine: "dev_a" });
    const b = bindingFor("exec_host", { ...base, machine: "dev_b" });
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
