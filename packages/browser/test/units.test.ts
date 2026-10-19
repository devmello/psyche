import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCdpCommand } from "../src/bridge/allowlist.ts";
import { keyEvents } from "../src/cdp/keys.ts";
import { looksLikeCardNumber } from "../src/cdp/page.ts";
import type { AXNode, CaptureSnapshotResult } from "../src/cdp/types.ts";
import { safeFilename } from "../src/downloads/library.ts";
import { sniff } from "../src/downloads/sniff.ts";
import { FileRecordingSink } from "../src/recording/recorder.ts";
import { buildSnapshot } from "../src/snapshot/builder.ts";
import { RefRegistry } from "../src/snapshot/refs.ts";
import { bindingHash, canonicalJson, classifyActivation } from "../src/tools/classify.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("download sniffing", () => {
  it("trusts bytes over declared types and flags executables", () => {
    expect(sniff(enc("%PDF-1.7"), "a.pdf", "application/pdf")).toMatchObject({
      mime: "application/pdf",
      mismatch: false,
    });
    expect(sniff(enc("%PDF-1.7"), "a.txt", "text/plain")).toMatchObject({
      mime: "application/pdf",
      mismatch: true,
    });
    expect(sniff(enc("\u007fELF..."), "report.pdf", "application/pdf")).toMatchObject({
      executable: true,
      mismatch: true,
    });
    expect(sniff(enc("#!/bin/sh\nrm -rf"), "x", null).executable).toBe(true);
    expect(sniff(enc("a,b\n1,2"), "d.csv", "text/csv").mime).toBe("text/csv");
    expect(sniff(new Uint8Array([0x50, 0x4b, 3, 4]), "f.docx", null).mime).toContain(
      "wordprocessingml",
    );
    expect(sniff(enc("hello"), "run.command", null).executable).toBe(true);
  });
  it("sanitizes server-chosen file names", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("..\\..\\x.exe")).toBe("x.exe");
    expect(safeFilename(".hidden")).toBe("hidden");
    expect(safeFilename("a\u0000b:c")).toBe("a_b_c");
    expect(safeFilename("")).toBe("download");
  });
});

describe("keys and card numbers", () => {
  it("builds key events with modifiers and editing commands", () => {
    expect(keyEvents("Enter")[0]).toMatchObject({ type: "keyDown", key: "Enter", text: "\r" });
    expect(keyEvents("Shift+Tab")[0]).toMatchObject({
      type: "rawKeyDown",
      key: "Tab",
      modifiers: 8,
    });
    expect(keyEvents("Meta+a")[0]).toMatchObject({ commands: ["selectAll"], modifiers: 4 });
    expect(() => keyEvents("Hyper+x")).toThrow();
    expect(() => keyEvents("NotAKey")).toThrow();
  });
  it("detects Luhn-valid card numbers only", () => {
    expect(looksLikeCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCardNumber("pay with 5555-5555-5555-4444 now")).toBe(true);
    expect(looksLikeCardNumber("4242 4242 4242 4241")).toBe(false);
    expect(looksLikeCardNumber("call 415 555 0100")).toBe(false);
  });
});

describe("binding hashes and classification", () => {
  it("canonicalizes deterministically and rejects ambiguous values", () => {
    expect(canonicalJson({ b: 1, a: ["x", null] })).toBe('{"a":["x",null],"b":1}');
    expect(canonicalJson({ s: "é" })).toBe(canonicalJson({ s: "é" }));
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ d: new Date() })).toThrow();
    expect(bindingHash("new_origin", { origin: "https://a.com" })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("classifies purchase, consent, destructive and submit paths", () => {
    const base = {
      ref: "ref_1",
      role: "button",
      tag: "BUTTON",
      inForm: false,
      submits: false,
      secure: false,
      frameOrigin: "https://a.com",
      opensPopup: false,
    };
    expect(classifyActivation({ ...base, name: "Buy now" }).sideEffect).toBe("financial");
    expect(
      classifyActivation({
        ...base,
        name: "Continue",
        submits: true,
        inForm: true,
        formAction: "https://a.com/checkout/pay",
        formMethod: "post",
      }).sideEffect,
    ).toBe("financial");
    expect(classifyActivation({ ...base, name: "Accept all" }).sideEffect).toBe("destructive");
    expect(classifyActivation({ ...base, name: "Delete repository" }).sideEffect).toBe(
      "destructive",
    );
    expect(
      classifyActivation({
        ...base,
        name: "Send",
        submits: true,
        inForm: true,
        formMethod: "post",
      }),
    ).toMatchObject({ sideEffect: "write", kind: "browser_submit" });
    expect(
      classifyActivation({
        ...base,
        name: "Search",
        submits: true,
        inForm: true,
        formMethod: "get",
      }).sideEffect,
    ).toBe("read");
    expect(classifyActivation(undefined).sideEffect).toBe("write");
  });
});

