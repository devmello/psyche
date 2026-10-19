// Pruned accessibility snapshot with stable refs and bounding boxes, built from raw CDP
// (Accessibility.getFullAXTree + DOMSnapshot.captureSnapshot) on the client side of the bridge.

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem',
  'textField', 'TextField', 'PopUpButton', 'DisclosureTriangle',
]);
const STRUCTURAL = new Set([
  'heading', 'img', 'image', 'main', 'navigation', 'banner', 'contentinfo', 'form', 'search', 'dialog',
  'alertdialog', 'alert', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'list', 'listitem',
  'region', 'article', 'complementary', 'figure', 'tablist', 'menu', 'menubar', 'toolbar', 'status', 'tree',
]);
const DROP = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
const STATES = ['focused', 'checked', 'pressed', 'disabled', 'expanded', 'selected', 'required', 'readonly'];

/** Per-tab map of backendDOMNodeId -> ref_N. Refs survive re-snapshots of the same document. */
export class RefRegistry {
  constructor() { this.byBackend = new Map(); this.byRef = new Map(); this.next = 1; this.documentKey = null; }
  reset(documentKey) { this.byBackend.clear(); this.byRef.clear(); this.next = 1; this.documentKey = documentKey; }
  refFor(backendId) {
    let r = this.byBackend.get(backendId);
    if (!r) { r = `ref_${this.next++}`; this.byBackend.set(backendId, r); this.byRef.set(r, backendId); }
    return r;
  }
  backend(ref) { return this.byRef.get(ref); }
}

