import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openDb } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { linuxRollbackHooks } from "../../desktop/src/packaging/linux-rollback.ts";
import { CLI_EXIT, runCli } from "../src/cli.ts";
import {
  commitGoBack,
  finishPendingGoBack,
  GO_BACK_JOURNAL_FILE,
  restoreForGoBack,
  undoGoBack,
} from "../src/go-back.ts";
import {
  createSnapshot,
  listSnapshots,
  RESTORE_MARKER_FILE,
  releaseAllGatewayLocks,
  UPDATE_FAILED_FILE,
} from "../src/pre-update.ts";

/**
 * "Go back" on Linux, the data half: restore + undo are one durable pair (go-back.ts). Temp
 * folders only; nothing here touches a real data folder.
 */

const roots: string[] = [];
afterEach(() => {
  releaseAllGatewayLocks();
  for (const r of roots.splice(0)) {
    try {
      chmodSync(join(r, "home", "vault"), 0o700);
    } catch {
      // not made in this test
    }
    rmSync(r, { recursive: true, force: true });
  }
});

const NEWER = "build-new";
const OLDER = "build-old";

/** A data folder as it was before an update: a real database, key files, an encrypted store. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "psy-goback-"));
  roots.push(root);
  const home = join(root, "home");
  const migrations = join(root, "migrations");
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "vault"), { recursive: true });
  mkdirSync(migrations);
  writeFileSync(join(migrations, "202601010000_test_one.sql"), "CREATE TABLE notes (body TEXT);");
  const dbPath = join(home, "state", "psyche.sqlite");
  const db = openDb(dbPath, { migrationsDir: migrations });
  db.sqlite.prepare("INSERT INTO notes (body) VALUES ('from before the update')").run();
  db.close();
  writeFileSync(join(home, "vault", "slots.json"), '{"slots":"old"}\n');
  writeFileSync(join(home, "state", "memory.key.json"), '{"key":"old"}\n');
  writeFileSync(join(home, "config.json"), '{"theme":"old"}\n');
  writeFileSync(join(home, "state", "mem.db"), Buffer.from("encrypted-old-main"));
  writeFileSync(join(home, "state", "mem.db-wal"), Buffer.from("encrypted-old-wal"));
  return { root, home, dbPath };
}
type S = ReturnType<typeof setup>;

/** The owner used the newer version for a while: everything changed, and some files are new. */
function useNewerVersion(s: S) {
  const db = openDb(s.dbPath, {
    migrationsDir: join(s.root, "migrations"),
  });
  db.sqlite.prepare("INSERT INTO notes (body) VALUES ('written after the update')").run();
  db.close();
  writeFileSync(join(s.home, "vault", "slots.json"), '{"slots":"newer"}\n');
  writeFileSync(join(s.home, "config.json"), '{"theme":"newer"}\n');
  writeFileSync(join(s.home, "state", "mem.db"), Buffer.from("encrypted-newer-main-longer"));
  writeFileSync(join(s.home, "state", "mem.db-wal"), Buffer.from("encrypted-newer-wal"));
  writeFileSync(join(s.home, "state", "mem.db-shm"), Buffer.from("shm-newer"));
}

async function snapshotTaken(s: S): Promise<string> {
  return createSnapshot({
    home: s.home,
    dbPath: s.dbPath,
    from: "0.4.0",
    to: "0.5.0",
    build: NEWER,
    pending: [],
  });
}

