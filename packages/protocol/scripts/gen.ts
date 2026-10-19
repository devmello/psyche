/**
 * Protocol codegen (`pnpm protocol:gen`, CI: `pnpm protocol:check`).
 *
 * Generator choice (ADR-015, docs/plans/s00.md): our own walk of the TypeBox schemas produces
 * `generated/schema.json` (JSON Schema draft 2020-12, one `$defs` entry per `$id`, plus an
 * `x-psyche` section describing every method and event); `quicktype-core` then turns that
 * document into TypeScript declarations (`generated/protocol.d.ts`) and Swift `Codable` structs
 * (`generated/swift/PsycheProtocol.swift`, copied to the mac helper's `PsycheProtocol` target).
 * quicktype avoids writing and maintaining a Swift emitter; its known weak spot is
 * discriminated unions (it merges `anyOf` object variants into one struct with optional fields).
 *
 * Steps:
 * 1. Walk every export of `src/index.ts`; each TypeBox schema with a string `$id` becomes a
 *    `$defs` entry. Method params/results and event payloads without an `$id` get a derived
 *    name (`threads.create` → `ThreadsCreateParams` / `ThreadsCreateResult`,
 *    `chat.delta` → `ChatDeltaPayload`).
 * 2. Nested schemas that carry an `$id` are replaced by `{"$ref": "#/$defs/<id>"}` so each type
 *    exists once. TypeBox's symbol keys (`Kind`, `OptionalKind`) disappear; `StringEnum` is
 *    already plain `{type: "string", enum}` JSON Schema.
 * 3. Keys are sorted (property order inside `properties` is kept as authored), `$defs` and the
 *    method / event lists are sorted by name, output is 2-space JSON with a trailing newline:
 *    byte-identical across runs, macOS and Linux.
 * 4. For quicktype the document is rewritten to the dialect it understands (`definitions`
 *    instead of `$defs`, `additionalProperties` instead of TypeBox's `"^(.*)$"`
 *    `patternProperties`) and every definition is added as a top-level type, so quicktype
 *    names one type per `$id`.
 *
 * `--check` regenerates in memory and exits 1 listing every stale or missing file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputData, JSONSchemaInput, quicktype } from "quicktype-core";
import * as protocol from "../src/index.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface RegistryEntry {
  readonly params?: unknown;
  readonly result?: unknown;
  readonly payload?: unknown;
  readonly scope?: string;
  readonly sideEffecting?: boolean;
  readonly description: string;
}

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(PACKAGE_DIR, "../..");

export const OUTPUT_FILES = {
  schema: resolve(PACKAGE_DIR, "generated/schema.json"),
  typescript: resolve(PACKAGE_DIR, "generated/protocol.d.ts"),
  swift: resolve(PACKAGE_DIR, "generated/swift/PsycheProtocol.swift"),
  swiftHelper: resolve(
    REPO_DIR,
    "apps/mac-helper/Sources/PsycheProtocol/PsycheProtocol.generated.swift",
  ),
} as const;

const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSchema(v: unknown): v is Record<string, unknown> {
  return (
    isObject(v) && Object.getOwnPropertySymbols(v).some((s) => s.description === "TypeBox.Kind")
  );
}

function pascal(name: string): string {
  return name
    .split(/[._-]/)
    .filter((p) => p.length > 0)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join("");
}

/** Deterministic JSON: keys sorted except the property names inside `properties`. */
function canonical(value: Json, keepOrder = false): Json {
  if (Array.isArray(value)) return value.map((v) => canonical(v));
  if (value === null || typeof value !== "object") return value;
  const keys = keepOrder ? Object.keys(value) : Object.keys(value).sort();
  const out: JsonObject = {};
  for (const key of keys) {
    const child = value[key] as Json;
    out[key] = canonical(child, key === "properties" && isObject(child) && !keepOrder);
  }
  return out;
}

class DefsBuilder {
  readonly defs = new Map<string, JsonObject>();
  private readonly sources = new Map<string, unknown>();

  /** Registers a schema under `name` and returns a `$ref` to it. */
  add(name: string, schema: Record<string, unknown>): Json {
    const ref: Json = { $ref: `#/$defs/${name}` };
    const known = this.sources.get(name);
    if (known === schema) return ref;
    this.sources.set(name, schema);
    const converted = this.convert(schema, true) as JsonObject;
    const existing = this.defs.get(name);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(converted)) {
      throw new Error(`two different schemas share the name ${name}; give one a distinct $id`);
    }
    this.defs.set(name, converted);
    return ref;
  }

  private convert(node: unknown, isRoot: boolean): Json {
    if (Array.isArray(node)) return node.map((n) => this.convert(n, false));
    if (isObject(node)) {
      if (!isRoot && typeof node.$id === "string") return this.add(node.$id, node);
      const out: JsonObject = {};
      for (const key of Object.keys(node)) {
        if (isRoot && key === "$id") continue;
        const value = node[key];
        if (value === undefined) continue;
        out[key] = this.convert(value, false);
      }
      return out;
    }
    if (
      node === undefined ||
      typeof node === "function" ||
      typeof node === "symbol" ||
      typeof node === "bigint"
    ) {
      throw new Error(`unserializable schema value: ${String(node)}`);
    }
    return node as Json;
  }

  /** `$ref` for a registry schema: its own `$id`, or the derived name. */
  ref(schema: unknown, derivedName: string): string {
    if (!isSchema(schema)) throw new Error(`${derivedName} is not a TypeBox schema`);
    const name = typeof schema.$id === "string" ? schema.$id : derivedName;
    this.add(name, schema);
    return `#/$defs/${name}`;
  }
}

