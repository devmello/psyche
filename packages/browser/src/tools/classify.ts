import { createHash } from "node:crypto";
import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import type { ElementMeta } from "../types.ts";

/**
 * Per-action risk classification for browser tools (prompt S08 "Tools for the agent";
 * architecture §8; security §3.5, §6). Navigation to known origins is `read`, form submits and
 * uploads are `write`, consent / deletion paths are `destructive`, purchase paths are
 * `financial`. Classes only ever make a call stricter than its spec.
 */

const PURCHASE =
  /\b(place (your |my )?order|buy( it)? now|complete (purchase|order|payment)|pay( now)?|confirm (and|&) pay|proceed to (checkout|payment)|check ?out|subscribe|start (my |your )?(free )?trial|purchase|add payment)\b/i;
const PURCHASE_PATH = /\/(checkout|payment|pay|purchase|order|billing|cart\/submit)(\/|$|\?)/i;
const CONSENT =
  /\b(accept all|accept (cookies|terms)|agree( and continue)?|i agree|allow all|authori[sz]e|grant access)\b/i;
const DESTRUCTIVE =
  /\b(delete|remove|erase|cancel (my |your )?(subscription|account|order|membership)|close (my |your )?account|deactivate|unsubscribe|empty (trash|bin)|sign up|create (an |my )?account|register)\b/i;

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
  const formPath = meta.formAction === undefined ? "" : safePath(meta.formAction);
  if (PURCHASE.test(name) || (meta.submits && PURCHASE_PATH.test(formPath))) {
    return { sideEffect: "financial", kind: "purchase", reason: "purchase path" };
  }
  if (CONSENT.test(name)) return { sideEffect: "destructive", reason: "consent or terms" };
  if (DESTRUCTIVE.test(name))
    return { sideEffect: "destructive", reason: "deletes or creates an account" };
  if (meta.submits) {
    return {
      sideEffect: meta.formMethod === "get" ? "read" : "write",
      kind: "browser_submit",
      reason: "form submit",
    };
  }
  if (meta.inputType === "file") return { sideEffect: "write", reason: "file chooser" };
  return { sideEffect: "read", reason: meta.role === "link" ? "link" : "plain control" };
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
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
