import type { CredentialBroker, FillElement, ResolvedSecret } from "@psyche/protocol";
import { canonicalOrigin } from "../binding.ts";
import { fail, reasonOf } from "../errors.ts";

/** The CDP calls this routine makes; S08's `webContents.debugger` bridge satisfies it. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface BrowserFillInput {
  cdp: CdpSession;
  broker: CredentialBroker;
  /** `{{cred:<slug>[.field]}}` exactly as the agent wrote it. */
  placeholder: string;
  approvalId: string;
  /** The approved `ref_N`; part of the binding hash. */
  selector: string;
  /** The approved element's backend node id; the focused element must be this node. */
  backendNodeId?: number;
  /** Take control is active (the user is typing): never fill (security §4.6). */
  takeControlActive?: boolean;
  taskId?: string;
  /** `Input.dispatchKeyEvent` modifier for select-all: 4 (Meta) on macOS, 2 (Ctrl) elsewhere. */
  selectAllModifier?: number;
}

export interface BrowserFillResult {
  ok: boolean;
  /** Always true once a value may be in the field: screenshots are suppressed (G6). */
  secureField: boolean;
  origin: string | null;
  /** Machine-readable denial or failure reason; never a value. */
  reason?: string;
}

/** Runs in an isolated world on the focused element: what the broker needs to check it. */
const DESCRIBE = `function () {
  const el = this;
  const form = el.form || (el.closest && el.closest("form"));
  let action;
  if (form) {
    // The form's action and every submitter's formaction must agree, or the check fails.
    const targets = [form.getAttribute("action") || ""];
    for (const b of form.querySelectorAll("button, input[type=submit], input[type=image]")) {
      if (b.hasAttribute("formaction")) targets.push(b.getAttribute("formaction") || "");
    }
    const origins = new Set(targets.map((t) => { try { return new URL(t, document.baseURI).origin; } catch (e) { return "null"; } }));
    action = origins.size === 1 ? [...origins][0] : "null";
  }
  const out = {
    tagName: String(el.tagName || "").toLowerCase(),
    type: typeof el.type === "string" ? el.type.toLowerCase() : undefined,
    autocomplete: el.getAttribute ? (el.getAttribute("autocomplete") || "").toLowerCase() : "",
    inputMode: el.inputMode || undefined,
    role: el.getAttribute ? el.getAttribute("role") || undefined : undefined,
    contentEditable: el.isContentEditable === true,
    frameOrigin: location.origin,
    formHasPassword: form ? !!form.querySelector("input[type=password]") : false,
    maxLength: typeof el.maxLength === "number" && el.maxLength > 0 ? el.maxLength : undefined,
    fieldName: String((el.getAttribute && (el.getAttribute("name") || el.id)) || "").toLowerCase().slice(0, 64) || undefined,
  };
  if (action !== undefined) out.formActionOrigin = action;
  return out;
}`;

const VALUE_LENGTH = `function () {
  return document.activeElement === this && typeof this.value === "string" ? [...this.value].length : -1;
}`;

const CLEAR = `function () {
  if (typeof this.value === "string") { this.value = ""; this.dispatchEvent(new Event("input", { bubbles: true })); }
}`;

interface FrameTree {
  frameTree?: { frame?: { id?: string; url?: string; securityOrigin?: string } };
}

/** What a fill needs from the page, shared by placeholder fills and Link card fills. */
export interface FocusedFillOptions {
  cdp: CdpSession;
  backendNodeId?: number;
  takeControlActive?: boolean;
  selectAllModifier?: number;
}

/** The focused element as described in the isolated world, plus its `name` / `id` (lowercased). */
export type FocusedElement = FillElement & { fieldName?: string };

/**
 * Shared fill core: find the top frame's origin and the focused element (isolated world), let
 * `authorize` decide and hand back a one-shot handle, re-check origin and focus, type with
 * `Input.insertText`, verify, and clear on failure.
 */
