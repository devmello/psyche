import type { Artifact } from "@psyche/protocol";

/**
 * Artifact sandbox (P6, docs/05, docs/06 §3.7). Untrusted HTML runs in
 * `<iframe sandbox="allow-scripts" srcdoc>`: never `allow-same-origin`, so the document has an
 * opaque origin with no access to the app's DOM, storage or cookies. A CSP `<meta>` is the first
 * thing in `<head>` and forbids every network fetch (`connect-src 'none'`, images and fonts from
 * `data:`/`blob:` only). Sizing and link clicks go through a small postMessage bridge (no
 * iframe-resizer: GPL/commercial, ADR-013).
 *
 * Two placements:
 * - inline: the app embeds the srcdoc frame directly. A srcdoc document also inherits the app's
 *   own CSP, so this only works when the app's policy allows inline scripts in frames.
 * - hosted: the Gateway serves `artifactHostPage()` on a separate origin (an `artifacts.`
 *   host or a distinct loopback port); the app frames that page and posts it the srcdoc, and the
 *   host page owns the sandboxed inner frame. A sandbox escape then lands on an origin with
 *   nothing in it.
 *
 * Residual channel: a sandboxed frame may still navigate itself (`location = ...`). The bridge
 * turns link clicks into `open-link` requests, `ArtifactFrame` tears the frame down on any
 * second load, and the desktop shell must cancel subframe navigations away from the artifacts
 * origin (Electron `will-frame-navigate`).
 */

export const ARTIFACT_SANDBOX = "allow-scripts";
export const ARTIFACT_MIME = "application/vnd.psyche.artifact+html";
export const BRIDGE_TAG = "psyche-artifact";
export const MAX_ARTIFACT_HEIGHT = 20_000;
/** Largest srcdoc we will build (Claude caps artifacts at 20 MB of text; we stay lower). */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export interface ArtifactPolicy {
  /** Run the artifact's own scripts. False for email previews: only the nonce'd bridge runs. */
  allowScripts: boolean;
  /** Allow `https:` images (email "Load remote images"). Never for artifacts. */
  allowRemoteImages?: boolean;
  /** Extra script/style origins, e.g. the artifacts origin's self-hosted libraries. */
  libraryOrigins?: string[];
}

