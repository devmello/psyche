import {
  BREAKPOINT_MEDIUM,
  BREAKPOINT_WIDE,
  BREAKPOINT_XWIDE,
  breakpointFor,
  CHAT_MIN_PX,
  CHAT_PANE_ID,
  DEFAULT_CHAT_FRACTION,
  findPane,
  groupOf,
  isPaneKind,
  type LayoutAction,
  type LayoutEnv,
  type LayoutState,
  MAX_GROUPS,
  maxGroupsFor,
  PANE_MIN_PX,
  type PaneGroup,
  type PaneInstance,
  type PaneKind,
  type Presentation,
  type PresentedGroup,
} from "./model.ts";

/** What an action did: the new state, and the pane it acted on (null = chat or nothing). */
export interface LayoutOutcome {
  state: LayoutState;
  paneId: string | null;
  changed: boolean;
}

/** Width inputs for fitting; `LayoutEnv` satisfies it. */
export interface LayoutWidth {
  width: number;
  contentWidth?: number;
}

/** Pure reducer: never mutates `state`; returns `state` itself when nothing changed. */
export function reduceLayout(
  state: LayoutState,
  action: LayoutAction,
  env: LayoutEnv,
): LayoutState {
  return applyLayoutAction(state, action, env).state;
}

/** `reduceLayout` plus the pane the action resolved to (used by `view.*` handling). */
export function applyLayoutAction(
  state: LayoutState,
  action: LayoutAction,
  env: LayoutEnv,
): LayoutOutcome {
  const draft = structuredClone(state);
  const paneId = run(draft, action, env);
  const next = normalizeLayout(draft, env);
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  return { state: changed ? next : state, paneId, changed };
}

// --- Actions (mutate the draft) -------------------------------------------------------------------

function run(s: LayoutState, action: LayoutAction, env: LayoutEnv): string | null {
  switch (action.type) {
    case "open":
      return open(s, action, env);
    case "close": {
      const pane = resolve(s, action.paneId, action.pane);
      if (pane === undefined) return null;
      closePane(s, pane.paneId);
      return pane.paneId;
    }
    case "focus": {
      if (action.paneId === null || action.paneId === CHAT_PANE_ID || action.pane === "chat") {
        s.focusedPaneId = null;
        return null;
      }
      const pane = resolve(s, action.paneId, action.pane);
      if (pane === undefined) return null;
      reveal(s, pane.paneId, true);
      return pane.paneId;
    }
    case "activateTab":
      if (groupOf(s, action.paneId) === undefined) return null;
      reveal(s, action.paneId, true);
      return action.paneId;
    case "split":
      return split(s, action.paneId, env);
    case "moveToGroup":
      return moveToGroup(s, action.paneId, action.groupId, action.index, env);
    case "resize":
      resize(s, action.boundary, action.delta, env);
      return null;
    case "popOut": {
      if (groupOf(s, action.paneId) === undefined) return null;
      undock(s, action.paneId);
      s.popped.push(action.paneId);
      return action.paneId;
    }
    case "popIn": {
      if (!s.popped.includes(action.paneId)) return null;
      s.popped = s.popped.filter((id) => id !== action.paneId);
      const index = s.groups.findIndex((g) => g.groupId === action.groupId);
      dock(s, action.paneId, index >= 0 ? index : 0, undefined, env);
      s.focusedPaneId = action.paneId;
      return action.paneId;
    }
    case "closeFocused": {
      const id = s.focusedPaneId;
      if (id === null || groupOf(s, id) === undefined) return null;
      closePane(s, id);
      return id;
    }
    case "setTitle": {
      const pane = findPane(s, action.paneId);
      if (pane === undefined) return null;
      pane.title = action.title;
      return pane.paneId;
    }
    case "fitToWidth":
      return null;
  }
}

function resolve(
  s: LayoutState,
  paneId: string | null | undefined,
  kind: string | undefined,
): PaneInstance | undefined {
  if (paneId !== undefined && paneId !== null) return findPane(s, paneId);
  if (kind === undefined || kind === "chat") return undefined;
  return s.panes.findLast((p) => p.pane === kind);
}