/** Every file in the data folder as path -> sha256, except the bookkeeping the go-back owns. */
function tree(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else out[relative(home, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(home);
  for (const k of Object.keys(out)) {
    if (k.startsWith("backups") || k.startsWith("run")) delete out[k];
  }
  return out;
}

const opts = (s: S, build = NEWER) => ({ dbPath: s.dbPath, build, version: "0.5.0" });
const displacedFolders = (home: string) =>
  readdirSync(join(home, "backups", "pre-update")).filter((n) => n.startsWith(".displaced-"));

describe("go back: restore, then undo", () => {
  it("gives back byte-identical data, including a file the restore created", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    // A file that exists only because the snapshot has it: the restore creates it.
    rmSync(join(s.home, "state", "memory.key.json"));
    const newer = tree(s.home);
    expect(newer["state/memory.key.json"]).toBeUndefined();

    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    const restored = tree(s.home);
    expect(restored["state/memory.key.json"]).toBeDefined(); // created by the restore
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"theme":"old"}\n');
    expect(restored).not.toEqual(newer);

    expect(undoGoBack(s.home, "0.4.0", opts(s))).toBe(true);
    expect(tree(s.home)).toEqual(newer);
    expect(existsSync(join(s.home, "state", "memory.key.json"))).toBe(false);
    expect(existsSync(join(s.home, GO_BACK_JOURNAL_FILE))).toBe(false);
    expect(existsSync(join(s.home, RESTORE_MARKER_FILE))).toBe(false);
    expect(displacedFolders(s.home)).toEqual([]);
  });

  it("restores the stale log beside a file that already matches the snapshot", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    // Same main file as the snapshot, but a newer log beside it.
    writeFileSync(join(s.home, "state", "mem.db-wal"), Buffer.from("newer writes in the log"));
    const before = tree(s.home);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    expect(readFileSync(join(s.home, "state", "mem.db-wal"), "utf8")).toBe("encrypted-old-wal");
    undoGoBack(s.home, "0.4.0", opts(s));
    expect(tree(s.home)).toEqual(before);
  });

  it("is a no-op the second time", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    const newer = tree(s.home);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    expect(undoGoBack(s.home, "0.4.0", opts(s))).toBe(true);
    expect(undoGoBack(s.home, "0.4.0", opts(s))).toBe(false);
    expect(tree(s.home)).toEqual(newer);
  });

  it("does nothing when there was no go-back", () => {
    const s = setup();
    const before = tree(s.home);
    expect(undoGoBack(s.home, "0.4.0", opts(s))).toBe(false);
    expect(tree(s.home)).toEqual(before);
  });

  it("throws on a partial failure, keeps the note, and finishes on a retry", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    const newer = tree(s.home);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    // One displaced original goes missing: its file cannot be put back.
    const [folder] = displacedFolders(s.home);
    const lost = join(s.home, "backups", "pre-update", folder as string, "config.json");
    const kept = readFileSync(lost);
    rmSync(lost);

    expect(() => undoGoBack(s.home, "0.4.0", opts(s))).toThrow(/could not be put back/);
    expect(existsSync(join(s.home, GO_BACK_JOURNAL_FILE))).toBe(true);
    // Everything that could be put back was; the one that could not is not reported as done.
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"theme":"old"}\n');
    expect(readFileSync(join(s.home, "vault", "slots.json"), "utf8")).toBe('{"slots":"newer"}\n');

    writeFileSync(lost, kept);
    expect(undoGoBack(s.home, "0.4.0", opts(s))).toBe(true);
    expect(tree(s.home)).toEqual(newer);
  });

  it("keeps content it did not put there instead of overwriting it", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    const newer = tree(s.home);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    // Something wrote to the restored file in the meantime.
    writeFileSync(join(s.home, "config.json"), '{"theme":"somebody else"}\n');
    undoGoBack(s.home, "0.4.0", opts(s));
    expect(tree(s.home)).toEqual(newer);
    const aside = readdirSync(join(s.home, "backups", "pre-update")).filter((n) =>
      n.endsWith("-undone"),
    );
    expect(aside).toHaveLength(1);
    expect(
      readFileSync(
        join(s.home, "backups", "pre-update", aside[0] as string, "config.json"),
        "utf8",
      ),
    ).toBe('{"theme":"somebody else"}\n');
  });

  it("refuses an undo for another version", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    expect(() => undoGoBack(s.home, "0.3.0", opts(s))).toThrow(/unfinished/);
  });

  it("refuses a note that names a path outside the data folder", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    const file = join(s.home, GO_BACK_JOURNAL_FILE);
    const note = JSON.parse(readFileSync(file, "utf8"));
    note.paths.push({ rel: "../escape", before: null, expect: null });
    writeFileSync(file, JSON.stringify(note));
    expect(() => undoGoBack(s.home, "0.4.0", opts(s))).toThrow(/outside/);
    note.paths.pop();
    note.displaceTo = join(s.root, "elsewhere");
    writeFileSync(file, JSON.stringify(note));
    expect(() => undoGoBack(s.home, "0.4.0", opts(s))).toThrow(/outside the snapshots/);
  });

  it("will not start a second go-back over an unfinished one", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    expect(() => restoreForGoBack(dir, s.home, "0.4.0", opts(s))).toThrow(/did not finish/);
  });

  it.skipIf(process.getuid?.() === 0)("undoes itself when the restore stops halfway", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    const newer = tree(s.home);
    // The database is put back first; then the key file cannot be written.
    chmodSync(join(s.home, "vault"), 0o500);
    expect(() => restoreForGoBack(dir, s.home, "0.4.0", opts(s))).toThrow();
    chmodSync(join(s.home, "vault"), 0o700);
    expect(tree(s.home)).toEqual(newer);
    expect(existsSync(join(s.home, GO_BACK_JOURNAL_FILE))).toBe(false);
    expect(existsSync(join(s.home, RESTORE_MARKER_FILE))).toBe(false);
    expect(displacedFolders(s.home)).toEqual([]);
  });

  it("leaves the displaced newer data alone once the go-back is committed", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    expect(commitGoBack(s.home)).toBe(true);
    expect(commitGoBack(s.home)).toBe(false);
    expect(displacedFolders(s.home)).toHaveLength(1);
    expect(undoGoBack(s.home, "0.4.0", opts(s))).toBe(false); // nothing left to undo
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"theme":"old"}\n');
  });
});

