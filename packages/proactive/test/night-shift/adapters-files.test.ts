import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FileGrant,
  filesAdapter,
  foldName,
  splitFilesCall,
} from "../../src/night-shift/adapters/files.ts";
import type { CaptureOk, StagedCall } from "../../src/night-shift/adapters/types.ts";

let base: string;
let share: string; // the rw grant
let outside: string; // never granted
let grants: FileGrant[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ns-files-")));
  share = join(base, "share");
  outside = join(base, "outside");
  mkdirSync(join(share, "Inbox"), { recursive: true });
  mkdirSync(join(share, "Filed"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(share, "Inbox", "bill.pdf"), "pdf-bytes");
  writeFileSync(join(outside, "secret.txt"), "secret");
  grants = [{ root: share, mode: "rw" }];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const adapter = () => filesAdapter({ grants: () => grants });
const move = (path: string, to: string, name?: string): StagedCall => ({
  tool: "files_move",
  args: { items: [{ path, to, ...(name !== undefined ? { name } : {}) }] },
});
const src = () => join(share, "Inbox", "bill.pdf");
const filed = () => join(share, "Filed");

async function staged(call = move(src(), filed())) {
  const a = adapter();
  const cap = await a.capture(call);
  if (!cap.ok) throw new Error(`capture refused: ${cap.reason}`);
  return { a, call, cap };
}

describe("files capture and check", () => {
  it("captures with dev:ino of the source as the target, and is fresh", async () => {
    const { a, call, cap } = await staged();
    expect(cap.target).toMatch(/^\d+:\d+$/);
    expect(await a.check(call, cap)).toEqual({ fresh: true });
  });

  it("rename stages in the same folder", async () => {
    const a = adapter();
    const call = { tool: "files_rename", args: { path: src(), name: "bill-2026.pdf" } };
    const cap = await a.capture(call);
    expect(cap.ok).toBe(true);
    expect(a.preview(call, cap as CaptureOk).rows.map((r) => r.value)).toEqual([
      src(),
      join(share, "Inbox", "bill-2026.pdf"),
    ]);
  });

  it("is stale when the size or the mtime changed", async () => {
    const { a, call, cap } = await staged();
    writeFileSync(src(), "more-bytes-than-before");
    expect(await a.check(call, cap)).toEqual({ fresh: false, reason: "source_changed" });
    const s2 = await staged();
    const t = new Date(Date.now() + 60_000);
    utimesSync(src(), t, t);
    expect(await s2.a.check(s2.call, s2.cap)).toEqual({ fresh: false, reason: "source_changed" });
  });

  it("is stale when another file took the source's place (dev:ino differs)", async () => {
    const { a, call, cap } = await staged();
    writeFileSync(join(share, "Inbox", "other"), "pdf-bytes");
    renameSync(join(share, "Inbox", "other"), src());
    expect(await a.check(call, cap)).toEqual({ fresh: false, reason: "source_replaced" });
  });

  it("is stale when the source is gone, the destination appeared or the parent was swapped", async () => {
    const s1 = await staged();
    writeFileSync(join(filed(), "bill.pdf"), "x");
    expect(await s1.a.check(s1.call, s1.cap)).toEqual({
      fresh: false,
      reason: "destination_exists",
    });
    rmSync(join(filed(), "bill.pdf"));

    const s2 = await staged();
    renameSync(filed(), join(share, "Filed-old"));
    mkdirSync(filed());
    expect(await s2.a.check(s2.call, s2.cap)).toEqual({
      fresh: false,
      reason: "dest_parent_changed",
    });
    rmSync(filed(), { recursive: true });
    renameSync(join(share, "Filed-old"), filed());

    const s3 = await staged();
    rmSync(src());
    expect(await s3.a.check(s3.call, s3.cap)).toEqual({ fresh: false, reason: "source_gone" });
  });

  it("is stale when the grant no longer covers the paths or is no longer rw", async () => {
    const { a, call, cap } = await staged();
    grants = [{ root: share, mode: "ro" }];
    expect(await a.check(call, cap)).toEqual({ fresh: false, reason: "not_writable" });
    grants = [{ root: outside, mode: "rw" }];
    expect(await a.check(call, cap)).toEqual({ fresh: false, reason: "outside_grant" });
    grants = [];
    expect(await a.check(call, cap)).toEqual({ fresh: false, reason: "outside_grant" });
  });

  it("an ro folder under an rw parent is ro (deepest grant decides)", async () => {
    grants = [
      { root: share, mode: "rw" },
      { root: filed(), mode: "ro" },
    ];
    expect(await adapter().capture(move(src(), filed()))).toEqual({
      ok: false,
      reason: "not_writable",
    });
  });

  it("fails closed when the grants cannot be read, at capture and at check", async () => {
    const { call, cap } = await staged();
    const broken = filesAdapter({
      grants: () => {
        throw new Error("store down");
      },
    });
    expect(await broken.capture(call)).toEqual({ ok: false, reason: "grants_unreadable" });
    expect(await broken.check(call, cap)).toEqual({ fresh: false, reason: "grants_unreadable" });
  });
});

describe("files refusals", () => {
  const a = () => adapter();

  it("refuses a source outside every grant", async () => {
    expect(await a().capture(move(join(outside, "secret.txt"), filed()))).toEqual({
      ok: false,
      reason: "outside_grant",
    });
  });

  it("refuses a destination outside the grant", async () => {
    expect(await a().capture(move(src(), outside))).toEqual({
      ok: false,
      reason: "outside_grant",
    });
  });

  it("refuses `..` escapes, however they are spelled", async () => {
    const escapes = [
      `${share}/../outside/secret.txt`,
      `${share}/Inbox/../../outside/secret.txt`,
      `${share}/Inbox/..`,
    ];
    for (const p of escapes) {
      expect(await a().capture(move(p, filed()))).toEqual({ ok: false, reason: "dotdot" });
      expect(await a().capture(move(src(), p))).toEqual({ ok: false, reason: "dotdot" });
    }
    expect(
      await a().capture({ tool: "files_rename", args: { path: escapes[0], name: "x" } }),
    ).toEqual({
      ok: false,
      reason: "dotdot",
    });
  });

  it("refuses `link/..` where the link leaves the grant", async () => {
    symlinkSync(join(outside), join(share, "lnk"));
    // Lexically `${share}/lnk/../Inbox/bill.pdf` is the granted file; the kernel resolves it
    // under `outside`. It must be refused, not normalised.
    expect(await a().capture(move(`${share}/lnk/../Inbox/bill.pdf`, filed()))).toEqual({
      ok: false,
      reason: "dotdot",
    });
  });

  it("refuses a symlink as the source (O_NOFOLLOW), inside or outside the grant", async () => {
    symlinkSync(join(outside, "secret.txt"), join(share, "Inbox", "ln"));
    expect((await a().capture(move(join(share, "Inbox", "ln"), filed()))).ok).toBe(false);
    symlinkSync(src(), join(share, "Inbox", "ln2"));
    expect((await a().capture(move(join(share, "Inbox", "ln2"), filed()))).ok).toBe(false);
  });

  it("refuses a source reached through a symlinked folder that leaves the grant", async () => {
    symlinkSync(outside, join(share, "Inbox2"));
    expect(await a().capture(move(join(share, "Inbox2", "secret.txt"), filed()))).toEqual({
      ok: false,
      reason: "outside_grant",
    });
  });

  it("refuses a destination folder that is a symlink out of the grant", async () => {
    symlinkSync(outside, join(share, "Out"));
    expect(await a().capture(move(src(), join(share, "Out")))).toEqual({
      ok: false,
      reason: "outside_grant",
    });
  });

  it("refuses when the destination exists, even as a dangling link", async () => {
    writeFileSync(join(filed(), "bill.pdf"), "x");
    expect(await a().capture(move(src(), filed()))).toEqual({
      ok: false,
      reason: "destination_exists",
    });
    rmSync(join(filed(), "bill.pdf"));
    symlinkSync(join(outside, "nowhere"), join(filed(), "bill.pdf"));
    expect(await a().capture(move(src(), filed()))).toEqual({
      ok: false,
      reason: "destination_exists",
    });
  });

  it("refuses a hard-linked source (nlink > 1)", async () => {
    linkSync(src(), join(share, "Inbox", "twin.pdf"));
    expect(await a().capture(move(src(), filed()))).toEqual({ ok: false, reason: "hard_linked" });
  });

  it("refuses a directory and a missing source", async () => {
    expect(await a().capture(move(join(share, "Inbox"), filed()))).toEqual({
      ok: false,
      reason: "not_a_file",
    });
    expect(await a().capture(move(join(share, "Inbox", "nope"), filed()))).toEqual({
      ok: false,
      reason: "source_gone",
    });
  });

  const BAD_PATHS: Array<[string, string]> = [
    ["relative", "Inbox/bill.pdf"],
    ["nul", "/x\0y"],
    ["magic nofollow", "/.nofollow/etc/hosts"],
    ["magic vol", "/.vol/1/2"],
    ["empty", ""],
  ];
  it.each(BAD_PATHS)("refuses a %s path", async (_n, p) => {
    expect((await a().capture(move(p, filed()))).ok).toBe(false);
  });

  const BAD_NAMES = [
    "",
    ".",
    "..",
    "a/b",
    "a\\b",
    ".env",
    ".git",
    ".zshrc",
    "x".repeat(256),
    "a\0b",
  ];
  it.each(BAD_NAMES)("refuses destination name %j", async (name) => {
    expect((await a().capture(move(src(), filed(), name))).ok).toBe(false);
  });

  it("refuses moving into a hidden folder under the grant", async () => {
    mkdirSync(join(share, ".git"));
    expect(await a().capture(move(src(), join(share, ".git")))).toEqual({
      ok: false,
      reason: "hidden_destination",
    });
  });

  it("refuses a call with several items (split first) and a no-op", async () => {
    const two: StagedCall = {
      tool: "files_move",
      args: {
        items: [
          { path: src(), to: filed() },
          { path: src(), to: filed() },
        ],
      },
    };
    expect(await a().capture(two)).toEqual({ ok: false, reason: "one_item_per_call" });
    expect(splitFilesCall(two)).toHaveLength(2);
    expect(await a().capture(move(src(), join(share, "Inbox")))).toEqual({
      ok: false,
      reason: "noop",
    });
  });

  it("positive control: the same shapes are accepted when they are inside the grant", async () => {
    expect((await a().capture(move(src(), filed()))).ok).toBe(true);
  });
});

describe("symlink swaps after capture", () => {
  it("a source replaced by a link to an outside file is refused at check", async () => {
    const { a, call, cap } = await staged();
    rmSync(src());
    symlinkSync(join(outside, "secret.txt"), src());
    const r = await a.check(call, cap);
    expect(r.fresh).toBe(false);
  });

  it("a destination folder swapped for a link out of the grant is refused at check", async () => {
    const { a, call, cap } = await staged();
    rmSync(filed(), { recursive: true });
    symlinkSync(outside, filed());
    const r = await a.check(call, cap);
    expect(r.fresh).toBe(false);
  });

  it("an unopenable source is refused, never judged by its path", async () => {
    const { a, call, cap } = await staged();
    rmSync(src());
    mkdirSync(src()); // a directory now: fd opens, fstat says not a file
    expect(await a.check(call, cap)).toEqual({ fresh: false, reason: "not_a_file" });
  });
});

describe("file folding (§2.4)", () => {
  it("a move whose source is an earlier item's destination folds into it with the final path", async () => {
    const a = adapter();
    const first = move(src(), filed());
    const cap1 = (await a.capture(first)) as CaptureOk;
    mkdirSync(join(share, "Archive"));
    // The file has not moved yet: it is not at Filed/bill.pdf, but it is staged to be.
    const second = move(join(filed(), "bill.pdf"), join(share, "Archive"), "bill-final.pdf");
    const cap2 = await a.capture(second, { pending: [{ call: first, capture: cap1 }] });
    expect(cap2).toMatchObject({ ok: true, target: cap1.target, folds: [cap1.target] });
    const c = cap2 as CaptureOk;
    expect(c.call).toEqual(move(src(), join(share, "Archive"), "bill-final.pdf"));
    // The folded item checks fresh against the original source.
    expect(await a.check(c.call as StagedCall, c)).toEqual({ fresh: true });
    expect(a.preview(c.call as StagedCall, c).rows.map((r) => r.value)).toEqual([
      src(),
      join(share, "Archive", "bill-final.pdf"),
    ]);
  });

  it("without the earlier item, the same call is refused (the source is absent)", async () => {
    const second = move(join(filed(), "bill.pdf"), filed(), "x.pdf");
    expect(await adapter().capture(second)).toEqual({ ok: false, reason: "source_gone" });
  });

  it("folding back to the original path is refused as a no-op", async () => {
    const a = adapter();
    const first = move(src(), filed());
    const cap1 = (await a.capture(first)) as CaptureOk;
    const back = move(join(filed(), "bill.pdf"), join(share, "Inbox"));
    expect(await a.capture(back, { pending: [{ call: first, capture: cap1 }] })).toEqual({
      ok: false,
      reason: "folds_to_noop",
    });
  });

  it("a fold into a destination outside the grant is refused", async () => {
    const a = adapter();
    const first = move(src(), filed());
    const cap1 = (await a.capture(first)) as CaptureOk;
    const out = move(join(filed(), "bill.pdf"), outside);
    expect(await a.capture(out, { pending: [{ call: first, capture: cap1 }] })).toEqual({
      ok: false,
      reason: "outside_grant",
    });
  });
});

describe("files undo", () => {
  async function applied() {
    const { a, call, cap } = await staged();
    const dest = join(filed(), "bill.pdf");
    renameSync(src(), dest); // what the executor would do
    const post = await a.postState?.(call, cap);
    return { a, call, cap, dest, post: post ?? null };
  }

  it("builds the move back", async () => {
    const { a, call, cap, dest } = await applied();
    expect(a.inverse?.(call, cap)).toEqual({
      tool: "files_move",
      args: { items: [{ path: dest, to: join(share, "Inbox"), name: "bill.pdf" }] },
    });
  });

  it("is allowed while the destination is the same file and the old path is free", async () => {
    const { a, call, cap, post } = await applied();
    expect(await a.checkInverse?.(call, cap, post)).toEqual({ fresh: true });
  });

  it("is refused when another file now sits at the destination", async () => {
    const { a, call, cap, dest, post } = await applied();
    rmSync(dest);
    writeFileSync(dest, "different");
    expect(await a.checkInverse?.(call, cap, post)).toEqual({
      fresh: false,
      reason: "destination_replaced",
    });
  });

  it("is refused when the old path is taken", async () => {
    const { a, call, cap, post } = await applied();
    writeFileSync(src(), "new owner of the path");
    expect(await a.checkInverse?.(call, cap, post)).toEqual({
      fresh: false,
      reason: "old_path_taken",
    });
  });

  it("is refused when the grant no longer covers the paths", async () => {
    const { a, call, cap, post } = await applied();
    grants = [];
    expect((await a.checkInverse?.(call, cap, post))?.fresh).toBe(false);
  });

  it("is refused without a post-apply state", async () => {
    const { a, call, cap } = await applied();
    expect(await a.checkInverse?.(call, cap, null)).toEqual({
      fresh: false,
      reason: "no_post_state",
    });
  });
});

describe("name folding", () => {
  it.each([
    ["\u017f", "s"],
    ["\ufb01le", "file"],
    ["A", "a"],
    ["\u1e9e", "ss"],
  ])("%j folds to %j on a case-folding disk", (a, b) => {
    if (process.platform === "linux") return;
    expect(foldName(a)).toBe(foldName(b));
  });
});
