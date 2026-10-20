import {
  type FxAction,
  type FxHost,
  type FxNode,
  type FxPage,
  resolveHref,
  SESSION_COOKIE,
  signedInText,
} from "./site.ts";

/** Renders a fixture page to plain semantic HTML (with a small action script) for real browsers. */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type OriginFn = (h: FxHost) => string;

/** Request cookies, for `signed_in` nodes. */
export type Cookies = ReadonlyMap<string, string>;
let cookies: Cookies = new Map();

function resolveAction(a: FxAction, host: FxHost, origin: OriginFn): FxAction {
  switch (a.kind) {
    case "navigate":
    case "popup":
    case "push_state":
      return { ...a, href: a.kind === "push_state" ? a.href : resolveHref(a.href, host, origin) };
    case "confirm":
      return { ...a, onConfirm: resolveAction(a.onConfirm, host, origin) };
    default:
      return a;
  }
}

function actionAttr(a: FxAction, host: FxHost, origin: OriginFn): string {
  return ` data-action="${esc(JSON.stringify(resolveAction(a, host, origin)))}"`;
}

let fieldSeq = 0;

function node(n: FxNode, host: FxHost, origin: OriginFn): string {
  switch (n.kind) {
    case "heading":
      return `<h${n.level}>${esc(n.text)}</h${n.level}>`;
    case "text":
      return `<p>${esc(n.text)}</p>`;
    case "status":
      return `<p id="${esc(n.id)}" role="status">${esc(n.text)}</p>`;
    case "link":
      return `<p><a href="${esc(resolveHref(n.href, host, origin))}"${n.target === undefined ? "" : ` target="${n.target}"`}>${esc(n.text)}</a></p>`;
    case "button":
      return `<button type="${n.type ?? (n.onClick === undefined ? "submit" : "button")}"${n.onClick === undefined ? "" : actionAttr(n.onClick, host, origin)}>${esc(n.text)}</button>`;
    case "input": {
      const id = `f${++fieldSeq}`;
      const attrs = [
        `id="${id}"`,
        `name="${esc(n.name)}"`,
        `type="${n.type ?? "text"}"`,
        n.autocomplete === undefined ? "" : `autocomplete="${esc(n.autocomplete)}"`,
        n.value === undefined ? "" : `value="${esc(n.value)}"`,
        n.required === true ? "required" : "",
      ]
        .filter((a) => a !== "")
        .join(" ");
      return `<p><label for="${id}">${esc(n.label)}</label> <input ${attrs}></p>`;
    }
    case "select": {
      const id = `f${++fieldSeq}`;
      const opts = n.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
      return `<p><label for="${id}">${esc(n.label)}</label> <select id="${id}" name="${esc(n.name)}">${opts}</select></p>`;
    }
    case "form":
      return `<form action="${esc(resolveHref(n.action, host, origin))}" method="${n.method ?? "get"}">${n.children.map((c) => node(c, host, origin)).join("")}</form>`;
    case "section": {
      const tag =
        n.role === "main"
          ? "main"
          : n.role === "navigation"
            ? "nav"
            : n.role === "banner"
              ? "header"
              : n.role === "contentinfo"
                ? "footer"
                : "section";
      const label = n.label === undefined ? "" : ` aria-label="${esc(n.label)}"`;
      return `<${tag}${label}>${n.children.map((c) => node(c, host, origin)).join("")}</${tag}>`;
    }
    case "list":
      return `<ul>${n.items.map((i) => `<li>${node(i, host, origin)}</li>`).join("")}</ul>`;
    case "table":
      return `<table><caption>${esc(n.caption)}</caption>${n.rows
        .map(
          (r, i) =>
            `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`,
        )
        .join("")}</table>`;
    case "iframe":
      return `<iframe src="${esc(resolveHref(n.src, host, origin))}" title="${esc(n.title)}" width="400" height="120"></iframe>`;
    case "canvas":
      return `<canvas width="${n.width}" height="${n.height}"></canvas>`;
    case "image":
      return `<img alt="${esc(n.alt)}" width="64" height="64" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`;
    case "clickable":
      return `<div class="clickable"${actionAttr(n.onClick, host, origin)}>${esc(n.text)}</div>`;
    case "overlay":
      return `<div class="clickable" style="position:fixed;inset:0;background:rgba(0,0,0,0.02)"${actionAttr(n.onClick, host, origin)}>${esc(n.text)}</div>`;
    case "spacer":
      return `<div style="height:${n.height}px"></div>`;
    case "signed_in":
      return `<p id="whoami" role="status">${esc(signedInText(cookies.get(SESSION_COOKIE)))}</p>`;
  }
}

const SCRIPT = `
function run(a) {
  if (a.kind === "alert") alert(a.message);
  else if (a.kind === "confirm") { if (confirm(a.message)) run(a.onConfirm); }
  else if (a.kind === "navigate") location.href = a.href;
  else if (a.kind === "popup") window.open(a.href, "_blank", "popup");
  else if (a.kind === "set_text") document.getElementById(a.id).textContent = a.text;
  else if (a.kind === "push_state") history.pushState({}, "", a.href);
  else if (a.kind === "post_to_opener_and_close") { if (window.opener) window.opener.postMessage(a.message, "*"); window.close(); }
}
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el) run(JSON.parse(el.dataset.action));
});
window.addEventListener("message", (e) => {
  const s = document.getElementById("status");
  if (s && typeof e.data === "string") s.textContent = "Received: " + e.data;
});
`;

export function renderHtml(
  page: FxPage,
  host: FxHost,
  origin: OriginFn,
  requestCookies: Cookies = new Map(),
): string {
  fieldSeq = 0;
  cookies = requestCookies;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(page.title)}</title>
<style>body{font:16px sans-serif;margin:20px} .clickable{cursor:pointer;display:inline-block;padding:4px}</style>
</head><body>${page.body.map((n) => node(n, host, origin)).join("\n")}<script>${SCRIPT}</script></body></html>`;
}