describe("bridge allowlist", () => {
  it("allows the driver's methods and denies the dangerous ones", () => {
    expect(checkCdpCommand("Accessibility.getFullAXTree", {}).ok).toBe(true);
    for (const m of [
      "Network.getAllCookies",
      "Storage.clearDataForOrigin",
      "Target.createTarget",
      "Fetch.enable",
      "Page.setDownloadBehavior",
      "Debugger.enable",
    ]) {
      expect(checkCdpCommand(m, {}).ok, m).toBe(false);
    }
    const world = { contexts: new Set([7]), objects: new Set(["o1"]) };
    expect(checkCdpCommand("Runtime.evaluate", { expression: "1" }, world).ok).toBe(false);
    expect(checkCdpCommand("Runtime.evaluate", { expression: "1", contextId: 7 }, world).ok).toBe(
      true,
    );
    expect(checkCdpCommand("Runtime.callFunctionOn", { objectId: "main" }, world).ok).toBe(false);
    expect(checkCdpCommand("Runtime.callFunctionOn", { objectId: "o1" }, world).ok).toBe(true);
    const doc = {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
    };
    expect(checkCdpCommand("Fetch.enable", doc).ok).toBe(true);
    expect(checkCdpCommand("Fetch.enable", { patterns: [{ urlPattern: "*" }] }).ok).toBe(false);
    expect(checkCdpCommand("Fetch.enable", { ...doc, handleAuthRequests: true }).ok).toBe(false);
    expect(checkCdpCommand("Fetch.continueRequest", { requestId: "1" }).ok).toBe(true);
    expect(checkCdpCommand("Fetch.continueRequest", { requestId: "1", url: "https://x" }).ok).toBe(
      false,
    );
    expect(checkCdpCommand("Fetch.fulfillRequest", { requestId: "1" }).ok).toBe(false);
  });
});

describe("recording", () => {
  it("writes throttled frames and a replay index without query strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "psyche-rec-"));
    const sink = new FileRecordingSink(dir, "task/1", { minIntervalMs: 100 });
    const data = new Uint8Array([0xff, 0xd8, 0xff]);
    await sink.frame({ tabId: "t", data, at: 1000, url: "https://a.com/p?token=abc" });
    await sink.frame({ tabId: "t", data, at: 1050, url: "https://a.com/p" });
    await sink.frame({ tabId: "t", data, at: 1200, url: "https://a.com/q" });
    await sink.close();
    const index = JSON.parse(await readFile(join(sink.dir, "index.json"), "utf8"));
    expect(index.frames.map((f: { url: string }) => f.url)).toEqual([
      "https://a.com/p",
      "https://a.com/q",
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});

/** Synthetic Wikipedia-sized page: about 5,000 AX nodes. */
function bigPage(n: number): { ax: AXNode[]; dom: CaptureSnapshotResult } {
  const ax: AXNode[] = [
    {
      nodeId: "0",
      ignored: false,
      role: { type: "role", value: "RootWebArea" },
      name: { type: "s", value: "Big" },
      childIds: [],
    },
  ];
  const strings = ["#document", "A", "P", "href", "/x"];
  const nodes = {
    parentIndex: [-1],
    nodeName: [0],
    backendNodeId: [1],
    attributes: [[]] as number[][],
  };
  const layout = { nodeIndex: [] as number[], bounds: [] as number[][] };
  for (let i = 1; i <= n; i++) {
    const link = i % 4 === 0;
    const id = String(i);
    ax.push({
      nodeId: id,
      parentId: "0",
      ignored: false,
      backendDOMNodeId: i + 1,
      role: { type: "role", value: link ? "link" : "paragraph" },
      name: { type: "s", value: link ? `Link ${i}` : "" },
      childIds: [`t${i}`],
    });
    ax.push({
      nodeId: `t${i}`,
      parentId: id,
      ignored: false,
      role: { type: "role", value: "StaticText" },
      name: { type: "s", value: `Text number ${i} with some words in it` },
    });
    ax[0]?.childIds?.push(id);
    nodes.parentIndex.push(0);
    nodes.nodeName.push(link ? 1 : 2);
    nodes.backendNodeId.push(i + 1);
    nodes.attributes.push(link ? [3, 4] : []);
    layout.nodeIndex.push(i);
    layout.bounds.push([0, i * 20, 300, 18]);
  }
  return {
    ax,
    dom: { strings, documents: [{ documentURL: -1, title: -1, frameId: -1, nodes, layout }] },
  };
}

describe("snapshot budgets", () => {
  it("builds a 5,000-node snapshot well under 300 ms and caps its size", () => {
    const { ax, dom } = bigPage(2500);
    const refs = new RefRegistry();
    refs.setDocument("doc");
    const t0 = performance.now();
    const snap = buildSnapshot({
      url: "https://big.example/",
      title: "Big",
      ax,
      dom,
      dpr: 1,
      viewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 },
      refs,
    });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(300);
    expect(snap.text.length).toBeLessThanOrEqual(24_200);
    expect(snap.truncated).toBe(true);
    expect(snap.refs.length).toBe(400);
    expect(snap.refs.every((r) => r.interactive)).toBe(true);
    const again = buildSnapshot({
      url: "https://big.example/",
      title: "Big",
      ax,
      dom,
      dpr: 1,
      viewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 },
      refs,
    });
    expect(again.refs.map((r) => r.ref)).toEqual(snap.refs.map((r) => r.ref));
  });
});