function registryEntries(
  builder: DefsBuilder,
  registry: Readonly<Record<string, RegistryEntry>>,
  kind: "method" | "event",
): Json[] {
  return Object.keys(registry)
    .sort()
    .map((name): Json => {
      const spec = registry[name] as RegistryEntry;
      if (kind === "event") {
        return {
          name,
          description: spec.description,
          payload: builder.ref(spec.payload, `${pascal(name)}Payload`),
        };
      }
      return {
        name,
        scope: spec.scope ?? "none",
        sideEffecting: spec.sideEffecting === true,
        description: spec.description,
        params: builder.ref(spec.params, `${pascal(name)}Params`),
        result: builder.ref(spec.result, `${pascal(name)}Result`),
      };
    });
}

/** Builds `generated/schema.json` as a JSON value. */
export function buildSchemaDocument(): JsonObject {
  const builder = new DefsBuilder();
  const exports = protocol as unknown as Record<string, unknown>;
  for (const exportName of Object.keys(exports).sort()) {
    const value = exports[exportName];
    if (isSchema(value) && typeof value.$id === "string") builder.add(value.$id, value);
  }
  const xPsyche: JsonObject = {
    protocolVersion: protocol.PROTOCOL_VERSION,
    maxFrameBytes: protocol.MAX_FRAME_BYTES,
    frames: ["ReqFrame", "ResOkFrame", "ResErrFrame", "EventFrame"].map((n) => `#/$defs/${n}`),
    methods: registryEntries(builder, protocol.Methods, "method"),
    events: registryEntries(builder, protocol.Events, "event"),
    bridgeMethods: registryEntries(builder, protocol.BridgeMethods, "method"),
    bridgeEvents: registryEntries(builder, protocol.BridgeEvents, "event"),
  };
  const defs: JsonObject = {};
  for (const name of [...builder.defs.keys()].sort()) defs[name] = builder.defs.get(name) as Json;
  return {
    $schema: SCHEMA_DIALECT,
    $id: `urn:psyche:protocol:v${protocol.PROTOCOL_VERSION}`,
    title: "Psyche protocol",
    description:
      "Generated by packages/protocol/scripts/gen.ts from the TypeBox schemas. Do not edit.",
    "x-psyche": canonical(xPsyche),
    $defs: canonical(defs),
  };
}

export function renderSchemaJson(doc: JsonObject = buildSchemaDocument()): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// --- quicktype ----------------------------------------------------------------------------------

/**
 * Descriptions of the shared scalar schemas (`Id`, `IsoDateTime`, …). They would repeat on
 * every property in the generated code, so the quicktype feed drops them.
 */
const SHARED_SCALAR_DESCRIPTIONS = new Set(
  [
    protocol.Id,
    protocol.Ulid,
    protocol.IsoDateTime,
    protocol.ModelRef,
    protocol.JsonObject,
    protocol.JsonSchema,
  ]
    .map((schema) => schema.description)
    .filter((d): d is string => typeof d === "string"),
);

/**
 * Rewrites the document into the JSON Schema dialect quicktype reads: `definitions` instead of
 * `$defs`, `additionalProperties` instead of TypeBox's `"^(.*)$"` `patternProperties`, closed
 * objects (TypeBox's `Static` types have no index signature) and no validation-only keywords.
 */
function toQuicktypeDialect(node: Json, isNameMap = false): Json {
  if (Array.isArray(node)) return node.map((n) => toQuicktypeDialect(n));
  if (node === null || typeof node !== "object") return node;
  const out: JsonObject = {};
  if (isNameMap) {
    for (const [name, schema] of Object.entries(node)) out[name] = toQuicktypeDialect(schema);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      out.$ref = value.replace("#/$defs/", "#/definitions/");
    } else if (
      key === "patternProperties" &&
      isObject(value) &&
      Object.keys(value).length === 1 &&
      "^(.*)$" in value
    ) {
      out.additionalProperties = toQuicktypeDialect(value["^(.*)$"] as Json);
    } else if (key === "description") {
      if (typeof value === "string" && !SHARED_SCALAR_DESCRIPTIONS.has(value))
        out.description = value;
    } else if (
      key === "pattern" ||
      key === "minLength" ||
      key === "maxLength" ||
      key === "minItems" ||
      key === "maxItems"
    ) {
      // Validation-only; the Gateway validates with the TypeBox schemas.
    } else {
      out[key] = toQuicktypeDialect(value, key === "properties" || key === "definitions");
    }
  }
  if (out.type === "object" && isObject(out.properties) && Object.keys(out.properties).length > 0) {
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  return out;
}

