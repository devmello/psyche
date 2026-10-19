import type { RefBox } from "@psyche/protocol";
import type { AXNode, CaptureSnapshotResult, LayoutViewport } from "../cdp/types.ts";
import { tryOrigin } from "../origin/canonical.ts";
import { redactUrl } from "../origin/redact-url.ts";
import type { BrowserSnapshot, ElementMeta, SnapshotOptions, SnapshotRefEx } from "../types.ts";
import { DomIndex, type DomNodeInfo } from "./dom.ts";
import type { RefRegistry } from "./refs.ts";

/**
 * Accessibility snapshot builder (architecture §8; spike 01 "Snapshot latency"; spike 04 pruning
 * rules adapted to web content). Input is raw CDP: `Accessibility.getFullAXTree` for the top
 * frame (plus same-origin child frames), `DOMSnapshot.captureSnapshot` for tags, forms and
 * boxes, and the CSS viewport. Output is a pruned, depth-capped tree with stable refs, paged to
 * a character budget, with interactive elements kept first when the budget bites.
 */

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "textfield",
  "popupbutton",
  "disclosuretriangle",
  "colorwell",
  "date",
  "datetime",
  "inputtime",
]);

const STRUCTURAL_ROLES = new Set([
  "heading",
  "img",
  "image",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "form",
  "search",
  "dialog",
  "alertdialog",
  "alert",
  "table",
  "row",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "list",
  "listitem",
  "region",
  "article",
  "complementary",
  "figure",
  "tablist",
  "tabpanel",
  "menu",
  "menubar",
  "toolbar",
  "status",
  "tree",
  "grid",
  "group",
  "radiogroup",
  "iframe",
  "progressbar",
  "meter",
]);

/** Roles that render their children as one name; their StaticText children are suppressed. */
const NAME_FROM_CONTENT = new Set([
  "button",
  "link",
  "heading",
  "option",
  "menuitem",
  "tab",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "listitem",
  "treeitem",
]);

/** Editable controls: their inner StaticText is the value, already shown as `value=`. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textfield"]);

const DROPPED_ROLES = new Set(["inlinetextbox", "linebreak", "listmarker"]);
const BLOCK_ROLES = new Set([
  "paragraph",
  "heading",
  "listitem",
  "row",
  "article",
  "section",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "dialog",
  "form",
  "list",
  "table",
  "blockquote",
  "region",
  "group",
  "figure",
  "generic",
]);
const STATES = [
  "focused",
  "checked",
  "pressed",
  "disabled",
  "expanded",
  "selected",
  "required",
  "readonly",
  "invalid",
  "modal",
] as const;

export const SECURE_MASK = "•••";

const CAPTCHA_HOSTS = [
  "www.google.com/recaptcha",
  "www.recaptcha.net",
  "hcaptcha.com",
  "newassets.hcaptcha.com",
  "challenges.cloudflare.com",
  "geo.captcha-delivery.com",
  "client-api.arkoselabs.com",
];
const CAPTCHA_NAME = /\b(captcha|i'?m not a robot|verify (that )?you are (a )?human)\b/i;

function looksLikeCaptcha(url: string, name: string): boolean {
  if (CAPTCHA_NAME.test(name)) return true;
  const u = url.replace(/^https?:\/\//, "");
  return CAPTCHA_HOSTS.some((h) => u.startsWith(h) || u.includes(`.${h}`));
}

export const DEFAULT_SNAPSHOT_LIMITS = {
  maxRefs: 400,
  maxChars: 24_000,
  maxDepth: 40,
  nameMax: 80,
  valueMax: 60,
  textMax: 120,
} as const;

export interface FrameAx {
  frameId: string;
  url: string;
  ax: AXNode[];
}

export interface SnapshotInput {
  url: string;
  title: string;
  ax: AXNode[];
  /** Same-origin child frames fetched with `getFullAXTree({frameId})`. */
  frames?: FrameAx[];
  dom: CaptureSnapshotResult;
  dpr: number;
  viewport: LayoutViewport;
  refs: RefRegistry;
  options?: SnapshotOptions;
  /** Vault redaction of known secret values (CredentialBroker.redact). */
  redact?: (text: string) => string;
  fetchMs?: number;
}

