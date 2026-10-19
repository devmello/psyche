import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { policySchemaJson } from "../src/policy.ts";

const out = fileURLToPath(new URL("../policy.schema.json", import.meta.url));
writeFileSync(out, policySchemaJson());
console.warn(`wrote ${out}`);
