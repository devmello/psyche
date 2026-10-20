import type {
  CustomConnectorAuth,
  CustomConnectorManifest,
  CustomConnectorParam,
  CustomConnectorTool,
} from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { parse as parseYaml } from "yaml";
import { type ManifestFinding, methodFloor } from "./manifest.ts";

/**
 * OpenAPI 3.x → a custom connector manifest draft (feature M9). Only what the declarative
 * executor can run is taken: path / query parameters, JSON object request bodies, local `$ref`s.
 * Everything skipped is reported as a finding for the trust card. The result still goes through
 * `checkManifest` and the owner's review; nothing here enables anything.
 */

type Json = Record<string, unknown>;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MAX_REF_DEPTH = 8;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolve(doc: Json, v: unknown, depth = 0): unknown {
  if (!isObj(v) || typeof v.$ref !== "string") return v;
  if (depth > MAX_REF_DEPTH || !v.$ref.startsWith("#/")) return {};
  let node: unknown = doc;
  for (const seg of v.$ref.slice(2).split("/")) {
    if (!isObj(node)) return {};
    node = node[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return resolve(doc, node, depth + 1);
}

/** A JSON Schema with local refs inlined (bounded), without vendor extensions. */
function inline(doc: Json, v: unknown, depth = 0): unknown {
  const r = resolve(doc, v, depth);
  if (depth > MAX_REF_DEPTH) return {};
  if (Array.isArray(r)) return r.map((x) => inline(doc, x, depth + 1));
  if (!isObj(r)) return r;
  const out: Json = {};
  for (const [k, x] of Object.entries(r)) {
    if (k.startsWith("x-") || k === "example" || k === "examples") continue;
    out[k] = inline(doc, x, depth + 1);
  }
  return out;
}

function toolName(op: Json, method: string, path: string): string {
  const raw = typeof op.operationId === "string" ? op.operationId : `${method}_${path}`;
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const name = /^[a-z]/.test(snake) ? snake : `op_${snake}`;
  return name.slice(0, 64);
}

function authFrom(doc: Json, id: string): CustomConnectorAuth {
  const schemes =
    isObj(doc.components) && isObj(doc.components.securitySchemes)
      ? doc.components.securitySchemes
      : {};
  const credential = `{{cred:${id}}}`;
  for (const s of Object.values(schemes).map((x) => resolve(doc, x))) {
    if (!isObj(s)) continue;
    if (s.type === "http" && String(s.scheme).toLowerCase() === "bearer")
      return { kind: "bearer", credential };
    if (s.type === "http" && String(s.scheme).toLowerCase() === "basic")
      return { kind: "basic", credential };
    if (s.type === "apiKey" && s.in === "header" && typeof s.name === "string")
      return { kind: "header", name: s.name, credential };
    if (s.type === "apiKey" && s.in === "query" && typeof s.name === "string")
      return { kind: "query", name: s.name, credential };
  }
  return { kind: "none" };
}

export interface OpenApiDraft {
  manifest: CustomConnectorManifest;
  findings: ManifestFinding[];
}

export function manifestFromOpenApi(input: {
  document: string;
  id: string;
  operations?: string[];
  auth?: CustomConnectorAuth;
}): OpenApiDraft {
  let doc: unknown;
  try {
    doc = input.document.trimStart().startsWith("{")
      ? JSON.parse(input.document)
      : parseYaml(input.document, { maxAliasCount: 100 });
  } catch {
    throw new PsycheError("invalid_params", "the OpenAPI document is not valid JSON or YAML");
  }
  if (!isObj(doc) || typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new PsycheError("invalid_params", "only OpenAPI 3.x documents are supported");
  }
  const findings: ManifestFinding[] = [];
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const serverUrl = isObj(servers[0]) && typeof servers[0].url === "string" ? servers[0].url : "";
  let base: URL;
  try {
    base = new URL(serverUrl);
  } catch {
    throw new PsycheError(
      "invalid_params",
      "the document needs an absolute https server URL (servers[0].url)",
    );
  }
  const wanted = input.operations === undefined ? undefined : new Set(input.operations);
  const tools: CustomConnectorTool[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, itemRaw] of Object.entries(paths)) {
    const item = resolve(doc, itemRaw);
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const opId = typeof op.operationId === "string" ? op.operationId : undefined;
      if (wanted !== undefined && (opId === undefined || !wanted.has(opId))) continue;
      const name = toolName(op, method, path);
      const params: CustomConnectorParam[] = [];
      let skip: string | undefined;
      const all = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      for (const pr of all.map((x) => resolve(doc, x))) {
        if (!isObj(pr) || typeof pr.name !== "string") continue;
        if (pr.in === "header" || pr.in === "cookie") {
          findings.push({
            rule: "skipped_param",
            severity: "info",
            message: `${name}: ${pr.in} parameter ${pr.name} is not supported`,
          });
          continue;
        }
        if (pr.in !== "path" && pr.in !== "query") continue;
        const param: CustomConnectorParam = {
          name: pr.name,
          in: pr.in,
          schema: (inline(doc, pr.schema) as Json) ?? { type: "string" },
        };
        if (pr.required === true || pr.in === "path") param.required = true;
        if (typeof pr.description === "string") param.description = pr.description.slice(0, 1000);
        params.push(param);
      }
      const body = resolve(doc, op.requestBody);
      if (isObj(body)) {
        const json = isObj(body.content)
          ? resolve(doc, body.content["application/json"])
          : undefined;
        const schema = isObj(json) ? (inline(doc, json.schema) as Json) : undefined;
        if (!isObj(schema) || !isObj(schema.properties)) {
          skip = "its request body is not a JSON object";
        } else {
          const required = new Set(Array.isArray(schema.required) ? schema.required : []);
          for (const [prop, ps] of Object.entries(schema.properties)) {
            const param: CustomConnectorParam = {
              name: prop,
              in: "body",
              schema: isObj(ps) ? ps : {},
            };
            if (required.has(prop)) param.required = true;
            if (isObj(ps) && typeof ps.description === "string")
              param.description = ps.description.slice(0, 1000);
            params.push(param);
          }
        }
      }
      if (skip !== undefined) {
        findings.push({
          rule: "skipped_operation",
          severity: "warn",
          message: `${name}: skipped, ${skip}`,
        });
        continue;
      }
      const description = [op.summary, op.description]
        .filter((x) => typeof x === "string" && x !== "")
        .join(". ");
      const upper = method.toUpperCase() as CustomConnectorTool["method"];
      tools.push({
        name,
        description: description.slice(0, 2000) || `${upper} ${path}`,
        method: upper,
        // Paths are relative to the server URL, which is the manifest's baseUrl.
        path,
        params,
        sideEffect: methodFloor(upper),
      });
      if (tools.length >= 50) break;
    }
  }
  if (tools.length === 0)
    throw new PsycheError("invalid_params", "no supported operations were selected");
  const info = isObj(doc.info) ? doc.info : {};
  const manifest: CustomConnectorManifest = {
    schemaVersion: 1,
    id: input.id,
    name: String(info.title ?? input.id).slice(0, 100) || input.id,
    description: String(info.description ?? "").slice(0, 2000),
    version: String(info.version ?? "0").slice(0, 40),
    baseUrl: `${base.origin}${base.pathname.replace(/\/$/, "")}`,
    hosts: [base.hostname],
    auth: input.auth ?? authFrom(doc, input.id),
    tools,
    source: { kind: "openapi", title: String(info.title ?? "").slice(0, 200), drafted: "owner" },
  };
  return { manifest, findings };
}
