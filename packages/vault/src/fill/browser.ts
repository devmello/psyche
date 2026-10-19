import type { CredentialBroker, FillElement } from "@psyche/protocol";
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
  /** The field is a password field: screenshots are suppressed while it holds the value (G6). */
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
  if (form) { try { action = new URL(form.getAttribute("action") || "", document.baseURI).origin; } catch (e) { action = "null"; } }
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

/**
 * Browser fill (security §4.6, feature G5): the top frame's origin must match a binding, the
 * focused element must be the approved one, in the top frame, and of the right field class
 * (checked by the broker). The value goes in through `Input.insertText` inside the handle's
 * `use`, so it never becomes a string the caller holds. If the value did not land in the field,
 * the field is cleared (select-all + delete) before control returns.
 */
export async function fillBrowserField(input: BrowserFillInput): Promise<BrowserFillResult> {
  const { cdp } = input;
  if (input.takeControlActive === true) {
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
    if (input.backendNodeId !== undefined) {
      const desc = (await cdp.send("DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      if (desc.node?.backendNodeId !== input.backendNodeId) {
        return { ok: false, secureField: false, origin, reason: "focus_moved" };
      }
    }
    const described = (await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: DESCRIBE,
      returnByValue: true,
    })) as { result?: { value?: FillElement } };
    const element = described.result?.value;
    if (element === undefined) {
      return { ok: false, secureField: false, origin, reason: "no_focused_element" };
    }
    if (element.tagName === "iframe" || element.tagName === "frame") {
      return { ok: false, secureField: false, origin, reason: "cross_frame_focus" };
    }
    const secureField = element.type === "password";
    let handle: Awaited<ReturnType<CredentialBroker["resolve"]>>;
    try {
      handle = await input.broker.resolve(
        input.placeholder,
        { kind: "origin", value: origin },
        input.approvalId,
        {
          executor: "browser",
          element,
          selector: input.selector,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        },
      );
    } catch (err) {
      return { ok: false, secureField, origin, reason: reasonOf(err) ?? "denied" };
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
        await clearFocusedField(cdp, objectId, input.selectAllModifier);
        return { ok: false, secureField, origin, reason: "fill_not_verified" };
      }
      return { ok: true, secureField, origin };
    } catch {
      await clearFocusedField(cdp, objectId, input.selectAllModifier).catch(() => undefined);
      return { ok: false, secureField, origin, reason: "fill_failed" };
    } finally {
      handle.dispose();
    }
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
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
