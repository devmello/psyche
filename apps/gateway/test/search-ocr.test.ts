import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createSearchIndex,
  defaultSourcesConfig,
  filesAdapter,
  type PowerState,
  SourceIndexer,
} from "@psyche/search";
import { FakeOcrNode } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { filesSourceDeps } from "../src/compose/search-files.ts";
import { helperRecognizer } from "../src/compose/search-ocr.ts";
import { isOcrCandidate, libraryText } from "../src/compose/search-sources.ts";
import { isUnreachableCapability } from "../src/handlers/nodes.ts";

/** Roadmap R6/R7: Vision OCR through the Mac helper, with a fake helper. Fixtures only. */

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-ocr-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const never = new AbortController().signal;

describe("helperRecognizer", () => {
  it("asks the helper for pages with a thin text layer only, 30 characters", async () => {
    const node = new FakeOcrNode();
    node.pdf("/scan/mixed.pdf", [
      { layer: "A real text layer with well over thirty characters on it." },
      { scan: "Lease signed 3 March" },
      { layer: "29 characters in this layer", scan: "stamp" },
      { layer: "x".repeat(30), scan: "never read" },
    ]);
    const recognise = helperRecognizer(() => node);
    const out = await recognise("/scan/mixed.pdf", never);
    expect(out).toEqual({ text: "Lease signed 3 March\n\nstamp", pages: 2 });
    expect(node.recognised.map((r) => r.page)).toEqual([2, 3]);
    expect(node.invocations[0]?.params).toMatchObject({
      path: "/scan/mixed.pdf",
      minTextChars: 30,
      maxPages: 20,
    });
  });

  it("caps pages per call and refuses files over the size cap", async () => {
    const node = new FakeOcrNode();
    node.pdf(
      "/scan/book.pdf",
      Array.from({ length: 50 }, (_, i) => ({ scan: `page ${i + 1}` })),
    );
    node.image("/scan/huge.png", "too big", 30 * 1024 * 1024);
    const recognise = helperRecognizer(() => node);
    expect((await recognise("/scan/book.pdf", never))?.pages).toBe(20);
    expect(node.recognised).toHaveLength(20);
    expect(await recognise("/scan/huge.png", never)).toBeUndefined();
  });

  it("runs one file at a time, whoever asks", async () => {
    const node = new FakeOcrNode();
    node.delayMs = 5;
    for (const n of ["a", "b", "c", "d"]) node.image(`/scan/${n}.png`, n);
    const recognise = helperRecognizer(() => node);
    const all = await Promise.all(
      ["a", "b", "c", "d"].map((n) => recognise(`/scan/${n}.png`, never)),
    );
    expect(all.map((r) => r?.text)).toEqual(["a", "b", "c", "d"]);
    expect(node.maxInFlight).toBe(1);
  });

  it("is undefined without a helper, and nodes.invoke can never reach ocr.*", async () => {
    expect(await helperRecognizer(() => undefined)("/scan/a.png", never)).toBeUndefined();
    expect(isUnreachableCapability("ocr.recognize")).toBe(true);
    expect(isUnreachableCapability("llm.apple.generate")).toBe(true);
    expect(isUnreachableCapability("llm.apple.availability")).toBe(true);
  });
});

