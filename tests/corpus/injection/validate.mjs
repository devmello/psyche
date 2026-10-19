#!/usr/bin/env node
// Validates every corpus file against schema.json plus the cross-field rules in README.md,
// then prints coverage by vector, goal and outcome. Dependency-free on purpose: it runs before
// the monorepo scaffold exists. The TypeScript injection runner in packages/testing reuses the
// same rules once it lands.
//
//   node tests/corpus/injection/validate.mjs [--json] [--min-total 150]

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const schema = JSON.parse(readFileSync(join(here, "schema.json"), "utf8"));
const registry = JSON.parse(
  readFileSync(join(root, "tests/fixtures/secrets/registry.json"), "utf8"),
);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const minTotalIdx = args.indexOf("--min-total");
const minTotal = minTotalIdx >= 0 ? Number(args[minTotalIdx + 1]) : 150;

// ---- minimal JSON Schema interpreter (the subset schema.json uses) ----

function resolveRef(ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => node[key], schema);
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function check(node, value, path, errors) {
  if (node.$ref) return check(resolveRef(node.$ref), value, path, errors);
  if (node.oneOf) {
    const passing = node.oneOf.filter((alt) => {
      const e = [];
      check(alt, value, path, e);
      return e.length === 0;
    });
    if (passing.length !== 1)
      errors.push(`${path}: must match exactly one alternative (matched ${passing.length})`);
    if (passing.length === 0) {
      // Report the closest alternative's errors to make fixes easy.
      const alt =
        node.oneOf.find((a) => a.type === typeOf(value)) ?? node.oneOf[node.oneOf.length - 1];
      check(alt, value, path, errors);
    }
    return;
  }
  if ("const" in node && value !== node.const)
    errors.push(`${path}: must be ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (node.type) {
    const t = typeOf(value);
    const ok = node.type === "integer" ? Number.isInteger(value) : t === node.type;
    if (!ok) {
      errors.push(`${path}: expected ${node.type}, got ${t}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (node.minLength !== undefined && value.length < node.minLength)
      errors.push(`${path}: shorter than ${node.minLength}`);
    if (node.maxLength !== undefined && value.length > node.maxLength)
      errors.push(`${path}: longer than ${node.maxLength}`);
    if (node.pattern && !new RegExp(node.pattern, "u").test(value))
      errors.push(`${path}: does not match ${node.pattern}`);
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems)
      errors.push(`${path}: fewer than ${node.minItems} items`);
    if (node.items) {
      value.forEach((v, i) => {
        check(node.items, v, `${path}[${i}]`, errors);
      });
    }
  }
  if (typeOf(value) === "object") {
    for (const key of node.required ?? [])
      if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (node.propertyNames) check(node.propertyNames, key, `${path}.<key ${key}>`, errors);
      const sub = node.properties?.[key];
      if (sub) check(sub, v, `${path}.${key}`, errors);
      else if (node.additionalProperties === false)
        errors.push(`${path}: unexpected property ${key}`);
      else if (typeof node.additionalProperties === "object")
        check(node.additionalProperties, v, `${path}.${key}`, errors);
    }
  }
}

// ---- cross-field rules (README "Rules every case follows") ----

const secretIds = new Set([
  ...registry.vaultItems.map((i) => i.id),
  ...registry.standalone.map((s) => s.id),
]);
const DEVICE_ONLY_KINDS = new Set([
  "purchase",
  "credential_fill",
  "exec_host",
  "policy_change",
  "pairing",
]);
const MUTATIONS_WITHOUT_TOOL = new Set(["change_grant", "escalate_mode"]);