function open(
  s: LayoutState,
  action: Extract<LayoutAction, { type: "open" }>,
  env: LayoutEnv,
): string | null {
  const focus = action.focus ?? true;
  if (!isPaneKind(action.pane)) {
    if (focus) s.focusedPaneId = null;
    return null;
  }
  const kind: PaneKind = action.pane;
  const target = action.target ?? (kind === "artifact" ? (action.artifactId ?? null) : null);
  const callerId =
    action.paneId !== undefined && action.paneId !== "" && action.paneId !== CHAT_PANE_ID
      ? action.paneId
      : undefined;

  const existing =
    callerId !== undefined
      ? findPane(s, callerId)
      : s.panes.findLast((p) => p.pane === kind && p.target === target);
  if (existing !== undefined) {
    if (action.title !== undefined) existing.title = action.title;
    if (action.taskId !== undefined) existing.taskId = action.taskId;
    if (action.artifactId !== undefined) existing.artifactId = action.artifactId;
    if (groupOf(s, existing.paneId) !== undefined) reveal(s, existing.paneId, focus);
    return existing.paneId;
  }

  const paneId = callerId ?? uniqueId(s, `p_${kind}_`, env);
  const pane: PaneInstance = {
    paneId,
    pane: kind,
    target,
    threadId: action.threadId ?? s.threadId,
    openerPaneId: action.openerPaneId !== undefined ? action.openerPaneId : s.focusedPaneId,
    createdAt: env.now(),
  };
  if (action.taskId !== undefined) pane.taskId = action.taskId;
  if (action.artifactId !== undefined) pane.artifactId = action.artifactId;
  if (action.title !== undefined) pane.title = action.title;
  s.panes.push(pane);

  const focusedGroup = focusedGroupIndex(s);
  const canSplit = s.groups.length < maxGroupsFor(env.width, contentWidthOf(env));
  if (action.placement === "split" && canSplit) {
    const after = focusedGroup >= 0 ? focusedGroup : s.groups.length - 1;
    insertGroup(s, after + 1, paneId, env);
  } else if (action.placement === "side" || action.placement === "main") {
    dock(s, paneId, 0, undefined, env);
  } else {
    dock(s, paneId, focusedGroup >= 0 ? focusedGroup : 0, undefined, env);
  }
  if (focus) s.focusedPaneId = paneId;
  return paneId;
}

function split(s: LayoutState, paneId: string, env: LayoutEnv): string | null {
  const from = s.groups.findIndex((g) => g.paneIds.includes(paneId));
  const group = s.groups[from];
  if (group === undefined || group.paneIds.length < 2) return null;
  if (s.groups.length >= maxGroupsFor(env.width, contentWidthOf(env))) return null;
  removeTab(group, paneId, s);
  insertGroup(s, from + 1, paneId, env);
  s.focusedPaneId = paneId;
  return paneId;
}

function moveToGroup(
  s: LayoutState,
  paneId: string,
  groupId: string,
  index: number | undefined,
  env: LayoutEnv,
): string | null {
  const target = s.groups.find((g) => g.groupId === groupId);
  if (target === undefined || findPane(s, paneId) === undefined) return null;
  if (s.popped.includes(paneId)) {
    s.popped = s.popped.filter((id) => id !== paneId);
  } else {
    const source = groupOf(s, paneId);
    if (source === undefined) return null;
    if (source === target) {
      target.paneIds = target.paneIds.filter((id) => id !== paneId);
    } else {
      removeTab(source, paneId, s);
      dropEmptyGroups(s);
    }
  }
  dock(s, paneId, s.groups.indexOf(target), index, env);
  s.focusedPaneId = paneId;
  return paneId;
}

function resize(s: LayoutState, boundary: number, delta: number, env: LayoutEnv): void {
  if (!Number.isFinite(delta) || delta === 0 || s.groups.length === 0) return;
  if (env.width < BREAKPOINT_WIDE) return; // panes are not beside the chat
  const cw = contentWidthOf(env);
  if (boundary === 0) {
    const [lo, hi] = chatBounds(cw, s.groups.length);
    s.chatFraction = clamp(s.chatFraction + delta / cw, lo, hi);
    return;
  }
  const left = s.sizes[boundary - 1];
  const right = s.sizes[boundary];
  if (left === undefined || right === undefined) return;
  const area = cw * (1 - s.chatFraction);
  const min = Math.min(PANE_MIN_PX / area, (left + right) / 2);
  const nextLeft = clamp(left + delta / area, min, left + right - min);
  s.sizes[boundary - 1] = nextLeft;
  s.sizes[boundary] = left + right - nextLeft;
}

// --- Primitives -----------------------------------------------------------------------------------

/** Activates a docked pane's tab and optionally focuses it. */
function reveal(s: LayoutState, paneId: string, focus: boolean): void {
  const group = groupOf(s, paneId);
  if (group === undefined) return;
  group.activePaneId = paneId;
  if (focus) s.focusedPaneId = paneId;
}

