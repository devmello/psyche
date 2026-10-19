import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildSchemaDocument,
  generateAll,
  OUTPUT_FILES,
  renderSchemaJson,
} from "../scripts/gen.ts";
import { BridgeEvents, BridgeMethods, Events, Methods, PROTOCOL_VERSION } from "../src/index.ts";

type Entry = { name: string; params?: string; result?: string; payload?: string; scope?: string };

function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) refs(n, out);
  else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else refs(v, out);
    }
  }
  return out;
}

describe("codegen", () => {
  const doc = buildSchemaDocument();
  const defs = doc.$defs as Record<string, unknown>;
  const x = doc["x-psyche"] as Record<string, unknown>;

  it("generated/schema.json is fresh (run `pnpm protocol:gen`)", async () => {
    expect(await readFile(OUTPUT_FILES.schema, "utf8")).toBe(renderSchemaJson(doc));
  });

  it("is deterministic", () => {
    expect(renderSchemaJson(buildSchemaDocument())).toBe(renderSchemaJson(doc));
    expect(renderSchemaJson(doc).endsWith("}\n")).toBe(true);
  });

  it("is draft 2020-12 with resolvable refs and no nested $id", () => {
    expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(x.protocolVersion).toBe(PROTOCOL_VERSION);
    for (const ref of refs(doc)) {
      expect(ref.startsWith("#/$defs/"), ref).toBe(true);
      expect(defs[ref.slice("#/$defs/".length)], ref).toBeDefined();
    }
    expect(JSON.stringify(defs)).not.toContain('"$id"');
  });

  it("lists every method and event with schema refs", () => {
    const methods = x.methods as Entry[];
    const events = x.events as Entry[];
    expect(methods.map((m) => m.name)).toEqual(Object.keys(Methods).sort());
    expect(events.map((e) => e.name)).toEqual(Object.keys(Events).sort());
    expect((x.bridgeMethods as Entry[]).map((m) => m.name)).toEqual(
      Object.keys(BridgeMethods).sort(),
    );
    expect((x.bridgeEvents as Entry[]).map((e) => e.name)).toEqual(
      Object.keys(BridgeEvents).sort(),
    );
    const connect = methods.find((m) => m.name === "connect");
    expect(connect).toMatchObject({
      scope: "none",
      params: "#/$defs/ConnectParams",
      result: "#/$defs/ConnectChallenge",
    });
    expect(methods.find((m) => m.name === "threads.create")?.params).toBe(
      "#/$defs/ThreadsCreateParams",
    );
    expect(events.find((e) => e.name === "chat.delta")?.payload).toBe("#/$defs/ChatDeltaPayload");
    for (const name of [
      "ReqFrame",
      "ResOkFrame",
      "ResErrFrame",
      "EventFrame",
      "Frame",
      "Thread",
      "Block",
    ]) {
      expect(defs[name], name).toBeDefined();
    }
  });

  it("every generated file on disk matches a fresh generation", { timeout: 60_000 }, async () => {
    const outputs = await generateAll();
    for (const [path, content] of outputs) {
      expect(await readFile(path, "utf8"), path).toBe(content);
    }
    const swift = outputs.get(OUTPUT_FILES.swift) ?? "";
    expect(swift).toContain("public struct ConnectParams: Codable, Sendable");
    expect(swift).not.toMatch(/Alamofire/);
    expect(outputs.get(OUTPUT_FILES.swiftHelper)).toBe(swift);
    expect(outputs.get(OUTPUT_FILES.typescript)).toContain("export interface ConnectParams");
  });
});
