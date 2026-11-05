// Runs cargo for @psyche/win-helper on Windows; a no-op everywhere else, so turbo can run
// `build` / `test` across the monorepo on any OS.
//
//   node scripts/cargo.mjs build   → cargo build --release, then copies psyche-helper.exe to dist/
//   node scripts/cargo.mjs test    → cargo test
//   node scripts/cargo.mjs clippy  → cargo clippy --all-targets -- -D warnings
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const task = process.argv[2];

if (process.platform !== "win32") {
  process.stdout.write(`@psyche/win-helper: skipping "${task}" (Windows only)\n`);
  process.exit(0);
}

const args = {
  build: ["build", "--release"],
  test: ["test"],
  clippy: ["clippy", "--all-targets", "--", "-D", "warnings"],
}[task];
if (args === undefined) {
  console.error(`usage: node scripts/cargo.mjs build|test|clippy (got ${task})`);
  process.exit(64);
}

const run = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
if (run.error) {
  console.error(
    `@psyche/win-helper: could not run cargo (${run.error.code}); install Rust from https://rustup.rs`,
  );
  process.exit(1);
}
if (run.status !== 0) process.exit(run.status ?? 1);

if (task === "build") {
  mkdirSync(join(root, "dist"), { recursive: true });
  copyFileSync(
    join(root, "target", "release", "psyche-helper.exe"),
    join(root, "dist", "psyche-helper.exe"),
  );
}