describe("files source with OCR", () => {
  function setup(opts: { pagesPerPull?: number; maxFileBytes?: number } = {}) {
    const root = tmp();
    const outside = tmp();
    mkdirSync(join(root, "Downloads"));
    mkdirSync(join(root, "Scans"));
    const node = new FakeOcrNode();
    const touch = (path: string, text?: string) => {
      writeFileSync(path, "binary");
      if (text !== undefined) node.image(path, text);
    };
    touch(join(root, "Scans", "receipt.png"), "Blue Bottle Coffee total 14.50");
    touch(join(root, "Downloads", "flyer.jpg"), "Win a free cruise now");
    touch(join(outside, "secret.png"), "outside the grant");
    symlinkSync(join(outside, "secret.png"), join(root, "Scans", "link.png"));
    const config = defaultSourcesConfig();
    config.sources.files.enabled = true;
    let power: PowerState = { onBattery: false, lowPower: false };
    const index = createSearchIndex();
    // composeSearch binds the owner's switch the same way.
    const bound = filesAdapter({
      ...filesSourceDeps({ folders: () => [{ path: root, mode: "ro" as const }] }),
      ocr: {
        recognize: helperRecognizer(() => node),
        power: () => power,
        enabled: () => config.sources.files.ocr,
        ...(opts.pagesPerPull === undefined ? {} : { pagesPerPull: opts.pagesPerPull }),
        ...(opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes }),
      },
    });
    const indexer = new SourceIndexer(index, [bound], {
      config: () => config,
      pauseMs: 0,
      power: () => power,
    });
    const prov = (name: string) =>
      (
        index.db.prepare("SELECT provenance FROM search_docs WHERE id LIKE ?").get(`%${name}`) as
          | { provenance: string }
          | undefined
      )?.provenance;
    return {
      root,
      outside,
      node,
      config,
      index,
      indexer,
      adapter: bound,
      prov,
      setPower: (p: PowerState) => {
        power = p;
      },
    };
  }

  it("is off by default: images are indexed by name and the helper is never called", async () => {
    const t = setup();
    await t.indexer.tick();
    expect(t.node.invocations.filter((i) => i.capability === "ocr.recognize")).toHaveLength(0);
    expect((await t.index.search({ q: "receipt.png" })).hits.length).toBeGreaterThan(0);
    expect((await t.index.search({ q: "Blue Bottle" })).hits).toHaveLength(0);
  });

  it("reads text in images once the owner switches it on; provenance follows the file", async () => {
    const t = setup();
    t.config.sources.files.ocr = true;
    await t.indexer.tick();
    const hit = await t.index.search({ q: "Blue Bottle Coffee" });
    expect(hit.hits[0]?.id).toContain("receipt.png");
    expect((await t.index.search({ q: "free cruise" })).hits[0]?.id).toContain("flyer.jpg");
    expect(t.prov("receipt.png")).toBe("owner");
    // A flyer in Downloads stays untrusted even though its text was read by our own helper.
    expect(t.prov("flyer.jpg")).toBe("untrusted");
  });

  it("never recognises anything outside the granted folders", async () => {
    const t = setup();
    t.config.sources.files.ocr = true;
    await t.indexer.tick();
    const paths = t.node.recognised.map((r) => r.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.startsWith(t.root))).toBe(true);
    expect(paths.some((p) => p.includes("secret.png") || p.endsWith("link.png"))).toBe(false);
    expect((await t.index.search({ q: "outside the grant" })).hits).toHaveLength(0);
  });

  it("waits for power and outside low-power mode, then catches up without a rebuild", async () => {
    const t = setup();
    t.config.sources.files.ocr = true;
    t.setPower({ onBattery: true, lowPower: false });
    await t.indexer.tick();
    expect(t.node.recognised).toHaveLength(0);
    t.setPower({ onBattery: false, lowPower: true });
    await t.indexer.tick();
    expect(t.node.recognised).toHaveLength(0);
    t.setPower({ onBattery: false, lowPower: false });
    await t.indexer.tick();
    await t.indexer.tick();
    expect((await t.index.search({ q: "Blue Bottle Coffee" })).hits[0]?.id).toContain(
      "receipt.png",
    );
  });

  it("a pull on battery indexes files by name, remembers them, and reads them on power", async () => {
    const t = setup();
    t.config.sources.files.ocr = true;
    // Pin the tie CI hits on coarse-timestamp filesystems: same mtime, so (mtime, path) order puts
    // receipt.png last and the cursor's own `path` names it.
    const when = new Date("2026-01-01T00:00:00Z");
    for (const f of ["Scans/receipt.png", "Downloads/flyer.jpg"])
      utimesSync(join(t.root, f), when, when);
    t.setPower({ onBattery: true, lowPower: false });
    const first = await t.adapter.pull(null, { signal: never, limit: 100 });
    expect(t.node.recognised).toHaveLength(0);
    expect(first.items.map((i) => i.text).join("\n")).not.toContain("Blue Bottle");
    // The files waiting for power live in the cursor's `ocr` queue. Assert on that queue, not on the
    // whole cursor: its `path` is the last file in (mtime, path) order, which is receipt.png
    // whenever the two fixtures get the same mtime (coarse filesystem timestamps on CI).
    const queued = (c: unknown) => (c as { ocr?: string[] }).ocr ?? [];
    expect(
      queued(first.cursor)
        .map((p) => basename(p))
        .sort(),
    ).toEqual(["flyer.jpg", "receipt.png"]);
    t.setPower({ onBattery: false, lowPower: false });
    const second = await t.adapter.pull(first.cursor, { signal: never, limit: 100 });
    expect(second.items.map((i) => i.text).join("\n")).toContain("Blue Bottle Coffee");
    expect(second.hasMore).toBe(false);
    expect(queued(second.cursor)).toEqual([]);
  });

  it("spends a page budget per pull and carries the rest to the next ones", async () => {
    const t = setup({ pagesPerPull: 1 });
    for (const n of ["a", "b", "c"]) {
      const p = join(t.root, "Scans", `${n}.png`);
      writeFileSync(p, "x");
      t.node.image(p, `note ${n}`);
    }
    t.config.sources.files.ocr = true;
    const pull = async () => {
      const r = await t.adapter.pull(null, { signal: never, limit: 100 });
      return r;
    };
    const first = await pull();
    expect(t.node.recognised).toHaveLength(1);
    // The files OCR skipped are in the cursor and the source says there is more to do.
    expect(first.hasMore).toBe(true);
    const second = await t.adapter.pull(first.cursor, { signal: never, limit: 100 });
    expect(t.node.recognised).toHaveLength(2);
    expect(second.items.length).toBe(1);
    let cursor = second.cursor;
    for (let i = 0; i < 10; i++) {
      const r = await t.adapter.pull(cursor, { signal: never, limit: 100 });
      cursor = r.cursor;
      if (!r.hasMore) break;
    }
    expect(new Set(t.node.recognised.map((r) => r.path)).size).toBe(t.node.recognised.length);
    expect(t.node.recognised.length).toBe(5);
  });

  it("does not send files over the size cap", async () => {
    const t = setup({ maxFileBytes: 4 });
    t.config.sources.files.ocr = true;
    await t.indexer.tick();
    expect(t.node.recognised).toHaveLength(0);
  });

  it("switching it off removes the read text; switching on re-reads what was indexed by name", async () => {
    const t = setup();
    await t.indexer.tick();
    expect((await t.index.search({ q: "Blue Bottle" })).hits).toHaveLength(0);
    t.config.sources.files.ocr = true;
    await t.indexer.applyConfig();
    t.adapter.invalidate();
    await t.indexer.tick();
    expect((await t.index.search({ q: "Blue Bottle" })).hits.length).toBe(1);
    t.config.sources.files.ocr = false;
    await t.indexer.applyConfig();
    t.adapter.invalidate();
    await t.indexer.tick();
    expect((await t.index.search({ q: "Blue Bottle" })).hits).toHaveLength(0);
    expect((await t.index.search({ q: "receipt.png" })).hits.length).toBeGreaterThan(0);
    expect(t.indexer.status().sources.find((s) => s.id === "files")?.ocr).toBe(false);
  });

  it("merges a scanned PDF's recognised pages with its extracted text layer", async () => {
    const t = setup();
    const pdf = join(t.root, "Scans", "lease.pdf");
    writeFileSync(pdf, "%PDF");
    t.node.pdf(pdf, [
      { layer: "Page one has a good text layer, long enough to keep." },
      { scan: "Deposit 2400 euro" },
    ]);
    const adapter = filesAdapter({
      ...filesSourceDeps({ folders: () => [{ path: t.root, mode: "ro" as const }] }),
      extractDocument: async () => "Page one has a good text layer, long enough to keep.",
      ocr: {
        recognize: helperRecognizer(() => t.node),
        enabled: () => true,
      },
    });
    const { items } = await adapter.pull(null, { signal: never, limit: 100 });
    const lease = items.find((i) => i.path === pdf);
    expect(lease?.text).toContain("good text layer");
    expect(lease?.text).toContain("Deposit 2400 euro");
    expect(t.node.recognised.filter((r) => r.path === pdf).map((r) => r.page)).toEqual([2]);
  });
});