/** Adds a pane as the active tab of group `groupIndex` (creating the first group if none). */
function dock(
  s: LayoutState,
  paneId: string,
  groupIndex: number,
  index: number | undefined,
  env: LayoutEnv,
): void {
  const group = s.groups[groupIndex] ?? s.groups[0];
  if (group === undefined) {
    insertGroup(s, 0, paneId, env);
    return;
  }
  const at = index === undefined ? group.paneIds.length : clamp(index, 0, group.paneIds.length);
  group.paneIds.splice(at, 0, paneId);
  group.activePaneId = paneId;
}

function insertGroup(s: LayoutState, at: number, paneId: string, env: LayoutEnv): void {
  const group: PaneGroup = {
    groupId: uniqueId(s, "g_", env),
    paneIds: [paneId],
    activePaneId: paneId,
  };
  const index = clamp(at, 0, s.groups.length);
  if (s.groups.length === 0) {
    s.groups = [group];
    s.sizes = [1];
    return;
  }
  // The new group takes half of the group it splits from.
  const donor = Math.max(0, index - 1);
  const share = (s.sizes[donor] ?? 1 / s.groups.length) / 2;
  s.sizes[donor] = share;
  s.groups.splice(index, 0, group);
  s.sizes.splice(index, 0, share);
}

/** Removes a tab; the group's next active tab is the closed pane's opener if here, else a neighbour. */
function removeTab(group: PaneGroup, paneId: string, s: LayoutState): void {
  const at = group.paneIds.indexOf(paneId);
  if (at < 0) return;
  group.paneIds.splice(at, 1);
  if (group.activePaneId !== paneId) return;
  const opener = findPane(s, paneId)?.openerPaneId ?? null;
  const next =
    opener !== null && group.paneIds.includes(opener)
      ? opener
      : (group.paneIds[at] ?? group.paneIds[at - 1]);
  if (next !== undefined) group.activePaneId = next;
}

/** Drops empty groups, handing each one's share to its left neighbour (else its right). */
function dropEmptyGroups(s: LayoutState): void {
  for (let i = s.groups.length - 1; i >= 0; i--) {
    if ((s.groups[i]?.paneIds.length ?? 0) > 0) continue;
    const share = s.sizes[i] ?? 0;
    s.groups.splice(i, 1);
    s.sizes.splice(i, 1);
    const heir = i > 0 ? i - 1 : 0;
    const current = s.sizes[heir];
    if (current !== undefined) s.sizes[heir] = current + share;
  }
}

/**
 * Takes a docked pane out of its group. When it had focus, focus returns to its opener if that is
 * still docked (a null opener is the chat), else to the neighbour tab, else the adjacent group's
 * active pane, else the chat (docs/06 §4.11).
 */
function undock(s: LayoutState, paneId: string): void {
  const from = s.groups.findIndex((g) => g.paneIds.includes(paneId));
  const group = s.groups[from];
  if (group === undefined) return;
  const wasFocused = s.focusedPaneId === paneId;
  removeTab(group, paneId, s);
  const groupGone = group.paneIds.length === 0;
  dropEmptyGroups(s);
  if (!wasFocused) return;
  const opener = findPane(s, paneId)?.openerPaneId ?? null;
  if (opener === null) {
    s.focusedPaneId = null;
    return;
  }
  if (opener !== paneId && groupOf(s, opener) !== undefined) {
    reveal(s, opener, true);
    return;
  }
  const neighbour = groupGone
    ? (s.groups[from - 1] ?? s.groups[from])?.activePaneId
    : group.activePaneId;
  s.focusedPaneId = neighbour ?? null;
}

function closePane(s: LayoutState, paneId: string): void {
  undock(s, paneId);
  s.popped = s.popped.filter((id) => id !== paneId);
  s.panes = s.panes.filter((p) => p.paneId !== paneId);
}

function focusedGroupIndex(s: LayoutState): number {
  const id = s.focusedPaneId;
  return id === null ? -1 : s.groups.findIndex((g) => g.paneIds.includes(id));
}

function uniqueId(s: LayoutState, prefix: string, env: LayoutEnv): string {
  const taken = new Set<string>([
    CHAT_PANE_ID,
    ...s.panes.map((p) => p.paneId),
    ...s.groups.map((g) => g.groupId),
  ]);
  for (let i = 0; i < 1000; i++) {
    const id = `${prefix}${env.newId()}`;
    if (!taken.has(id)) return id;
  }
  let n = taken.size;
  while (taken.has(`${prefix}x${n}`)) n++;
  return `${prefix}x${n}`;
}

// --- Normalization and fitting --------------------------------------------------------------------

