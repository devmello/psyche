import type { ViewerRegistry, ViewerSpec } from "@psyche/protocol";
import { FakeViewerRegistry } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { detectMime, sniffMime } from "../src/core/detect.ts";
import {
  createDefaultViewerRegistry,
  DefaultViewerRegistry,
  extensionOf,
} from "../src/core/registry.ts";

const base = (over: Partial<ViewerSpec>): ViewerSpec => ({
  id: "x",
  mimeTypes: [],
  canEdit: false,
  render: "text",
  ...over,
});

/** Contract tests for `ViewerRegistry`, run against our registry and the reference fake. */
function registryContract(name: string, make: () => ViewerRegistry) {
  describe(`ViewerRegistry contract: ${name}`, () => {
    it("resolves exact MIME before wildcard before extension", () => {
      const r = make();
      r.register(base({ id: "ext", extensions: ["png"], render: "code" }));
      r.register(base({ id: "wild", mimeTypes: ["image/*"], render: "image" }));
      r.register(base({ id: "exact", mimeTypes: ["image/png"], render: "image" }));
      expect(r.resolve("image/png", "a.png")?.id).toBe("exact");
      expect(r.resolve("image/gif", "a.gif")?.id).toBe("wild");
      expect(r.resolve("application/octet-stream", "a.png")?.id).toBe("ext");
    });

    it("ignores MIME parameters and case", () => {
      const r = make();
      r.register(base({ id: "csv", mimeTypes: ["text/csv"] }));
      expect(r.resolve("Text/CSV; charset=utf-8")?.id).toBe("csv");
    });

    it("breaks ties by priority", () => {
      const r = make();
      r.register(base({ id: "low", mimeTypes: ["text/plain"], priority: 0 }));
      r.register(base({ id: "high", mimeTypes: ["text/plain"], priority: 5 }));
      expect(r.resolve("text/plain")?.id).toBe("high");
    });

    it("returns undefined for unknown types and names without an extension", () => {
      const r = make();
      r.register(base({ id: "md", extensions: ["md"] }));
      expect(r.resolve("application/x-unknown")).toBeUndefined();
      expect(r.resolve("application/x-unknown", "README")).toBeUndefined();
    });

    it("unregisters and returns copies", () => {
      const r = make();
      const off = r.register(base({ id: "a", mimeTypes: ["text/plain"] }));
      const got = r.resolve("text/plain");
      if (got) got.id = "mutated";
      expect(r.list().map((s) => s.id)).toEqual(["a"]);
      off();
      expect(r.list()).toEqual([]);
      expect(r.resolve("text/plain")).toBeUndefined();
    });
  });
}

registryContract("DefaultViewerRegistry", () => new DefaultViewerRegistry());
registryContract("FakeViewerRegistry", () => new FakeViewerRegistry());

describe("default viewers", () => {
  const r = createDefaultViewerRegistry();
  it.each([
    ["application/pdf", "a.pdf", "pdf"],
    ["application/octet-stream", "Budget.XLSX", "sheet"],
    ["text/csv", "a.csv", "sheet"],
    ["", "deck.pptx", "slides"],
    ["image/svg+xml", "logo.svg", "image"],
    ["application/json", "a.json", "json"],
    ["text/markdown", "SOUL.md", "markdown"],
    ["message/rfc822", "mail.eml", "email"],
    ["application/vnd.psyche.artifact+html", "dash", "artifact"],
    ["text/plain", "main.py", "text"],
    ["application/octet-stream", "main.py", "code"],
    ["text/html", "page.html", "code"],
    ["text/plain", "notes.txt", "text"],
  ])("%s %s → %s", (mime, name, render) => {
    expect(r.resolve(mime, name)?.render).toBe(render);
  });

  it("never renders HTML files as live pages", () => {
    expect(r.resolve("text/html", "x.html")?.render).not.toBe("artifact");
  });
});

describe("detection", () => {
  it("sniffs magic bytes", () => {
    expect(sniffMime(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png");
    expect(sniffMime(new TextEncoder().encode("hello"))).toBeUndefined();
  });

  it("prefers bytes over a lying name and demotes fake PDFs", () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script>");
    expect(detectMime({ name: "invoice.pdf", mime: "application/pdf", bytes: html })).toBe(
      "application/octet-stream",
    );
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    expect(detectMime({ name: "x.txt", bytes: png })).toBe("image/png");
    expect(detectMime({ name: "a.csv", mime: "application/octet-stream" })).toBe("text/csv");
  });

  it("parses extensions", () => {
    expect(extensionOf("a/b/C.Tar.GZ")).toBe("gz");
    expect(extensionOf(".bashrc")).toBeUndefined();
    expect(extensionOf("README")).toBeUndefined();
  });
});