describe("go back: a crash between the restore and the undo", () => {
  it("is undone at the next start of the build that was being left", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    const newer = tree(s.home);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    // The app crashed before it swapped itself: the same build starts again.
    expect(finishPendingGoBack(s.home, opts(s, NEWER))).toBe("undone");
    expect(tree(s.home)).toEqual(newer);
    expect(finishPendingGoBack(s.home, opts(s, NEWER))).toBe("none");
  });

  it("finishes a restore that was cut short, then undoes it", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    const newer = tree(s.home);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    // As if the process died inside the restore: the note says "restoring", the restore's own
    // marker is still there.
    const file = join(s.home, GO_BACK_JOURNAL_FILE);
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), phase: "restoring" }),
    );
    writeFileSync(
      join(s.home, RESTORE_MARKER_FILE),
      JSON.stringify({ snapshot: dir, at: new Date().toISOString(), onlyDatabases: false }),
    );
    expect(finishPendingGoBack(s.home, opts(s, NEWER))).toBe("undone");
    expect(existsSync(join(s.home, RESTORE_MARKER_FILE))).toBe(false);
    expect(tree(s.home)).toEqual(newer);
  });

  it("is settled, not undone, when the older build is the one starting", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    const restored = tree(s.home);
    expect(finishPendingGoBack(s.home, opts(s, OLDER))).toBe("settled");
    expect(tree(s.home)).toEqual(restored);
    expect(existsSync(join(s.home, GO_BACK_JOURNAL_FILE))).toBe(false);
    expect(displacedFolders(s.home)).toHaveLength(1); // the newer data stays aside
  });

  it("is settled when the restored data has been used since", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    const db = openDb(s.dbPath, { migrationsDir: join(s.root, "migrations") });
    db.sqlite.prepare("INSERT INTO notes (body) VALUES ('written after going back')").run();
    db.close();
    const used = tree(s.home);
    expect(finishPendingGoBack(s.home, opts(s, NEWER))).toBe("settled");
    expect(tree(s.home)).toEqual(used); // never overwrites newer work with the displaced copy
  });

  it("refuses to start, and says why, when it must undo and cannot", async () => {
    const s = setup();
    const dir = await snapshotTaken(s);
    useNewerVersion(s);
    restoreForGoBack(dir, s.home, "0.4.0", opts(s));
    const [folder] = displacedFolders(s.home);
    rmSync(join(s.home, "backups", "pre-update", folder as string, "config.json"));
    expect(() => finishPendingGoBack(s.home, opts(s, NEWER))).toThrow(
      /could not put your newer data back/,
    );
    expect(JSON.parse(readFileSync(join(s.home, UPDATE_FAILED_FILE), "utf8")).key).toBe(
      "go-back-interrupted",
    );
    expect(existsSync(join(s.home, GO_BACK_JOURNAL_FILE))).toBe(true);
  });

  it("refuses to start on a damaged note", () => {
    const s = setup();
    mkdirSync(join(s.home, "run"), { recursive: true });
    writeFileSync(join(s.home, GO_BACK_JOURNAL_FILE), "{not json");
    expect(() => finishPendingGoBack(s.home, opts(s))).toThrow(
      /could not put your newer data back/,
    );
  });
});