/**
 * Swift 6 strict concurrency: quicktype marks the models `Sendable` but leaves its JSON helper
 * classes non-Sendable. They are immutable (`let` storage holding only JSON values), so they are
 * made `final` and `Sendable` (`@unchecked` for `JSONAny`, whose storage is typed `Any`).
 */
const SWIFT_REWRITES: ReadonlyArray<readonly [string, string]> = [
  [
    "public class JSONNull: Codable, Hashable {",
    "public final class JSONNull: Codable, Hashable, Sendable {",
  ],
  ["class JSONCodingKey: CodingKey {", "final class JSONCodingKey: CodingKey, Sendable {"],
  ["public class JSONAny: Codable {", "public final class JSONAny: Codable, @unchecked Sendable {"],
];

function postProcessSwift(source: string): string {
  let out = source;
  for (const [from, to] of SWIFT_REWRITES) {
    if (!out.includes(from))
      throw new Error(`quicktype Swift output changed: expected ${JSON.stringify(from)}`);
    out = out.replace(from, to);
  }
  return out;
}

const SWIFT_OPTIONS = {
  "just-types": "false",
  "struct-or-class": "struct",
  "access-level": "public",
  alamofire: "false",
  sendable: "true",
  initializers: "false",
  "coding-keys": "true",
  "mutable-properties": "false",
  "optional-enums": "false",
  "support-linux": "false",
  density: "normal",
  protocol: "none",
} as const;

const TYPESCRIPT_OPTIONS = {
  "just-types": "true",
  "prefer-unions": "true",
  "prefer-unknown": "true",
  "explicit-unions": "true",
  readonly: "false",
} as const;

async function runQuicktype(doc: JsonObject, lang: "swift" | "typescript"): Promise<string> {
  const defs = doc.$defs as JsonObject;
  const qt = {
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: toQuicktypeDialect(defs, true),
  };
  const text = JSON.stringify(qt);
  const input = new JSONSchemaInput(undefined);
  let first = true;
  for (const name of Object.keys(defs)) {
    const def = defs[name] as JsonObject;
    // quicktype emits no named type for plain scalars; they are inlined where referenced.
    if (def.type !== "object" && def.anyOf === undefined && def.enum === undefined) continue;
    await input.addSource({
      name,
      uris: [`psyche-protocol.json#/definitions/${name}`],
      ...(first ? { schema: text } : {}),
    });
    first = false;
  }
  const inputData = new InputData();
  inputData.addInput(input);
  const result = await quicktype({
    inputData,
    lang,
    rendererOptions: lang === "swift" ? SWIFT_OPTIONS : TYPESCRIPT_OPTIONS,
    inferMaps: false,
    inferEnums: false,
    inferUuids: false,
    inferDateTimes: false,
    inferIntegerStrings: false,
    inferBooleanStrings: false,
    combineClasses: false,
    ignoreJsonRefs: false,
    alphabetizeProperties: false,
    leadingComments: [],
  });
  return result.lines.join("\n");
}

function header(comment: string): string {
  return [
    `${comment} Generated by packages/protocol/scripts/gen.ts from packages/protocol/src (TypeBox).`,
    `${comment} Do not edit: run \`pnpm protocol:gen\`. Protocol version ${protocol.PROTOCOL_VERSION}.`,
    "",
  ].join("\n");
}

function finish(body: string): string {
  return `${body
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "")}\n`;
}

/** Generates every output in memory, keyed by absolute path. */
export async function generateAll(): Promise<Map<string, string>> {
  const doc = buildSchemaDocument();
  const swift = finish(`${header("//")}\n${postProcessSwift(await runQuicktype(doc, "swift"))}`);
  const ts = finish(`${header("//")}\n${await runQuicktype(doc, "typescript")}`);
  return new Map([
    [OUTPUT_FILES.schema, renderSchemaJson(doc)],
    [OUTPUT_FILES.typescript, ts],
    [OUTPUT_FILES.swift, swift],
    [OUTPUT_FILES.swiftHelper, swift],
  ]);
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes("--check");
  const outputs = await generateAll();
  const stale: string[] = [];
  for (const [path, content] of outputs) {
    const current = await readOrNull(path);
    if (current === content) continue;
    if (check) {
      stale.push(`${relative(REPO_DIR, path)}${current === null ? " (missing)" : ""}`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      process.stdout.write(`wrote ${relative(REPO_DIR, path)}\n`);
    }
  }
  if (check && stale.length > 0) {
    process.stderr.write(
      `Generated protocol files are stale:\n${stale.map((s) => `  - ${s}`).join("\n")}\nRun \`pnpm protocol:gen\` and commit the result.\n`,
    );
    return 1;
  }
  if (check) process.stdout.write("Generated protocol files are up to date.\n");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
