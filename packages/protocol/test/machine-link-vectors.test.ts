import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ComputerMachineRef,
  MACHINE_LINK_PREFIX,
  MachineInfo,
  MachineLinkError,
  Methods,
  machineNameOk,
  parseMachineLink,
} from "../src/index.ts";

interface VectorCase {
  label: string;
  url?: string;
  pin?: boolean;
  body?: string;
  expect: "accept" | "refuse";
  gatewayUrl?: string;
  problem?: string;
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors/machine-link.json"), "utf8"),
) as { constants: Record<"KEY" | "TOKEN" | "PIN", string>; cases: VectorCase[] };

const fill = (text: string) =>
  text
    .replaceAll("$KEY", vectors.constants.KEY)
    .replaceAll("$TOKEN", vectors.constants.TOKEN)
    .replaceAll("$PIN", vectors.constants.PIN);

function linkOf(c: VectorCase): string {
  const body =
    c.body !== undefined
      ? fill(c.body)
      : JSON.stringify({
          gatewayUrl: c.url,
          gatewayKey: vectors.constants.KEY,
          ...(c.pin ? { certPin: vectors.constants.PIN } : {}),
          setupToken: vectors.constants.TOKEN,
          hostName: "H",
        });
  return `${MACHINE_LINK_PREFIX}${Buffer.from(body).toString("base64url")}`;
}

describe("psyche-machine:v1 shared vectors (the Rust parser must agree)", () => {
  it("has both columns", () => {
    expect(vectors.cases.filter((c) => c.expect === "accept").length).toBeGreaterThan(8);
    expect(vectors.cases.filter((c) => c.expect === "refuse").length).toBeGreaterThan(50);
  });

  it.each(vectors.cases.map((c) => [c.label, c] as const))("%s", (_label, c) => {
    const link = linkOf(c);
    if (c.expect === "accept") {
      const parsed = parseMachineLink(link);
      // The canonical origin, as URL.origin writes it; never the text as given.
      expect(parsed.gatewayUrl).toBe(c.gatewayUrl);
      expect(parsed.certPin !== undefined).toBe(c.pin === true);
      return;
    }
    let error: unknown;
    try {
      parseMachineLink(link);
    } catch (err) {
      error = err;
    }
    expect(error, "must be refused").toBeInstanceOf(MachineLinkError);
    if (c.problem !== undefined) expect((error as MachineLinkError).problem).toBe(c.problem);
  });
});

describe("machine names", () => {
  const ID = "dev_abc";
  const good = ["lab-box", "Büro PC", "日本語のPC", "a", "x".repeat(64), "my lab box 2"];
  const bad: [string, string][] = [
    ["empty", ""],
    ["blank", "   "],
    ["leading space", " lab"],
    ["trailing space", "lab "],
    ["newline", "lab\nbox"],
    ["tab", "lab\tbox"],
    ["right-to-left override", "lab‮box"],
    ["left-to-right isolate", "lab⁦box"],
    ["bidi mark", "lab‏box"],
    ["zero-width space", "lab​box"],
    ["zero-width joiner", "lab‍box"],
    ["word joiner", "lab⁠box"],
    ["BOM", "﻿lab"],
    ["soft hyphen", "lab­box"],
    ["hangul filler", "labㅤbox"],
    ["variation selector", "lab️box"],
    ["tag character", "lab\u{e0041}box"],
    ["C1 control", "lab\u0085box"],
    ["line separator", "lab box"],
    ["braille blank only", "⠀"],
    ["braille blank inside", "lab⠀box"],
    ["Arabic number sign", "lab؀box"],
    ["Arabic end of ayah", "lab۝box"],
    ["Syriac abbreviation mark", "lab܏box"],
    ["Arabic disputed end of ayah", "lab࣢box"],
    ["Kaithi number sign above", "lab\u{110bd}box"],
    ["musical symbol begin beam", "lab\u{1d173}box"],
    ["shorthand format letter overlap", "lab\u{1bca0}box"],
    ["Egyptian hieroglyph format", "lab\u{13430}box"],
    ["variation selector supplement", "lab\u{e0100}box"],
    ["Arabic pound mark above", "lab࢐box"],
    ["Arabic piastre mark above", "lab࢑box"],
    ["Kaithi number above", "lab\u{110cd}box"],
    ["default-ignorable E01F0", "lab\u{e01f0}box"],
    ["default-ignorable E0FFF", "lab\u{e0fff}box"],
    ["object replacement", "lab￼box"],
    ["ideographic space inside", "lab　box"],
    ["no-break space inside", "lab box"],
    ["only invisible characters", "⁠​⠀"],
    ["too long", "x".repeat(65)],
  ];

  it.each(good)("accepts %s", (name) => {
    expect(machineNameOk(name)).toBe(true);
    expect(Value.Check(ComputerMachineRef, { deviceId: ID, name })).toBe(true);
  });

  it.each(bad)("refuses %s everywhere a machine name goes", (_label, name) => {
    expect(machineNameOk(name)).toBe(false);
    expect(Value.Check(ComputerMachineRef, { deviceId: ID, name })).toBe(false);
    expect(Value.Check(Methods["machines.rename"].params, { id: "mch_1", name })).toBe(false);
    const info = {
      id: "mch_1",
      deviceId: ID,
      name,
      platform: "linux",
      status: "online",
      display: null,
      surfaces: [],
      exec: { enabled: false, contained: true },
      files: { roots: [] },
      account: "own",
      policyOwner: "root",
      passwordlessSudo: false,
      helperVersion: null,
      lastSeenAt: null,
    };
    expect(Value.Check(MachineInfo, info)).toBe(false);
    expect(Value.Check(MachineInfo, { ...info, name: "lab-box" })).toBe(true);
  });

  it("refuses non-strings", () => {
    expect(machineNameOk(5)).toBe(false);
    for (const lone of ["a\udb40b", "a\udc00b", "ab\ud83d"])
      expect(machineNameOk(lone)).toBe(false);
    expect(machineNameOk(undefined)).toBe(false);
  });
});
