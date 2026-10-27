// The pnpm store inside the exported tree (`node_modules/.pnpm`): which entries a set of roots reaches.
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

/** Dependency names in a node_modules dir (scoped ones as `@scope/name`), skipping dot entries. */
export function depNames(nm) {
  if (!existsSync(nm)) return [];
  const names = [];
  for (const e of readdirSync(nm)) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) for (const sub of readdirSync(join(nm, e))) names.push(`${e}/${sub}`);
    else names.push(e);
  }
  return names;
}

/** Removes symlinks that point nowhere (left by dropped packages), recursing into scopes. */
export function removeDanglingLinks(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (!existsSync(p)) unlinkSync(p);
    } else if (st.isDirectory() && (e.startsWith("@") || e === ".bin")) {
      removeDanglingLinks(p);
      if (readdirSync(p).length === 0) rmdirSync(p);
    }
  }
}

/**
 * Deletes every `.pnpm` entry not reachable, through pnpm's symlink graph, from the `node_modules`
 * directories in `roots` (a dependency named in `drop` is not followed). Returns how many went.
 */
export function prunePnpmStore(appDir, roots, drop = []) {
  // Real path: symlinks resolve to it (macOS's /var is /private/var).
  const pnpm = realpathSync(join(appDir, "node_modules", ".pnpm"));
  const keep = new Set();
  const queue = [];
  const follow = (nm, self) => {
    for (const dep of depNames(nm)) {
      if (dep === self || drop.includes(dep)) continue;
      let real;
      try {
        real = realpathSync(join(nm, dep));
      } catch {
        continue;
      }
      const rel = relative(pnpm, real);
      if (rel.startsWith("..")) continue; // a workspace package
      const id = rel.split(sep)[0];
      if (keep.has(id)) continue;
      keep.add(id);
      queue.push([join(pnpm, id, "node_modules"), dep]);
    }
  };
  for (const nm of roots) follow(nm, null);
  while (queue.length) follow(...queue.pop());
  let removed = 0;
  for (const id of readdirSync(pnpm)) {
    if (id === "node_modules" || id.startsWith(".") || keep.has(id)) continue;
    if (!lstatSync(join(pnpm, id)).isDirectory()) continue;
    rmSync(join(pnpm, id), { recursive: true, force: true });
    removed++;
  }
  for (const id of keep) removeDanglingLinks(join(pnpm, id, "node_modules"));
  removeDanglingLinks(join(pnpm, "node_modules"));
  return removed;
}

/** Every link in the tree that points nowhere, wherever it is; returns how many were removed. */
export function removeAllDanglingLinks(dir) {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (!existsSync(p)) {
        unlinkSync(p);
        n++;
      }
    } else if (st.isDirectory()) n += removeAllDanglingLinks(p);
  }
  return n;
}
