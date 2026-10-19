import { FakeSandboxRunner } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  ChainedConversionService,
  ConversionError,
  GotenbergConversionService,
  libreOfficeArgv,
  qlmanageArgv,
  SandboxLibreOfficeService,
  safeFileName,
  type WorkspaceFiles,
} from "../src/core/convert.ts";
import { sniffMime } from "../src/core/detect.ts";
import { docxToHtml, docxToText } from "../src/core/docx.ts";
import { samplePptx, sampleDocx } from "./fixtures/office.ts";

describe("DOCX", () => {
  it("extracts text and semantic HTML", async () => {
    const bytes = await sampleDocx();
    const text = await docxToText(bytes);
    expect(text).toContain("Quarterly report");
    expect(text).toContain("Second paragraph.");
    expect(text).toContain("North");
    const { html } = await docxToHtml(bytes);
    expect(html).toContain("<table>");
    expect(html).toContain("First paragraph.");
  });

  it("sniffs OOXML kinds from the zip", async () => {
    expect(sniffMime(await sampleDocx())).toContain("wordprocessingml");
    expect(sniffMime(await samplePptx())).toContain("presentationml");
  });
});

describe("conversion services", () => {
  const input = { bytes: new Uint8Array([1, 2, 3]), name: "../../--evil deck.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

  it("sanitizes file names used in argv and paths", () => {
    expect(safeFileName("../../--evil deck.pptx")).toBe("evil deck.pptx");
    expect(safeFileName("a/b/c\u0000d.docx")).toBe("c_d.docx");
    expect(libreOfficeArgv("/w/in.pptx", "/w/out")).toEqual([
      "soffice", "--headless", "--norestore", "--nolockcheck", "--nodefault", "--convert-to", "pdf", "--outdir", "/w/out", "/w/in.pptx",
    ]);
    expect(qlmanageArgv("/t/a.key", "/t/out")).toEqual(["qlmanage", "-t", "-s", "1600", "-o", "/t/out", "/t/a.key"]);
  });

  it("posts to Gotenberg's LibreOffice route", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new GotenbergConversionService({ baseUrl: "http://127.0.0.1:3000/", fetch: fakeFetch });
    const out = await svc.convert(input, "pdf");
    expect(out.kind).toBe("pdf");
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/forms/libreoffice/convert");
    const file = (calls[0]?.init?.body as FormData).get("files") as File;
    expect(file.name).toBe("evil deck.pptx");
    expect(svc.supports({ name: "a.png" }, "pdf")).toBe(false);
  });

  it("runs soffice in the sandbox and cleans up", async () => {
    const store = new Map<string, Uint8Array>();
    const files: WorkspaceFiles = {
      write: async (p, b) => void store.set(p, b),
      read: async (p) => {
        const hit = store.get(p);
        if (!hit) throw new Error(`missing ${p}`);
        return hit;
      },
      remove: async (dir) => {
        for (const k of [...store.keys()]) if (k.startsWith(dir)) store.delete(k);
      },
    };
    const runner = new FakeSandboxRunner();
    const sb = await runner.ensureSandbox({ kind: "task", id: "t1" });
    runner.script((req) => {
      if (req.argv[0] !== "soffice") return false;
      const out = req.argv[req.argv.indexOf("--outdir") + 1] ?? "";
      store.set(`${out.replace("/workspace/", "")}/evil deck.pdf`, new Uint8Array([0x25, 0x50]));
      return true;
    }, { exitCode: 0 });
    const svc = new SandboxLibreOfficeService({ runner, sandboxId: sb.id, files, workspacePath: "/workspace" });
    const out = await svc.convert(input, "pdf");
    expect(out.kind).toBe("pdf");
    const argv = runner.execs[0]?.argv ?? [];
    expect(argv[0]).toBe("soffice");
    expect(argv.at(-1)).toMatch(/^\/workspace\/\.psyche-convert\/[0-9a-f]{16}\/evil deck\.pptx$/);
    expect(store.size).toBe(0);
  });

  it("chains services and reports every failure", async () => {
    const failing = { id: "a", supports: () => true, convert: async () => { throw new Error("down"); } };
    const ok = { id: "b", supports: () => true, convert: async () => ({ kind: "pdf" as const, bytes: new Uint8Array() }) };
    expect((await new ChainedConversionService([failing, ok]).convert(input, "pdf")).kind).toBe("pdf");
    await expect(new ChainedConversionService([failing]).convert(input, "pdf")).rejects.toThrow(ConversionError);
    await expect(new ChainedConversionService([]).convert(input, "pdf")).rejects.toThrow(/no converter/);
  });
});
