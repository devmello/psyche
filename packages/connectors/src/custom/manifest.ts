import {
  type CustomConnectorManifest,
  CustomConnectorManifest as ManifestSchema,
  PsycheError,
} from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { canonicalJSON, sha256 } from "../framework/binding.ts";
import { isBlockedHostname } from "../web/address.ts";

/**
 * Custom connector manifests (feature M9): validation, the safety rules beyond the schema, a
 * scan for text aimed at the model, and the canonical text and hash the trust card shows and the
 * `skill_install` binding covers. A manifest with violations is never staged.
 */

export interface ManifestFinding {
  rule: string;
  severity: "info" | "warn" | "high";
  message: string;
}

export interface ManifestCheck {
  manifest: CustomConnectorManifest | undefined;
  violations: string[];
  findings: ManifestFinding[];
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);
const RANK = { read: 0, write: 1, destructive: 2 } as const;

/** The least tier a method may declare: GET read, POST / PUT / PATCH write, DELETE destructive. */
export function methodFloor(method: string): keyof typeof RANK {
  return method === "DELETE" ? "destructive" : WRITE_METHODS.has(method) ? "write" : "read";
}

const SCANS: [string, ManifestFinding["severity"], RegExp, string][] = [
  [
    "instruction_like",
    "high",
    /\b(ignore|disregard)\b.{0,40}\b(previous|prior|above|earlier)\b|\byou (must|should) (always|never)\b|<\/?(important|system|instructions?)>|\b(system prompt|assistant:)/i,
    "text addresses the model with instructions",
  ],
  [
    "hidden_markup",
    "high",
    /<!--|<\s*(script|style|iframe)\b|\]\(\s*javascript:/i,
    "text contains hidden markup",
  ],
  ["invisible_characters", "high", /[​-‏‪-‮⁠-⁤﻿]/, "text contains invisible or bidi control characters"],
  [
    "credential_reference",
    "warn",
    /\.ssh\b|id_rsa|\.aws\/credentials|\.netrc|vault\.db|\{\{cred:/i,
    "text mentions credential files or vault placeholders",
  ],
];

/** Validate and scan; never throws on bad input (returns violations). */
export function checkManifest(raw: unknown): ManifestCheck {
  const violations: string[] = [];
  const findings: ManifestFinding[] = [];
  if (!Value.Check(ManifestSchema, raw)) {
    for (const e of [...Value.Errors(ManifestSchema, raw)].slice(0, 20)) {
      violations.push(`${e.path || "/"}: ${e.message}`);
    }
    return { manifest: undefined, violations, findings };
  }
  const m = raw as CustomConnectorManifest;
  let base: URL | undefined;
  try {
    base = new URL(m.baseUrl);
  } catch {
    violations.push("baseUrl is not a URL");
  }
  if (base !== undefined) {
    if (base.protocol !== "https:") violations.push("baseUrl must be https");
    if (base.username !== "" || base.password !== "")
      violations.push("baseUrl must not embed credentials");
    if (base.search !== "" || base.hash !== "")
      violations.push("baseUrl must not have a query or fragment");
    if (!m.hosts.includes(base.hostname))
      violations.push(`hosts must include baseUrl's host ${base.hostname}`);
  }
  for (const h of m.hosts) {
    if (h !== h.toLowerCase() || h.startsWith(".") || h.endsWith(".") || !h.includes(".")) {
      violations.push(`host ${h} is not a canonical public hostname`);
    } else if (isBlockedHostname(h) || /^[\d.]+$/.test(h)) {
      violations.push(`host ${h} is local, private or an address literal`);
    }
  }
  const names = new Set<string>();
  for (const t of m.tools) {
    const where = `tool ${t.name}`;
    if (names.has(t.name)) violations.push(`${where}: duplicate name`);
    names.add(t.name);
    if (RANK[t.sideEffect] < RANK[methodFloor(t.method)]) {
      violations.push(
        `${where}: ${t.method} must be at least ${methodFloor(t.method)}, not ${t.sideEffect}`,
      );
    }
    if (t.sideEffect === "destructive" && t.defaultRule === "allow") {
      violations.push(`${where}: destructive tools can never be allow`);
    }
    const pathParams = new Set([...t.path.matchAll(/\{([^{}]+)\}/g)].map((x) => x[1] as string));
    const params = new Set<string>();
    for (const p of t.params) {
      if (params.has(p.name)) violations.push(`${where}: duplicate param ${p.name}`);
      params.add(p.name);
      if (p.in === "path" && !pathParams.has(p.name))
        violations.push(`${where}: path param ${p.name} is not in the path`);
      if (p.in === "body" && !WRITE_METHODS.has(t.method))
        violations.push(`${where}: ${t.method} cannot have a body`);
      if (m.auth.kind === "query" && p.in === "query" && p.name === m.auth.name) {
        violations.push(`${where}: param ${p.name} collides with the auth query parameter`);
      }
    }
    for (const pp of pathParams) {
      if (!t.params.some((p) => p.in === "path" && p.name === pp))
        violations.push(`${where}: path {${pp}} has no param`);
    }
    if (t.path.includes("..")) violations.push(`${where}: path must not contain ..`);
    const text = [t.description, ...t.params.map((p) => p.description ?? "")].join("\n");
    for (const [rule, severity, re, message] of SCANS) {
      if (re.test(text)) findings.push({ rule, severity, message: `${where}: ${message}` });
    }
  }
  for (const [rule, severity, re, message] of SCANS) {
    if (re.test(`${m.name}\n${m.description}`))
      findings.push({ rule, severity, message: `manifest: ${message}` });
  }
  if (m.auth.kind !== "none" && base !== undefined && m.hosts.length > 1) {
    findings.push({
      rule: "credential_scope",
      severity: "info",
      message: `the credential is sent only to ${base.hostname}, never to the other allowlisted hosts`,
    });
  }
  return { manifest: violations.length === 0 ? m : undefined, violations, findings };
}

export function assertManifest(raw: unknown): CustomConnectorManifest {
  const c = checkManifest(raw);
  if (c.manifest === undefined) {
    throw new PsycheError(
      "invalid_params",
      `the connector manifest is not acceptable: ${c.violations.slice(0, 3).join("; ")}`,
      {
        details: { violations: c.violations },
      },
    );
  }
  return c.manifest;
}

/** Sorted keys, two-space indent: what the card shows and what the hash covers. */
export function manifestText(m: CustomConnectorManifest): string {
  return JSON.stringify(JSON.parse(canonicalJSON(m)), null, 2);
}

export function manifestHash(m: CustomConnectorManifest): `sha256:${string}` {
  return sha256(canonicalJSON(m));
}

/** Line diff for updates (`-` removed, `+` added), for the card. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const inA = new Set(a);
  const inB = new Set(b);
  return [
    ...a.filter((l) => !inB.has(l)).map((l) => `- ${l}`),
    ...b.filter((l) => !inA.has(l)).map((l) => `+ ${l}`),
  ].join("\n");
}