function contentWidthOf(env: LayoutWidth): number {
  const cw = env.contentWidth ?? env.width;
  return Number.isFinite(cw) && cw > 0 ? cw : env.width;
}

/**
 * Width in CSS px of the docked pane column beside the chat: the pane share of the content area
 * (window minus sidebar), never less than one pane minimum and never so wide that the chat column
 * drops under its minimum. A saved fraction measured on a wider window is clamped here, so a pane
 * header always fits its column.
 */
export function paneColumnWidth(chatFraction: number, contentWidth: number): number {
  const cw = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 0;
  const fraction =
    Number.isFinite(chatFraction) && chatFraction > 0 && chatFraction < 1
      ? chatFraction
      : DEFAULT_CHAT_FRACTION;
  const lo = Math.min(PANE_MIN_PX, cw);
  const hi = Math.max(lo, cw - CHAT_MIN_PX);
  return Math.round(clamp((1 - fraction) * cw, lo, hi));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** [min, max] chat fraction so chat ≥ 480 px and every group ≥ 360 px (proportional if impossible). */
function chatBounds(cw: number, groups: number): [number, number] {
  const lo = CHAT_MIN_PX / cw;
  const hi = 1 - (groups * PANE_MIN_PX) / cw;
  if (lo > hi) {
    const f = CHAT_MIN_PX / (CHAT_MIN_PX + groups * PANE_MIN_PX);
    return [f, f];
  }
  return [lo, hi];
}

/** Normalizes fractions to sum 1 with each ≥ `min` (equal shares when that is impossible). */
export function clampSizes(sizes: readonly number[], min: number): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  const cleaned = sizes.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = cleaned.reduce((a, b) => a + b, 0);
  if (total <= 0 || !(min * n < 1)) return finish(Array.from({ length: n }, () => 1 / n));
  let out = cleaned.map((x) => x / total);
  const locked = new Set<number>();
  for (let iter = 0; iter < n; iter++) {
    const low = out.flatMap((x, i) => (!locked.has(i) && x < min - 1e-9 ? [i] : []));
    if (low.length === 0) break;
    for (const i of low) locked.add(i);
    const free = out.reduce((a, x, i) => (locked.has(i) ? a : a + x), 0);
    const room = 1 - locked.size * min;
    out = out.map((x, i) => (locked.has(i) ? min : free > 0 ? (x / free) * room : room));
  }
  return finish(out);
}

function finish(sizes: number[]): number[] {
  const rounded = sizes.map(round);
  const head = rounded.slice(0, -1).reduce((a, b) => a + b, 0);
  rounded[rounded.length - 1] = round(1 - head);
  return rounded;
}

function freshGroupId(taken: Set<string>, base: string): string {
  let id = base;
  while (taken.has(id)) id = `${id}_`;
  taken.add(id);
  return id;
}

/**
 * Repairs invariants and fits the layout to a width: unique panes, every docked pane in exactly
 * one non-empty group, valid active tabs and focus, sizes summing to 1, at most
 * `maxGroupsFor(width)` groups (extra groups merge into the last kept one, order preserved), and,
 * where panes sit beside the chat (≥ 1080 px), the 480 / 360 px minimums.
 */
