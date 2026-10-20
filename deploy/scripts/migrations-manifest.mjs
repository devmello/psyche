// Prints the database migrations this release ships as a JS string literal, for
// `bun build --define __PSYCHE_MIGRATIONS__=<literal>` (apps/cli/src/migrate.ts reads it).
// Same id and checksum rules as @psyche/db (packages/db/src/migrate.ts).
// Usage: node migrations-manifest.mjs [migrations-dir]
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(
  process.argv[2] ??
    join(fileURLToPath(new URL(".", import.meta.url)), "../../packages/db/migrations"),
);
const list = readdirSync(dir)
  .filter((n) => /^\d{12}_[a-z0-9-]+_[a-z0-9_-]+\.sql$/.test(n))
  .sort()
  .map((n) => ({
    id: n.slice(0, -".sql".length),
    checksum: `sha256:${createHash("sha256")
      .update(readFileSync(join(dir, n), "utf8").replace(/\r\n/g, "\n"), "utf8")
      .digest("hex")}`,
  }));
process.stdout.write(JSON.stringify(JSON.stringify(list)));