interface Line {
  text: string;
  kind: "node" | "text" | "header";
}

function axString(v: { value?: unknown } | undefined): string {
  const x = v?.value;
  return typeof x === "string" ? x : x === undefined || x === null ? "" : String(x);
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  const t = s.length > n ? `${s.slice(0, n - 1)}…` : s;
  return t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function roleOf(node: AXNode): string {
  return axString(node.role).toLowerCase();
}

/** Build the snapshot. Pure apart from registering refs in `input.refs`. */
export function buildSnapshot(input: SnapshotInput): BrowserSnapshot {
  const t0 = performance.now();
  const opts = { ...DEFAULT_SNAPSHOT_LIMITS, ...stripUndefined(input.options ?? {}) };
  const redact = input.redact ?? ((s: string) => s);
  const dom = new DomIndex(input.dom, input.dpr);
  const vp = input.viewport;
  const topOrigin = tryOrigin(input.url) ?? "null";
  const frameAx = new Map((input.frames ?? []).map((f) => [f.frameId, f]));

  const lines: Line[] = [];
  const refs: SnapshotRefEx[] = [];
  let interactive = 0;
  let kept = 0;
  let rawNodes = input.ax.length;
  let textChars = 0;
  let depthTruncated = false;
  let secureFieldActive = false;
  let captcha = false;

  const boxOf = (info: DomNodeInfo | undefined): { box?: RefBox; offscreen: boolean } => {
    if (info?.box === undefined) return { offscreen: false };
    const b = info.box;
    const box: RefBox = {
      x: Math.round(b.x - vp.pageX),
      y: Math.round(b.y - vp.pageY),
      width: Math.round(b.width),
      height: Math.round(b.height),
    };
    const offscreen =
      box.width <= 0 ||
      box.height <= 0 ||
      box.x + box.width <= 0 ||
      box.y + box.height <= 0 ||
      box.x >= vp.clientWidth ||
      box.y >= vp.clientHeight;
    return { box, offscreen };
  };

  const metaOf = (
    info: DomNodeInfo | undefined,
    role: string,
    name: string,
  ): Omit<ElementMeta, "ref"> => {
    const doc = info === undefined ? undefined : dom.documents[info.docIndex];
    const form = info === undefined ? undefined : dom.formOf(info);
    const target = (info?.attrs.target ?? "").toLowerCase();
    const meta: Omit<ElementMeta, "ref"> = {
      role,
      name,
      tag: info?.tag ?? "",
      inForm: form !== undefined,
      submits: info === undefined ? false : dom.submits(info),
      secure: info === undefined ? false : dom.isSecure(info),
      frameOrigin: doc?.origin ?? topOrigin,
      opensPopup: target === "_blank" || target === "_new",
    };
    const a = info?.attrs;
    if (a?.type !== undefined) meta.inputType = a.type.toLowerCase();
    if (a?.autocomplete !== undefined) meta.autocomplete = a.autocomplete;
    if (a?.name !== undefined) meta.fieldName = a.name;
    if (a?.inputmode !== undefined) meta.inputMode = a.inputmode;
    if (a?.maxlength !== undefined && /^\d+$/.test(a.maxlength))
      meta.maxLength = Number(a.maxlength);
    if (a?.contenteditable !== undefined && a.contenteditable !== "false")
      meta.contentEditable = true;
    if (a?.href !== undefined && doc !== undefined) {
      try {
        meta.href = new URL(a.href, doc.url).href;
      } catch {
        meta.href = a.href;
      }
    }
    if (form !== undefined) {
      const action = form.attrs.action ?? "";
      try {
        meta.formAction = new URL(action, doc?.url ?? input.url).href;
      } catch {
        meta.formAction = action;
      }
      meta.formMethod = (form.attrs.method ?? "get").toLowerCase();
      meta.formHasPassword = dom.formHasPassword(form);
    }
    return meta;
  };

  const visit = (
    node: AXNode | undefined,
    byId: Map<string, AXNode>,
    depth: number,
    rawDepth: number,
    parentName: string,
    suppressText: boolean,
  ): void => {
    if (node === undefined) return;
    if (rawDepth > opts.maxDepth) {
      depthTruncated = true;
      return;
    }
    const role = roleOf(node);
    const kids = (node.childIds ?? []).map((id) => byId.get(id));
    const walkKids = (d: number, pName: string, suppress: boolean) => {
      for (const k of kids) visit(k, byId, d, rawDepth + 1, pName, suppress);
    };
    if (node.ignored || DROPPED_ROLES.has(role)) {
      walkKids(depth, parentName, suppressText);
      return;
    }
    const indent = "  ".repeat(depth);
    if (role === "statictext") {
      const text = redact(norm(axString(node.name)));
      if (text === "" || suppressText || parentName.includes(text)) return;
      textChars += text.length;
      lines.push({ kind: "text", text: `${indent}- text "${clip(text, opts.textMax)}"` });
      return;
    }
    const info = dom.get(node.backendDOMNodeId);
    let name = redact(norm(axString(node.name)));
    // A `<div onclick>` is `generic` with no name in Chromium; name it from its text, unless it
    // wraps real controls or a whole page region (frameworks put listeners on root containers).
    let clickableGeneric = false;
    if (info?.clickable === true && (role === "generic" || role === "none") && name === "") {
      const t = descendantText(node, byId);
      if (t.text !== "" && t.text.length <= 200 && !t.hasInteractive) {
        name = redact(norm(t.text));
        clickableGeneric = true;
      }
    }
    const isInteractive = INTERACTIVE_ROLES.has(role) || clickableGeneric;
    if (role === "iframe") {
      kept++;
      const cd = info?.contentDocIndex;
      const doc = cd === undefined ? undefined : dom.documents[cd];
      if (looksLikeCaptcha(doc?.url ?? info?.attrs.src ?? "", name)) captcha = true;
      const child = doc === undefined ? undefined : frameAx.get(doc.frameId);
      if (child !== undefined && doc?.origin === topOrigin) {
        lines.push({
          kind: "node",
          text: `${indent}- iframe${name ? ` "${clip(name, opts.nameMax)}"` : ""}`,
        });
        rawNodes += child.ax.length;
        const childById = new Map(child.ax.map((n) => [n.nodeId, n]));
        visit(child.ax[0], childById, depth + 1, rawDepth + 1, name, false);
      } else {
        const origin = doc?.origin ?? srcOrigin(info?.attrs.src, input.url) ?? "unknown origin";
        lines.push({
          kind: "node",
          text: `${indent}- iframe${name ? ` "${clip(name, opts.nameMax)}"` : ""} (content hidden: ${origin === topOrigin ? "not loaded" : `cross-origin ${origin}`})`,
        });
      }
      return;
    }
    if (isInteractive && CAPTCHA_NAME.test(name)) captcha = true;
    const keep = isInteractive || STRUCTURAL_ROLES.has(role) || role === "rootwebarea";
    if (!keep) {
      walkKids(depth, parentName, suppressText);
      return;
    }
    if (role === "rootwebarea") {
      walkKids(depth, name, false);
      return;
    }
    const { box, offscreen } = boxOf(info);
    if (opts.viewportOnly === true && offscreen && !STRUCTURAL_ROLES.has(role)) return;
    kept++;
    const giveRef =
      node.backendDOMNodeId !== undefined &&
      (isInteractive || role === "heading" || role === "img" || role === "image");
    const shownRole = isInteractive && !INTERACTIVE_ROLES.has(role) ? "clickable" : role;
    let line = `${indent}- ${shownRole}${name ? ` "${clip(name, opts.nameMax)}"` : ""}`;
    const meta = giveRef ? metaOf(info, shownRole, name) : undefined;
    let ref: SnapshotRefEx | undefined;
    if (meta !== undefined && node.backendDOMNodeId !== undefined) {
      const id = input.refs.refFor(node.backendDOMNodeId, meta);
      line += ` [ref=${id}]`;
      ref = { ref: id, role: shownRole, name, interactive: isInteractive };
    }
    if (role === "heading") {
      const level = prop(node, "level");
      if (level !== undefined) line += ` [level=${String(level)}]`;
    }
    const states: string[] = [];
    for (const s of STATES) {
      const v = prop(node, s);
      if (v === true || v === "true") states.push(s);
      else if (v === "mixed") states.push(`${s}=mixed`);
      else if (s === "expanded" && (v === false || v === "false")) states.push("collapsed");
    }
    const secure = meta?.secure ?? (info === undefined ? false : dom.isSecure(info));
    if (secure) states.push("secure");
    for (const s of states) line += ` [${s}]`;
    const rawValue = axString(node.value);
    if (secure) {
      const hasValue = rawValue !== "" || (info?.inputValue ?? "") !== "";
      if (hasValue) line += ` value="${SECURE_MASK}"`;
      if (hasValue || states.includes("focused")) secureFieldActive = true;
      if (ref !== undefined && hasValue) ref.value = SECURE_MASK;
    } else if (rawValue !== "" && rawValue !== name) {
      const value = redact(norm(rawValue));
      line += ` value="${clip(value, opts.valueMax)}"`;
      if (ref !== undefined) ref.value = value;
    }
    if (role === "link" && meta?.href !== undefined) {
      line += ` -> ${clip(shortHref(meta.href, topOrigin), opts.nameMax)}`;
    }
    if (box !== undefined && ref !== undefined) {
      line += ` @${box.x},${box.y} ${box.width}x${box.height}${offscreen ? " offscreen" : ""}`;
      ref.box = box;
      if (offscreen) ref.offscreen = true;
    }
    if (ref !== undefined) {
      if (states.length > 0) ref.states = states;
      refs.push(ref);
    }
    if (isInteractive) interactive++;
    lines.push({ kind: "node", text: line });
    if (secure) return; // never descend into secure fields (spike 04 rule 8)
    walkKids(
      depth + 1,
      name,
      VALUE_ROLES.has(role) || (NAME_FROM_CONTENT.has(role) && name !== ""),
    );
  };

  const byId = new Map(input.ax.map((n) => [n.nodeId, n]));
  const root = input.ax.find((n) => n.parentId === undefined) ?? input.ax[0];
  visit(root, byId, 0, 0, "", false);

  // Interactive first: the refs list leads with interactive elements, and when the text does
  // not fit, static text goes before any interactive or structural line does.
  const ordered = [...refs.filter((r) => r.interactive), ...refs.filter((r) => !r.interactive)];
  const refsOut = ordered.slice(0, opts.maxRefs);
  let body = lines;
  let omittedText: number | undefined;
  if (charCount(body) > opts.maxChars) {
    omittedText = body.filter((l) => l.kind === "text").length;
    body = body.filter((l) => l.kind !== "text");
  }
  const pages = paginate(body, opts.maxChars);
  const pageCount = Math.max(1, pages.length);
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), pageCount);
  const pageLines = pages[page - 1] ?? [];

  const largestOpaque = Math.max(0, ...dom.opaqueAreas);
  const viewportArea = Math.max(1, vp.clientWidth * vp.clientHeight);
  const sparse =
    (kept < 3 && textChars < 100) ||
    (largestOpaque >= viewportArea * 0.25 && interactive < 3 && textChars < 400);

  const flags: string[] = [];
  if (pageCount > 1) flags.push(`page=${page}/${pageCount}`);
  if (omittedText !== undefined) flags.push(`text_omitted=${omittedText} (use read_text)`);
  if (refs.length > refsOut.length) flags.push(`refs_truncated=${refs.length - refsOut.length}`);
  if (depthTruncated) flags.push("TRUNCATED(maxDepth)");
  if (captcha) flags.push("CAPTCHA (never attempted: hand it to the owner)");
  if (sparse) flags.push("SPARSE (tree has little content; a screenshot is suggested)");
  const header = `# ${clip(redactUrl(input.url), 200)} "${clip(redact(norm(input.title)), opts.nameMax)}" refs=${refs.length} interactive=${interactive}${flags.length > 0 ? ` ${flags.join(" ")}` : ""}`;
  const text = [header, ...pageLines.map((l) => l.text)].join("\n");
  const buildMs = performance.now() - t0;

  const snap: BrowserSnapshot = {
    url: input.url,
    title: input.title,
    refs: refsOut,
    text,
    page,
    pages: pageCount,
    secureFieldActive,
    stats: {
      rawNodes,
      keptNodes: kept,
      interactive,
      chars: text.length,
      approxTokens: Math.round(text.length / 4),
      fetchMs: input.fetchMs ?? 0,
      buildMs,
    },
  };
  if (refs.length > refsOut.length || pageCount > 1 || omittedText !== undefined) {
    snap.truncated = true;
  }
  if (omittedText !== undefined) snap.omittedText = omittedText;
  if (sparse) snap.sparse = true;
  if (captcha) snap.captcha = true;
  return snap;
}

