import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecRequest, type ExecResult, PsycheError } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConversionRunner,
  composeConversion,
  conversionArgv,
  sandboxFileName,
} from "../src/compose/convert.ts";

let base: string;
let granted: string;
let home: string;

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

interface Fake extends ConversionRunner {
  execs: ExecRequest[];
  imports: { path: string; provenance?: string }[];
}

function fakeRunner(
  options: { backend?: boolean; ensure?: () => never; exitCode?: number } = {},
): Fake {
  const execs: ExecRequest[] = [];
  const imports: { path: string; provenance?: string }[] = [];
  const result = (exitCode: number): ExecResult => ({
    exitCode,
    stdout: "",
    stderr: "",
    durationMs: 1,
    truncated: false,
    filesChanged: [],
    timedOut: false,
  });
  return {
    execs,
    imports,
    backend: async () => (options.backend === false ? null : { kind: "docker" }),
    ensureSandbox: async () => {
      options.ensure?.();
      return {
        id: "sbx_convert",
        scope: { kind: "project", id: "psyche-convert" },
        backend: "docker",
        network: "none",
      } as never;
    },
    exec: async (r) => {
      execs.push(r);
      return result(r.argv[0] === "rm" ? 0 : (options.exitCode ?? 0));
    },
    files: {
      importFile: async (_id, path, _bytes, o) => {
        imports.push({ path, ...(o?.provenance ? { provenance: o.provenance } : {}) });
        return {};
      },
      exportFile: async () => ({ bytes: PDF }),
    },
  };
}

async function convert(runner: ConversionRunner, params: Record<string, unknown>) {
  const part = composeConversion({
    folders: () => [{ path: granted, mode: "ro" }],
    home,
    runner: () => runner,
  });
  const h = part.handlers?.["documents.convert"];
  if (h === undefined) throw new Error("no handler");
  return {
    part,
    run: (p = params) => h.run({} as never, p as never) as Promise<Record<string, unknown>>,
  };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (err) {
    if (!(err instanceof PsycheError)) throw err;
    return { code: err.code, reason: (err.details as { reason?: string } | undefined)?.reason };
  }
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "psyche-convert-")));
  granted = join(base, "granted");
  home = join(base, "home");
  await mkdir(granted, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(granted, "Pitch deck.pptx"), "PK fake deck");
  await writeFile(join(granted, "notes.txt"), "plain text");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("documents.convert", () => {
  it("converts in the sandbox once, then serves the cached PDF", async () => {
    const runner = fakeRunner();
    const { run } = await convert(runner, {
      path: join(granted, "Pitch deck.pptx"),
      target: "pdf",
    });
    const out = await run();
    expect(out).toMatchObject({ mime: "application/pdf", size: PDF.length, nextOffset: null });
    expect(Buffer.from(out.bytes as string, "base64")).toEqual(Buffer.from(PDF));
    // The file went in untrusted under a safe name; soffice ran there, then the folder went.
    expect(runner.imports[0]?.path).toMatch(/^\.psyche-convert\/[0-9a-f-]+\/Pitch_deck\.pptx$/);
    expect(runner.imports[0]?.provenance).toBe("untrusted");
    expect(runner.execs.map((e) => e.argv[0])).toEqual(["soffice", "rm"]);
    expect(runner.execs[0]?.provenance).toBe("untrusted");
    await run();
    expect(runner.execs).toHaveLength(2);
    // An edit changes the etag, so the file converts again.
    await writeFile(join(granted, "Pitch deck.pptx"), "PK a longer fake deck");
    await run();
    expect(runner.execs).toHaveLength(4);
  });

  it("says why it can't convert: no runtime, no full image", async () => {
    const pptx = { path: join(granted, "Pitch deck.pptx"), target: "pdf" };
    expect(await failure((await convert(fakeRunner({ backend: false }), pptx)).run())).toEqual({
      code: "unavailable",
      reason: "sandbox_unavailable",
    });
    const noImage = fakeRunner({
      ensure: () => {
        throw new PsycheError(
          "unavailable",
          "sandbox image psyche-sandbox:full-dev is not present",
        );
      },
    });
    expect(await failure((await convert(noImage, pptx)).run())).toEqual({
      code: "unavailable",
      reason: "image_missing",
    });
    // An image without LibreOffice: the shell can't find soffice.
    expect(await failure((await convert(fakeRunner({ exitCode: 127 }), pptx)).run())).toEqual({
      code: "unavailable",
      reason: "image_missing",
    });
    expect(await failure((await convert(fakeRunner({ exitCode: 1 }), pptx)).run())).toEqual({
      code: "internal",
      reason: undefined,
    });
  });

  it("refuses files it doesn't convert and paths outside the grants", async () => {
    const runner = fakeRunner();
    const { run } = await convert(runner, {});
    expect(await failure(run({ path: join(granted, "notes.txt"), target: "pdf" }))).toMatchObject({
      code: "invalid_params",
    });
    expect(await failure(run({ path: join(base, "elsewhere.pptx"), target: "pdf" }))).toMatchObject(
      {
        code: "forbidden",
      },
    );
    expect(runner.execs).toHaveLength(0);
  });

  it("builds a soffice argv with a throwaway profile, and PNG for thumbnails", () => {
    const pdf = conversionArgv("/workspace/c/a.pptx", "/workspace/c/out", "pdf");
    expect(pdf[0]).toBe("soffice");
    expect(pdf).toContain("--headless");
    expect(pdf[1]).toBe("-env:UserInstallation=file:///workspace/c/out/../profile");
    expect(pdf.slice(pdf.indexOf("--convert-to"), pdf.indexOf("--convert-to") + 2)).toEqual([
      "--convert-to",
      "pdf",
    ]);
    expect(conversionArgv("/w/a.pptx", "/w/out", "thumbnail")).toContain("png");
    expect(sandboxFileName("Q3 plan (final).pptx")).toBe("Q3_plan_final_.pptx");
    expect(sandboxFileName("../../etc/passwd")).toBe("_.._etc_passwd");
  });
});