export async function fillFocused(
  opts: FocusedFillOptions,
  authorize: (origin: string, element: FocusedElement) => Promise<ResolvedSecret>,
): Promise<BrowserFillResult> {
  const { cdp } = opts;
  if (opts.takeControlActive === true) {
    return { ok: false, secureField: false, origin: null, reason: "take_control_active" };
  }
  const tree = (await cdp.send("Page.getFrameTree")) as FrameTree;
  const frame = tree.frameTree?.frame;
  const origin = canonicalOrigin(frame?.securityOrigin ?? frame?.url ?? "");
  if (origin === null || frame?.id === undefined) {
    return { ok: false, secureField: false, origin: null, reason: "opaque_origin" };
  }
  const world = (await cdp.send("Page.createIsolatedWorld", {
    frameId: frame.id,
    worldName: "psyche-fill",
    grantUniveralAccess: false,
  })) as { executionContextId: number };
  const active = (await cdp.send("Runtime.evaluate", {
    expression: "document.activeElement",
    contextId: world.executionContextId,
    returnByValue: false,
  })) as { result?: { objectId?: string; subtype?: string } };
  const objectId = active.result?.objectId;
  if (objectId === undefined) {
    return { ok: false, secureField: false, origin, reason: "no_focused_element" };
  }
  try {
    if (opts.backendNodeId !== undefined) {
      const desc = (await cdp.send("DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      if (desc.node?.backendNodeId !== opts.backendNodeId) {
        return { ok: false, secureField: false, origin, reason: "focus_moved" };
      }
    }
    const described = (await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: DESCRIBE,
      returnByValue: true,
    })) as { result?: { value?: FocusedElement } };
    const element = described.result?.value;
    if (element === undefined) {
      return { ok: false, secureField: false, origin, reason: "no_focused_element" };
    }
    if (element.tagName === "iframe" || element.tagName === "frame") {
      return { ok: false, secureField: false, origin, reason: "cross_frame_focus" };
    }
    // Every vault value is treated as screen-sensitive while it sits in the field (G6).
    const secureField = true;
    let handle: ResolvedSecret;
    try {
      handle = await authorize(origin, element);
    } catch (err) {
      return { ok: false, secureField, origin, reason: reasonOf(err) ?? "denied" };
    }
    // Touch ID may have taken seconds: re-check origin and focus right before typing.
    const still = await stillTargeted(cdp, objectId, origin, opts.backendNodeId);
    if (still !== null) {
      handle.dispose();
      return { ok: false, secureField, origin, reason: still };
    }
    let expected = -1;
    try {
      await handle.use(async (value) => {
        expected = [...value].length;
        await cdp.send("Input.insertText", { text: value });
      });
      const landed = (await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: VALUE_LENGTH,
        returnByValue: true,
      })) as { result?: { value?: number } };
      if (landed.result?.value !== expected) {
        await clearFocusedField(cdp, objectId, opts.selectAllModifier);
        return { ok: false, secureField, origin, reason: "fill_not_verified" };
      }
      return { ok: true, secureField, origin };
    } catch {
      await clearFocusedField(cdp, objectId, opts.selectAllModifier).catch(() => undefined);
      return { ok: false, secureField, origin, reason: "fill_failed" };
    } finally {
      handle.dispose();
    }
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

/**
 * Browser fill (security §4.6, feature G5): the top frame's origin must match a binding, the
 * focused element must be the approved one, in the top frame, and of the right field class
 * (checked by the broker). The value goes in through `Input.insertText` inside the handle's
 * `use`, so it never becomes a string the caller holds. If the value did not land in the field,
 * the field is cleared (select-all + delete) before control returns.
 */
export function fillBrowserField(input: BrowserFillInput): Promise<BrowserFillResult> {
  return fillFocused(input, (origin, element) =>
    input.broker.resolve(input.placeholder, { kind: "origin", value: origin }, input.approvalId, {
      executor: "browser",
      element,
      selector: input.selector,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    }),
  );
}

const IS_FOCUSED = `function () { return document.activeElement === this && this.isConnected; }`;

/** `null` when the page and focus are unchanged, else the reason to abort. */
async function stillTargeted(
  cdp: CdpSession,
  objectId: string,
  origin: string,
  backendNodeId: number | undefined,
): Promise<string | null> {
  const tree = (await cdp.send("Page.getFrameTree")) as FrameTree;
  const frame = tree.frameTree?.frame;
  if (canonicalOrigin(frame?.securityOrigin ?? frame?.url ?? "") !== origin) return "navigated";
  const focused = (await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: IS_FOCUSED,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  if (focused.result?.value !== true) return "focus_moved";
  if (backendNodeId !== undefined) {
    const desc = (await cdp.send("DOM.describeNode", { objectId })) as {
      node?: { backendNodeId?: number };
    };
    if (desc.node?.backendNodeId !== backendNodeId) return "focus_moved";
  }
  return null;
}

/**
 * Clear a field the broker typed into: select-all + Backspace through CDP input events, then
 * reset `value` from the isolated world in case the page swallowed the keys (security §4.7).
 * Browser executors call it on submit failure too.
 */
export async function clearFocusedField(
  cdp: CdpSession,
  objectId?: string,
  selectAllModifier = process.platform === "darwin" ? 4 : 2,
): Promise<void> {
  const key = (type: string, k: string, code: string, vk: number, modifiers = 0) =>
    cdp.send("Input.dispatchKeyEvent", {
      type,
      key: k,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
  await key("keyDown", "a", "KeyA", 65, selectAllModifier);
  await key("keyUp", "a", "KeyA", 65, selectAllModifier);
  await key("keyDown", "Backspace", "Backspace", 8);
  await key("keyUp", "Backspace", "Backspace", 8);
  if (objectId !== undefined) {
    await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: CLEAR });
  }
}

/** For callers that must fail loudly instead of returning a result. */
export function assertFilled(result: BrowserFillResult): void {
  if (!result.ok)
    fail("policy_denied", "credential fill did not complete", { reason: result.reason });
}