function srcOrigin(src: string | undefined, base: string): string | undefined {
  if (src === undefined) return undefined;
  try {
    return tryOrigin(new URL(src, base).href);
  } catch {
    return undefined;
  }
}

function descendantText(
  node: AXNode,
  byId: Map<string, AXNode>,
): { text: string; hasInteractive: boolean } {
  let text = "";
  let hasInteractive = false;
  let visited = 0;
  const walk = (n: AXNode | undefined) => {
    if (n === undefined || visited++ > 200 || text.length > 400) return;
    const r = roleOf(n);
    if (INTERACTIVE_ROLES.has(r)) hasInteractive = true;
    if (r === "statictext") text += ` ${axString(n.name)}`;
    for (const id of n.childIds ?? []) walk(byId.get(id));
  };
  for (const id of node.childIds ?? []) walk(byId.get(id));
  return { text: norm(text), hasInteractive };
}

function shortHref(href: string, topOrigin: string): string {
  try {
    const u = new URL(href);
    if (u.origin === topOrigin) return `${u.pathname}${u.search}`;
    return u.href;
  } catch {
    return href;
  }
}

function charCount(lines: Line[]): number {
  let n = 0;
  for (const l of lines) n += l.text.length + 1;
  return n;
}

function paginate(lines: Line[], maxChars: number): Line[][] {
  const pages: Line[][] = [];
  let cur: Line[] = [];
  let size = 0;
  for (const l of lines) {
    const len = l.text.length + 1;
    if (cur.length > 0 && size + len > maxChars) {
      pages.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += len;
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Visible text of the page from the AX tree (no page JavaScript): StaticText in document order,
 * one line per block. Secure fields contribute nothing.
 */
export function extractText(
  ax: AXNode[],
  options: { maxChars?: number; redact?: (s: string) => string; frames?: FrameAx[] } = {},
): { text: string; truncated: boolean } {
  const redact = options.redact ?? ((s: string) => s);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    const t = norm(cur);
    if (t !== "") out.push(t);
    cur = "";
  };
  const visitTree = (nodes: AXNode[]) => {
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const visit = (node: AXNode | undefined, depth: number) => {
      if (node === undefined || depth > 200) return;
      const role = roleOf(node);
      if (role === "statictext") {
        cur += ` ${axString(node.name)}`;
        return;
      }
      // Field values are not page text (and secure ones must never surface).
      if (VALUE_ROLES.has(role)) return;
      const block = BLOCK_ROLES.has(role);
      if (block) flush();
      for (const id of node.childIds ?? []) visit(byId.get(id), depth + 1);
      if (block) flush();
    };
    visit(nodes.find((n) => n.parentId === undefined) ?? nodes[0], 0);
    flush();
  };
  visitTree(ax);
  for (const f of options.frames ?? []) visitTree(f.ax);
  const text = redact(out.join("\n"));
  const max = options.maxChars ?? 20_000;
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}