function prop(node, name) {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

// DOMSnapshot layout bounds are in device pixels (2x on Retina); refs carry CSS pixels.
function boundsMap(snap, dpr) {
  const map = new Map();
  const doc = snap.documents[0];
  if (!doc) return map;
  const { nodeIndex, bounds } = doc.layout;
  const backendIds = doc.nodes.backendNodeId;
  for (let i = 0; i < nodeIndex.length; i++) map.set(backendIds[nodeIndex[i]], bounds[i].map((v) => v / dpr));
  return map;
}

/**
 * @param {import('./bridge-client.mjs').BridgeClient} bridge
 * @param {string} tabId
 * @param {RefRegistry} refs
 */
export async function takeSnapshot(bridge, tabId, refs) {
  const t0 = performance.now();
  const timed = (p) => { const s = performance.now(); return p.then((r) => ({ r, ms: performance.now() - s })); };
  // Pipelined over the bridge: three commands in flight at once.
  const [ax, dom, lm, doc] = await Promise.all([
    timed(bridge.send(tabId, 'Accessibility.getFullAXTree', {})),
    timed(bridge.send(tabId, 'DOMSnapshot.captureSnapshot', { computedStyles: [] })),
    timed(bridge.send(tabId, 'Page.getLayoutMetrics', {})),
    timed(bridge.send(tabId, 'Runtime.evaluate', { expression: '[location.href, devicePixelRatio]', returnByValue: true })),
  ]);
  const tFetched = performance.now();
  const [url, dpr] = doc.r.result.value;
  const docKey = `${url}#${dom.r.documents[0]?.documentURL ?? ''}#${ax.r.nodes[0]?.backendDOMNodeId}`;
  if (refs.documentKey !== docKey) refs.reset(docKey);

  const nodes = ax.r.nodes;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const boxes = boundsMap(dom.r, dpr);
  const vp = lm.r.cssVisualViewport ?? lm.r.visualViewport;
  const lines = [];
  const out = [];
  let interactive = 0;

  const visit = (node, depth, parentName) => {
    if (!node) return;
    const role = node.role?.value ?? '';
    const name = (node.name?.value ?? '').replace(/\s+/g, ' ').trim();
    const kids = (node.childIds ?? []).map((id) => byId.get(id));
    if (node.ignored || DROP.has(role)) { for (const k of kids) visit(k, depth, parentName); return; }
    if (role === 'StaticText') {
      if (name && name !== parentName && !parentName.includes(name)) lines.push(`${'  '.repeat(depth)}- text "${clip(name, 100)}"`);
      return;
    }
    const isInteractive = INTERACTIVE.has(role);
    const keep = isInteractive || STRUCTURAL.has(role) || role === 'RootWebArea';
    if (!keep) { for (const k of kids) visit(k, depth, parentName); return; }

    const entry = { role, name };
    let line = `${'  '.repeat(depth)}- ${role}${name ? ` "${clip(name, 80)}"` : ''}`;
    if (node.backendDOMNodeId && (isInteractive || role === 'heading' || role === 'img' || role === 'image')) {
      entry.ref = refs.refFor(node.backendDOMNodeId);
      line += ` [ref=${entry.ref}]`;
    }
    if (role === 'heading') line += ` [level=${prop(node, 'level')}]`;
    for (const s of STATES) { const v = prop(node, s); if (v === true || v === 'true' || v === 'mixed') line += ` [${s}${v === 'mixed' ? '=mixed' : ''}]`; }
    const value = node.value?.value;
    if (value != null && value !== '' && value !== name) line += ` value="${clip(String(value), 60)}"`;
    const b = boxes.get(node.backendDOMNodeId);
    if (b && entry.ref) {
      entry.box = { x: Math.round(b[0]), y: Math.round(b[1]), w: Math.round(b[2]), h: Math.round(b[3]) };
      const inView = vp && b[1] + b[3] > vp.pageY && b[1] < vp.pageY + vp.clientHeight && b[2] > 0 && b[3] > 0;
      line += ` @${entry.box.x},${entry.box.y},${entry.box.w}x${entry.box.h}${inView ? '' : ' offscreen'}`;
    }
    if (isInteractive) interactive++;
    lines.push(line);
    out.push(entry);
    for (const k of kids) visit(k, depth + 1, name);
  };
  visit(nodes[0], 0, '');
  const text = lines.join('\n');
  const tBuilt = performance.now();
  return {
    url, text, entries: out,
    stats: {
      rawNodes: nodes.length,
      keptNodes: out.length,
      interactive,
      refs: refs.byRef.size,
      axBytes: JSON.stringify(ax.r).length,
      domSnapshotBytes: JSON.stringify(dom.r).length,
      snapshotChars: text.length,
      approxTokens: Math.round(text.length / 4),
      axMs: ax.ms, domSnapshotMs: dom.ms, layoutMs: lm.ms,
      fetchMs: tFetched - t0, buildMs: tBuilt - tFetched, totalMs: tBuilt - t0,
    },
  };
}

function clip(s, n) { return (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/"/g, '\\"'); }

/** Find the first entry whose role matches and whose name includes `name` (case-insensitive). */
export function findRef(snapshot, role, name) {
  const want = name.toLowerCase();
  return snapshot.entries.find((e) => e.ref && (role == null || e.role === role) && e.name.toLowerCase().includes(want))?.ref;
}

/** Scroll the ref into view and return the viewport-relative centre of its first content quad. */
export async function centerOf(bridge, tabId, refs, ref) {
  const backendNodeId = refs.backend(ref);
  if (!backendNodeId) throw new Error(`unknown ${ref}`);
  await bridge.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const { quads } = await bridge.send(tabId, 'DOM.getContentQuads', { backendNodeId });
  if (!quads?.length) throw new Error(`${ref} has no layout`);
  const q = quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

export async function clickRef(bridge, tabId, refs, ref) {
  const { x, y } = await centerOf(bridge, tabId, refs, ref);
  await bridge.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await bridge.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await bridge.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { x, y };
}

export async function typeRef(bridge, tabId, refs, ref, text) {
  const backendNodeId = refs.backend(ref);
  await bridge.send(tabId, 'DOM.focus', { backendNodeId });
  await bridge.send(tabId, 'Input.insertText', { text });
}
