#!/usr/bin/env node
// Writes apps/ios/Tests/side-effecting-methods.json: the WS methods the Gateway refuses without an
// idempotencyKey. The iOS FakeGateway reads it. Source: packages/protocol/generated/schema.json
// (kept fresh by packages/protocol/test/codegen.test.ts). Run: node .claude/scripts/gen-ios-side-effecting.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const OUTPUT = resolve(root, "apps/ios/Tests/side-effecting-methods.json");
const SCHEMA = resolve(root, "packages/protocol/generated/schema.json");

export function render() {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const names = schema["x-psyche"].methods
    .filter((m) => m.sideEffecting === true)
    .map((m) => m.name)
    .sort();
  return `${JSON.stringify(names, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(OUTPUT, render());