describe("psyched pre-update go-back (CLI)", () => {
  async function cli(s: S, ...args: string[]) {
    const lines: string[] = [];
    const saved = { home: process.env.PSYCHE_HOME, db: process.env.PSYCHE_DB };
    process.env.PSYCHE_HOME = s.home;
    process.env.PSYCHE_DB = s.dbPath;
    try {
      const code = await runCli(["pre-update", ...args], (l) => lines.push(l));
      return { code, text: lines.join("\n") };
    } finally {
      for (const [k, v] of [
        ["PSYCHE_HOME", saved.home],
        ["PSYCHE_DB", saved.db],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("restores, then undoes, and commits", async () => {
    const s = setup();
    await snapshotTaken(s);
    useNewerVersion(s);
    const newer = tree(s.home);
    expect(listSnapshots(s.home)).toHaveLength(1);
    const back = await cli(s, "go-back", "0.4.0");
    expect(back.code).toBe(0);
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"theme":"old"}\n');
    const undo = await cli(s, "go-back-undo", "0.4.0");
    expect(undo.code).toBe(0);
    expect(tree(s.home)).toEqual(newer);
    expect((await cli(s, "go-back-undo", "0.4.0")).text).toMatch(/nothing to put back/);

    await cli(s, "go-back", "0.4.0");
    expect((await cli(s, "go-back-commit")).text).toMatch(/recorded/);
    expect(existsSync(join(s.home, GO_BACK_JOURNAL_FILE))).toBe(false);
  });

  it("succeeds with nothing to do when no snapshot was taken, and rejects a bad version", async () => {
    const s = setup();
    expect((await cli(s, "go-back", "0.4.0")).text).toMatch(/nothing to put back/);
    expect((await cli(s, "go-back", "../../x")).code).toBe(CLI_EXIT.usage);
  });
});

describe("the desktop's hooks over the real psyched commands", () => {
  /** What `psychedRunner` does, in process: `psyched <args>` against this temp data folder. */
  const hooksFor = (s: S) =>
    linuxRollbackHooks({
      home: s.home,
      run: async (args) => {
        const lines: string[] = [];
        const saved = { home: process.env.PSYCHE_HOME, db: process.env.PSYCHE_DB };
        process.env.PSYCHE_HOME = s.home;
        process.env.PSYCHE_DB = s.dbPath;
        try {
          const code = await runCli(args, (l) => lines.push(l));
          return { code, output: lines.join("\n") };
        } finally {
          for (const [k, v] of [
            ["PSYCHE_HOME", saved.home],
            ["PSYCHE_DB", saved.db],
          ] as const) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
        }
      },
    });

  it("restore, then undo (what rollbackLinux's abort path calls), is byte-identical", async () => {
    const s = setup();
    await snapshotTaken(s);
    useNewerVersion(s);
    rmSync(join(s.home, "state", "memory.key.json"));
    const newer = tree(s.home);
    const h = hooksFor(s);
    await h.restoreSnapshot("0.4.0");
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"theme":"old"}\n');
    await h.undoRestore("0.4.0");
    expect(tree(s.home)).toEqual(newer);
    await h.undoRestore("0.4.0"); // twice: nothing happens
    expect(tree(s.home)).toEqual(newer);
  });

  it("on success commits the journal and writes run/skip-builds.json", async () => {
    const s = setup();
    await snapshotTaken(s);
    useNewerVersion(s);
    const h = hooksFor(s);
    await h.restoreSnapshot("0.4.0");
    await h.recordSkipBuild({ release: "0.5.0", build: NEWER });
    expect(existsSync(join(s.home, GO_BACK_JOURNAL_FILE))).toBe(false);
    expect(h.isSkipped("0.5.0")).toBe(true);
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toBe('{"theme":"old"}\n');
    // The newer data is kept aside, not deleted.
    expect(displacedFolders(s.home)).toHaveLength(1);
  });
});