export function randomToken(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

export function buildArtifactCsp(policy: ArtifactPolicy, nonce: string): string {
  const libs = (policy.libraryOrigins ?? []).filter((o) => ORIGIN_RE.test(o));
  const scripts = policy.allowScripts ? ["'unsafe-inline'", ...libs] : [`'nonce-${nonce}'`];
  const img = ["data:", "blob:", ...(policy.allowRemoteImages ? ["https:"] : [])];
  return [
    "default-src 'none'",
    `script-src ${scripts.join(" ")}`,
    `style-src 'unsafe-inline' ${libs.join(" ")}`.trim(),
    `img-src ${img.join(" ")}`,
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** The in-frame half of the bridge. `channel` ties messages to one frame instance. */
export function bridgeScript(channel: string): string {
  return `(function(){
var C=${JSON.stringify(channel)},T=${JSON.stringify(BRIDGE_TAG)};
function post(m){m.tag=T;m.channel=C;try{parent.postMessage(m,"*")}catch(e){}}
var last=-1;function size(){var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h!==last){last=h;post({type:"resize",height:h})}}
if(typeof ResizeObserver==="function"){new ResizeObserver(size).observe(document.documentElement)}
addEventListener("load",function(){size();post({type:"ready"})});
document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();post({type:"open-link",href:String(a.href).slice(0,4096)})},true);
addEventListener("error",function(e){post({type:"error",message:String(e.message||"error").slice(0,500)})});
})();`;
}

export interface BuiltArtifact {
  srcdoc: string;
  channel: string;
  csp: string;
}

/** Builds the srcdoc. The artifact's HTML goes after our head prefix, verbatim. */
export function buildArtifactSrcdoc(html: string, policy: ArtifactPolicy): BuiltArtifact {
  if (html.length > MAX_ARTIFACT_BYTES) throw new RangeError("artifact too large");
  const nonce = randomToken();
  const channel = randomToken();
  const csp = buildArtifactCsp(policy, nonce);
  const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const head = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light dark">',
    `<script nonce="${nonce}">${bridgeScript(channel)}</script>`,
    "</head><body>",
  ].join("");
  return { srcdoc: `${head}${html}`, channel, csp };
}

export type BridgeMessage =
  | { type: "ready" }
  | { type: "resize"; height: number }
  | { type: "open-link"; href: string }
  | { type: "error"; message: string }
  /** Hosted placement only: the host page saw the inner frame navigate away and removed it. */
  | { type: "navigated" };

/**
 * Validates a message from an artifact frame. The caller must already have checked
 * `event.source === iframe.contentWindow`; this checks the origin, tag, channel and shape.
 */
export function parseBridgeMessage(
  data: unknown,
  origin: string,
  expected: { origin: string; channel: string },
): BridgeMessage | undefined {
  if (origin !== expected.origin) return undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const m = data as Record<string, unknown>;
  if (m.tag !== BRIDGE_TAG || m.channel !== expected.channel) return undefined;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "resize": {
      const h = m.height;
      if (typeof h !== "number" || !Number.isFinite(h)) return undefined;
      return { type: "resize", height: Math.min(Math.max(0, Math.round(h)), MAX_ARTIFACT_HEIGHT) };
    }
    case "open-link": {
      if (typeof m.href !== "string") return undefined;
      const href = safeLink(m.href);
      return href === undefined ? undefined : { type: "open-link", href };
    }
    case "navigated":
      return { type: "navigated" };
    case "error":
      return typeof m.message === "string"
        ? { type: "error", message: m.message.slice(0, 500) }
        : undefined;
    default:
      return undefined;
  }
}

/** Only http(s) and mailto links leave a frame, and they open in the browser pane. */
export function safeLink(href: string): string | undefined {
  try {
    const u = new URL(href);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:")
      return u.href;
  } catch {
    return undefined;
  }
  return undefined;
}

// ── Hosted placement (served by the Gateway on the artifacts origin) ─────────────────

export const HOST_RENDER = "psyche-artifact-render";

/**
 * The host page the Gateway serves on the artifacts origin. It accepts one `render` message
 * from `parentOrigin`, builds the sandboxed inner frame, and relays its bridge messages (re-tagged
 * with the channel) to the parent with an explicit target origin.
 */
export function artifactHostPage(parentOrigin: string, nonce: string): string {
  if (!ORIGIN_RE.test(parentOrigin)) throw new TypeError("parentOrigin must be an http(s) origin");
  const script = `(function(){
var P=${JSON.stringify(parentOrigin)},T=${JSON.stringify(BRIDGE_TAG)},R=${JSON.stringify(HOST_RENDER)},inner=null,ch=null;
addEventListener("message",function(e){
 if(e.source===parent&&e.origin===P&&e.data&&e.data.type===R&&typeof e.data.srcdoc==="string"&&typeof e.data.channel==="string"){
  if(inner)inner.remove();ch=e.data.channel;inner=document.createElement("iframe");
  inner.setAttribute("sandbox",${JSON.stringify(ARTIFACT_SANDBOX)});inner.setAttribute("referrerpolicy","no-referrer");
  inner.style.cssText="border:0;width:100%;height:100%;display:block";var loads=0,me=inner;inner.addEventListener("load",function(){if(++loads>1&&me===inner){parent.postMessage({tag:T,channel:ch,type:"navigated"},P);inner.remove();inner=null}});inner.srcdoc=e.data.srcdoc;document.body.appendChild(inner);return}
 if(inner&&e.source===inner.contentWindow&&e.data&&e.data.tag===T&&e.data.channel===ch){parent.postMessage(e.data,P)}
});
parent.postMessage({tag:T,type:"host-ready"},P);
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style><script nonce="${nonce}">${script}</script></head><body></body></html>`;
}

/**
 * Response headers for the host page. srcdoc children inherit this policy, so it must allow
 * inline scripts and styles; everything else is denied, and only the app may frame it.
 */
export function artifactHostHeaders(parentOrigin: string): Record<string, string> {
  if (!ORIGIN_RE.test(parentOrigin)) throw new TypeError("parentOrigin must be an http(s) origin");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data: blob: https:",
      "font-src data:",
      "media-src data: blob:",
      "connect-src 'none'",
      "frame-src 'self'",
      "child-src 'self'",
      "worker-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${parentOrigin}`,
    ].join("; "),
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), usb=(), payment=(), clipboard-read=()",
  };
}

// ── Update by name ───────────────────────────────────────────────────────────────────

/** "Sleep Dashboard!" → "sleep-dashboard". */
export function artifactSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug === "" ? "artifact" : slug;
}

export interface ArtifactUpsert {
  title: string;
  type: Artifact["type"];
  /** Defaults to the slug of the title: the "name" artifacts are updated by. */
  nameSlug?: string;
  sourceRef?: string | null;
}

/**
 * Update-by-name (E8, P6): an artifact with the same slug in the thread gets a new version
 * (same id, version + 1); otherwise a new artifact at version 1. The Gateway persists the result
 * and the Library item; this only decides what the record becomes.
 */
export function upsertArtifact(
  existing: readonly Artifact[],
  input: ArtifactUpsert,
  make: { id: () => string; libraryItemId: string; now: string },
): { artifact: Artifact; created: boolean } {
  const nameSlug =
    input.nameSlug === undefined ? artifactSlug(input.title) : artifactSlug(input.nameSlug);
  const prior = existing
    .filter((a) => a.nameSlug === nameSlug)
    .sort((a, b) => b.version - a.version)[0];
  if (prior !== undefined) {
    return {
      created: false,
      artifact: {
        ...prior,
        title: input.title,
        type: input.type,
        version: prior.version + 1,
        libraryItemId: make.libraryItemId,
        sourceRef: input.sourceRef ?? prior.sourceRef,
        updatedAt: make.now,
      },
    };
  }
  return {
    created: true,
    artifact: {
      id: make.id(),
      libraryItemId: make.libraryItemId,
      type: input.type,
      title: input.title,
      version: 1,
      nameSlug,
      sourceRef: input.sourceRef ?? null,
      updatedAt: make.now,
    },
  };
}
