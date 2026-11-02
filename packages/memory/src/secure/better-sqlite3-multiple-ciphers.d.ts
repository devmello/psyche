// The package ships index.d.ts but its `exports` map has no `types` condition, so TypeScript's
// bundler resolution cannot see it. Its API is better-sqlite3's (plus key/rekey, unused here).
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export = Database;
}
