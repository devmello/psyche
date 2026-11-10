import { createHash } from "node:crypto";
import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import {
  isAmbiguousActionLabel,
  isMoneyContext,
  isMoneyFormAction,
  isMoneyText,
} from "@psyche/protocol/money-intent";
import type { ElementMeta } from "../types.ts";

/**
 * Per-action risk classification for browser tools (prompt S08 "Tools for the agent";
 * architecture §8; security §3.5, §6). Navigation to known origins is `read`, form submits and
 * uploads are `write`, consent / deletion paths are `destructive`, purchase paths are
 * `financial`. Classes only ever make a call stricter than its spec.
 */

const CONSENT =
  /\b(accept all|accept (cookies|terms)|agree( and continue)?|i agree|allow all|authori[sz]e|grant access)\b/i;
const DESTRUCTIVE =
  /\b(delete|remove|erase|cancel (my |your )?(subscription|account|order|membership)|close (my |your )?account|deactivate|unsubscribe|empty (trash|bin)|sign up|create (an |my )?account|register)\b/i;

/** View-only controls: expanding, paging, tabs, sorting. */
const BENIGN =
  /^(show|hide|more|less|expand|collapse|next|previous|prev|back|close|dismiss|open|menu|view|details|load more|read more|see (more|all)|filter|sort|search|go|tab|toggle|zoom|play|pause|reject( all| non-essential)?|decline|no thanks|not now|cancel|skip)\b/i;
const READ_ROLES = new Set([
  "link",
  "tab",
  "option",
  "menuitem",
  "treeitem",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "textbox",
  "searchbox",
  "heading",
  "img",
  "image",
]);

export interface ActionClass {
  sideEffect: SideEffect;
  kind?: ApprovalKind;
  reason: string;
}

const SEVERITY: Record<SideEffect, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
  financial: 4,
};

export function stricter(a: SideEffect, b: SideEffect): SideEffect {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** Classify activating an element (click, Enter in a field, submit). */
export function classifyActivation(meta: ElementMeta | undefined): ActionClass {
  if (meta === undefined) return { sideEffect: "write", reason: "unknown element" };
  const name = meta.name;
  if (pays(meta)) return { sideEffect: "financial", kind: "purchase", reason: "purchase path" };
  if (CONSENT.test(name)) return { sideEffect: "destructive", reason: "consent or terms" };
  if (DESTRUCTIVE.test(name))
    return { sideEffect: "destructive", reason: "deletes or creates an account" };
  if (meta.submits) return classifyFormSubmit(meta);
  if (meta.inputType === "file") return { sideEffect: "write", reason: "file chooser" };
  if (READ_ROLES.has(meta.role)) return { sideEffect: "read", reason: meta.role };
  // A button outside a form runs page script that may send, post or save: write unless its
  // name says it only changes the view (review finding 2).
  if ((meta.role === "button" || meta.role === "clickable") && !BENIGN.test(name)) {
    return { sideEffect: "write", reason: "script button" };
  }
  return { sideEffect: "read", reason: meta.role === "link" ? "link" : "view control" };
}

/** Submitting the element's form: Enter in a field, `type {submit: true}`, a submit button. */
export function classifyFormSubmit(meta: ElementMeta): ActionClass {
  if (formPays(meta)) {
    return { sideEffect: "financial", kind: "purchase", reason: "purchase path" };
  }
  return {
    sideEffect: meta.formMethod === "get" ? "read" : "write",
    kind: "browser_submit",
    reason: "form submit",
  };
}

/** A key press on `ref`: Enter/Space activate buttons and links; Enter in a field submits. */
export function classifyKeys(keys: string, meta: ElementMeta | undefined): ActionClass {
  const chords = keys.toLowerCase().split(/\s+/);
  const activates = chords.some((k) => k === "enter" || k === "space" || k === " ");
  if (!activates) return { sideEffect: "read", reason: "navigation keys" };
  if (meta === undefined) return { sideEffect: "write", reason: "Enter without a target" };
  const field = meta.role === "textbox" || meta.role === "searchbox" || meta.role === "combobox";
  if (field) {
    return chords.includes("enter") && meta.inForm
      ? classifyFormSubmit(meta)
      : { sideEffect: "read", reason: "typing" };
  }
  return classifyActivation(meta);
}

/** Submitting the element's form pays: real card fields, or a POST to a payment path. */
function formPays(meta: ElementMeta): boolean {
  return meta.formHasPaymentFields === true || isMoneyFormAction(meta.formMethod, meta.formAction);
}

/**
 * Whether activating the element pays. A link never does (navigation: "Where to buy",
 * "Pay bills", "Proceed to checkout"); the control that submits does. A submit of a payment form
 * pays whatever it says, a button labelled as a payment pays, and a bare "Confirm" or "Send"
 * counts only on a page or form that is clearly payment or checkout.
 */
function pays(meta: ElementMeta): boolean {
  if (meta.role === "link" && !meta.submits) return false;
  if (isMoneyText(meta.name)) return true;
  if (meta.submits && formPays(meta)) return true;
  return (
    (meta.submits || meta.role === "button" || meta.role === "clickable") &&
    isAmbiguousActionLabel(meta.name) &&
    isMoneyContext({
      url: meta.pageUrl,
      title: meta.pageTitle,
      hasPaymentFields: meta.formHasPaymentFields,
    })
  );
}

/** Canonical JSON (security §3.5): sorted keys, NFC strings, finite numbers only. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonicalJson: only plain objects");
    }
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k.normalize("NFC"))}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

export function sha256(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function bindingHash(kind: string, fields: unknown): `sha256:${string}` {
  return sha256(`psyche.binding.v1|${kind}|${canonicalJson(fields)}`);
}