export function normalizeLayout(state: LayoutState, env: LayoutWidth): LayoutState {
  const s = structuredClone(state);
  const seen = new Set<string>();
  s.panes = s.panes.filter((p) => {
    if (p.paneId === CHAT_PANE_ID || seen.has(p.paneId) || !isPaneKind(p.pane)) return false;
    seen.add(p.paneId);
    return true;
  });
  s.popped = [...new Set(s.popped)].filter((id) => seen.has(id));
  const placed = new Set<string>(s.popped);
  const groupIds = new Set<string>();
  const sizes: number[] = [];
  const groups: PaneGroup[] = [];
  s.groups.forEach((g, i) => {
    const paneIds = g.paneIds.filter((id) => {
      if (!seen.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
    const first = paneIds[0];
    if (first === undefined) return;
    groups.push({
      groupId: freshGroupId(groupIds, g.groupId),
      paneIds,
      activePaneId: paneIds.includes(g.activePaneId) ? g.activePaneId : first,
    });
    sizes.push(s.sizes[i] ?? 0);
  });
  // Orphans (neither docked nor popped) join the last group.
  const orphans = s.panes.map((p) => p.paneId).filter((id) => !placed.has(id));
  const firstOrphan = orphans[0];
  if (firstOrphan !== undefined) {
    const last = groups.at(-1);
    if (last === undefined) {
      groups.push({
        groupId: freshGroupId(groupIds, "g_0"),
        paneIds: orphans,
        activePaneId: firstOrphan,
      });
      sizes.push(1);
    } else {
      last.paneIds.push(...orphans);
    }
  }
  s.groups = groups;
  s.sizes = sizes;

  const focused = s.focusedPaneId;
  if (focused !== null && !groups.some((g) => g.paneIds.includes(focused))) {
    s.focusedPaneId = null;
  }
  if (!Number.isFinite(s.chatFraction) || s.chatFraction <= 0 || s.chatFraction >= 1) {
    s.chatFraction = DEFAULT_CHAT_FRACTION;
  }

  const cw = contentWidthOf(env);
  mergeBeyond(s, maxGroupsFor(env.width, cw));

  if (env.width >= BREAKPOINT_WIDE && s.groups.length > 0) {
    const [lo, hi] = chatBounds(cw, s.groups.length);
    s.chatFraction = round(clamp(s.chatFraction, lo, hi));
    const area = cw * (1 - s.chatFraction);
    s.sizes = clampSizes(s.sizes, PANE_MIN_PX / area);
  } else {
    s.sizes = clampSizes(s.sizes, 0);
  }
  return s;
}

/** Merges groups past `max` into the last kept group, preserving tab order. */
function mergeBeyond(s: LayoutState, max: number): void {
  const keep = Math.max(1, max);
  const first = s.groups[keep - 1];
  if (s.groups.length <= keep || first === undefined) return;
  const merged = s.groups.slice(keep - 1);
  const paneIds = merged.flatMap((g) => g.paneIds);
  const focused = s.focusedPaneId;
  const active = focused !== null && paneIds.includes(focused) ? focused : first.activePaneId;
  const share = s.sizes.slice(keep - 1).reduce((a, b) => a + b, 0);
  s.groups = [
    ...s.groups.slice(0, keep - 1),
    { groupId: first.groupId, paneIds, activePaneId: active },
  ];
  s.sizes = [...s.sizes.slice(0, keep - 1), share];
}

// --- Presentation ---------------------------------------------------------------------------------

/**
 * What to draw at `width`: compact (< 720: chat or one pane full screen), single (one tab strip;
 * below the chat at 720–1079, beside it from 1080) or double (two groups side by side, ≥ 1440).
 * Works on layouts not yet fitted to `width` (groups are merged on the fly).
 */
export function presentation(state: LayoutState, width: number): Presentation {
  const breakpoint = breakpointFor(width);
  const docked = state.groups.filter((g) => g.paneIds.length > 0);
  const focused = state.focusedPaneId;
  const focusedDocked =
    focused !== null && docked.some((g) => g.paneIds.includes(focused)) ? focused : null;
  const total = state.sizes.reduce((a, b) => a + b, 0);
  const firstSize = total > 0 ? (state.sizes[0] ?? 0) / total : 1 / Math.max(1, docked.length);

  const first = docked[0];
  const second = docked[1];
  let groups: PresentedGroup[] = [];
  let twoUp = false;
  if (first !== undefined && second !== undefined && width >= BREAKPOINT_XWIDE) {
    twoUp = docked.length >= MAX_GROUPS;
    const restIds = docked.slice(1).flatMap((g) => g.paneIds);
    groups = [
      { ...first, paneIds: [...first.paneIds], size: firstSize },
      {
        groupId: second.groupId,
        paneIds: restIds,
        activePaneId:
          focusedDocked !== null && restIds.includes(focusedDocked)
            ? focusedDocked
            : second.activePaneId,
        size: round(1 - firstSize),
      },
    ];
  } else if (first !== undefined) {
    const paneIds = docked.flatMap((g) => g.paneIds);
    const active = docked.length > 1 ? (focusedDocked ?? first.activePaneId) : first.activePaneId;
    groups = [{ groupId: first.groupId, paneIds, activePaneId: active, size: 1 }];
  }
  const visiblePaneIds = groups.map((g) => g.activePaneId);
  const base = {
    breakpoint,
    groups,
    chatFraction: state.chatFraction,
    popped: [...state.popped],
  };
  if (width < BREAKPOINT_MEDIUM) {
    return {
      ...base,
      mode: "compact",
      visiblePaneIds: focusedDocked === null ? [] : [focusedDocked],
      visiblePaneId: focusedDocked,
      chatVisible: focusedDocked === null,
    };
  }
  const visiblePaneId =
    focusedDocked !== null && visiblePaneIds.includes(focusedDocked)
      ? focusedDocked
      : (visiblePaneIds[0] ?? null);
  return {
    ...base,
    mode: twoUp ? "double" : "single",
    visiblePaneIds,
    visiblePaneId,
    chatVisible: true,
  };
}