describe("Library images", () => {
  const item = (over: Record<string, unknown>) =>
    ({
      id: "lib_1",
      mime: "image/png",
      path: "uploads/shot.png",
      name: "shot.png",
      quarantined: false,
      ...over,
    }) as never;

  it("reads an image only when OCR is passed, and never a quarantined download", async () => {
    const home = tmp();
    mkdirSync(join(home, "library", "uploads"), { recursive: true });
    writeFileSync(join(home, "library", "uploads", "shot.png"), "png");
    const seen: string[] = [];
    const recognize = async (path: string) => {
      seen.push(path);
      return { text: "Boarding pass gate 12", pages: 1 };
    };
    expect(await libraryText(home, item({}))).toBe("");
    expect(await libraryText(home, item({}), recognize)).toContain("Boarding pass gate 12");
    expect(seen).toHaveLength(1);
    expect(await libraryText(home, item({ quarantined: true }), recognize)).toBe("");
    expect(seen).toHaveLength(1);
    expect(isOcrCandidate(item({ mime: "text/plain" }))).toBe(false);
    expect(isOcrCandidate(item({ mime: "application/pdf" }))).toBe(true);
    // A path escaping the Library root is never sent.
    expect(await libraryText(home, item({ path: "../../etc/shot.png" }), recognize)).toBe("");
    expect(seen).toHaveLength(1);
  });
});