function crossCheck(c, path, errors) {
  const call = c.attack.toolCall;
  const exp = c.expected;
  const outcomes = [exp.outcome, ...Object.values(exp.byMode ?? {})];
  if (call === null && outcomes.some((o) => o !== "ignored"))
    errors.push(`${path}: toolCall null requires outcome ignored in every mode`);
  if (outcomes.includes("asked")) {
    if (call === null || call.sideEffect === "none")
      errors.push(`${path}: asked needs a side-effecting toolCall`);
    if (!exp.approval) errors.push(`${path}: asked needs expected.approval`);
  }
  for (const m of Object.keys(exp.byMode ?? {}))
    if (!c.context.modes.includes(m))
      errors.push(`${path}: byMode.${m} but mode not in context.modes`);
  if (exp.approval) {
    const scopes = exp.approval.scopesOffered ?? [];
    if (
      call?.sideEffect === "financial" &&
      (scopes.some((s) => s !== "once") || exp.approval.deviceOnly !== true)
    )
      errors.push(`${path}: financial approvals are once-only and deviceOnly`);
    if (call?.sideEffect === "destructive" && scopes.some((s) => !["once", "task"].includes(s)))
      errors.push(`${path}: destructive approvals offer only once|task`);
    if (DEVICE_ONLY_KINDS.has(exp.approval.kind) && exp.approval.deviceOnly !== true)
      errors.push(`${path}: ${exp.approval.kind} approvals are deviceOnly`);
  }
  for (const ref of c.attack.secretRefs ?? [])
    if (!secretIds.has(ref)) errors.push(`${path}: unknown secretRef ${ref}`);
  if (c.goal === "reveal_secret" && !exp.invariants.includes("no_secret_in_model_context"))
    errors.push(`${path}: reveal_secret cases assert no_secret_in_model_context`);
  if (c.goal === "write_memory" && !exp.invariants.includes("no_memory_promotion"))
    errors.push(`${path}: write_memory cases assert no_memory_promotion`);
  if (MUTATIONS_WITHOUT_TOOL.has(c.goal) && outcomes.includes("asked"))
    errors.push(
      `${path}: ${c.goal} must never reach an approval card (no tool path to grants/mode/approvals)`,
    );
  if (c.context.source.provenance === "owner")
    errors.push(`${path}: injection sources are never owner provenance`);
  if (
    !outcomes.includes("ignored") &&
    !exp.invariants.includes("taint_recorded") &&
    c.context.source.provenance === "untrusted" &&
    call?.sideEffect !== "none"
  )
    errors.push(`${path}: blocked/asked cases from untrusted sources assert taint_recorded`);
}

// ---- run ----

const files = readdirSync(join(here, "cases"))
  .filter((f) => f.endsWith(".json"))
  .sort();
const errors = [];
const ids = new Map();
const cases = [];
for (const f of files) {
  const p = join(here, "cases", f);
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    errors.push(`${f}: invalid JSON: ${e.message}`);
    continue;
  }
  check(schema, doc, f, errors);
  for (const [i, c] of (doc.cases ?? []).entries()) {
    const path = `${f}#${c.id ?? i}`;
    if (c.id) {
      if (ids.has(c.id)) errors.push(`${path}: duplicate id (also in ${ids.get(c.id)})`);
      ids.set(c.id, f);
    }
    try {
      crossCheck(c, path, errors);
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
    cases.push({ ...c, file: relative(root, p) });
  }
}

const tally = (key) =>
  cases.reduce((acc, c) => {
    const k = typeof key === "function" ? key(c) : c[key];
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
const coverage = {
  total: cases.length,
  byVector: tally("vector"),
  byGoal: tally("goal"),
  byOutcome: tally((c) => c.expected.outcome),
  byFile: tally("file"),
};

if (cases.length < minTotal)
  errors.push(`corpus has ${cases.length} cases, needs at least ${minTotal}`);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ ok: errors.length === 0, errors, coverage }, null, 2)}\n`,
  );
} else {
  const fmt = (o) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  ${k.padEnd(48)} ${v}`)
      .join("\n");
  out(`cases: ${coverage.total}`);
  out(`by vector:\n${fmt(coverage.byVector)}`);
  out(`by goal:\n${fmt(coverage.byGoal)}`);
  out(`by outcome:\n${fmt(coverage.byOutcome)}`);
  if (errors.length) {
    err(`\n${errors.length} error(s):`);
    for (const e of errors) err(`  - ${e}`);
  } else out("\nok");
}
process.exit(errors.length ? 1 : 0);
