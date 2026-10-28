import type { QuarantineReason } from "@psyche/protocol";
import { looksLikeInstruction } from "../filters.ts";

/**
 * Deterministic screening of one cleaned item (docs/design/everything-memory-2026.md §5.6). Runs
 * before the model sees the item (the reader drops what it flags) and again over the model's
 * output, so a hijacked extractor cannot launder a flagged item. Only `untrusted` items are
 * screened for claims about the owner and identity; instruction-like text is flagged for every
 * trust level (the owner's own notes can be pasted web text).
 */

/** Role markers, chat templates and tool-call syntax that only an attacker puts in a message. */
const ROLE_AND_TOOL_MARKERS: RegExp[] = [
  /^\s*(?:assistant|system|developer|ai|claude|psyche)\s*[:>\]]/im,
  /\[\s*(?:system|inst|\/inst|assistant)\s*\]/i,
  /<\|[a-z_]{2,20}\|>/i,
  /<\/?(?:system|assistant|instructions?|tool_?call|tool_use|function_?call|im_start|im_end)\b/i,
  /\b(?:tool_?call|tool_use|function_call|tool_name)\b\s*["':=]/i,
  /"(?:tool|tool_name|function|name)"\s*:\s*"[a-z_.]{3,40}"\s*,\s*"(?:input|arguments|params)"/i,
  /\bpsyche system message\b/i,
  /\bBEGIN (?:SYSTEM|INSTRUCTIONS)\b/i,
];

const INSTRUCTIONS_TO_AGENT: RegExp[] = [
  // The same asks in other languages (es, fr, de, pt, it, zh, ja).
  /\b(?:ignora|ignore[zs]?|ignoriere|ignorar|ignorer|ignorare|ignorieren)\b.{0,40}\b(?:instrucciones|instructions|anweisungen|instruções|istruzioni|reglas|règles|regeln)\b/iu,
  /\b(?:asistente|assistant|assistente|assistent)\b[\s,:]{1,5}(?:envía|envia|envoie|sende|reenvía|elimina|supprime|lösche|borra)\b/iu,
  /(?:忽略|无视|忽视).{0,12}(?:指令|指示|提示|规则)|(?:助手|助理)[，,:：\s]/u,
  /(?:指示|命令).{0,6}(?:無視|無効)|(?:以前の|これまでの).{0,6}指示/u,
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,40}\b(?:instructions?|rules?|guidelines?|polic(?:y|ies)|system prompt|previous|above|prior)\b/i,
  /\b(?:you are now|act as|pretend (?:to be|you are)|new instructions?|updated instructions?|your (?:new )?(?:task|role|instructions?) (?:is|are))\b/i,
  /\b(?:assistant|ai|agent|claude|psyche|model)\b[\s,:]{1,5}(?:please |kindly |must |now |immediately )?(?:forward|send|email|reply|delete|remove|add|set|turn (?:off|on)|disable|enable|change|update|remember|save|store|run|execute|call|open|share|export|upload|merge|trust|approve|grant)\b/i,
  /\b(?:add|append|write) (?:this|the following) (?:to|into) (?:your|the|my) (?:instructions?|memory|rules|notes|system prompt|user\.md|memory\.md|soul)\b/i,
  /\b(?:turn off|disable|skip|stop) (?:the )?(?:review|quarantine|safety|filters?|memory review|approval)\b/i,
  /\b(?:add|include|whitelist|allowlist|trust)\b.{0,40}\b(?:to|as) (?:your |the )?(?:trusted|allowed|safe) (?:sources?|senders?|domains?|contacts?)\b/i,
  /\b(?:merge|link|treat)\b.{0,30}\b(?:me|this (?:account|address|number))\b.{0,30}\b(?:with|as|into)\b/i,
  /\bdo not (?:tell|show|inform|mention|notify)\b.{0,25}\b(?:user|owner|anyone)\b/i,
];

/** Claims about the owner from someone else ("you owe", "your new number is"). */
const CLAIMS_ABOUT_OWNER: RegExp[] = [
  /\byou (?:owe|agreed|promised|signed|authorized|authorised|approved|confirmed|are the new|are now|work (?:at|for)|live (?:at|in)|moved to|were|have been)\b/i,
  /\byour (?:new |old |current |real |actual )?(?:phone|number|address|email|e-mail|account|bank|iban|card|password|passport|ssn|birthday|salary|employer|boss|manager|wife|husband|partner|doctor|lawyer|insurance|login|username)\b/i,
  /\bthis is (?:your|the owner|the account owner)\b/i,
  /\b(?:tu|vous|du|deine?|ihre?) (?:debes|devez|schuldest|número nuevo|nouveau numéro|neue nummer)\b/i,
];

/** A sender claiming to be, or to now own, another identity. */
const IDENTITY_CLAIMS: RegExp[] = [
  /\bthis is (?:[A-Z][\w'-]+(?: [A-Z][\w'-]+)?)(?:'s| from)? (?:new|other|second|backup|personal|work) (?:account|address|number|email|phone|handle)\b/i,
  /\b(?:i am|i'm|it's|this is) (?:also|really|actually|now) (?:[A-Z][\w'-]+)/i,
  /\b(?:my|our) (?:new|other|old) (?:number|email|address|account|handle) (?:is|will be)\b/i,
  /\b(?:same person as|merge (?:me|this) with|i am the same as|treat me as)\b/i,
  /\bsave (?:this|my) (?:new )?(?:number|email|contact) (?:for|as|under)\b/i,
];

/** Asks to change who someone is to the owner. */
const RELATION_CHANGES: RegExp[] = [
  /\b(?:mark|set|update|change|record|save|list|file)\b.{0,30}\b(?:me|him|her|them|us|my)\b.{0,40}\b(?:as|to be)\b.{0,25}\b(?:wife|husband|partner|sister|brother|mother|father|mom|dad|boss|manager|friend|client|doctor|lawyer)\b/i,
  /\bchange (?:our|my|the) relationship\b/i,
];

export interface ScreenInput {
  /** The cleaned text. */
  text: string;
  /** `untrusted` is anything a third party wrote. */
  trust: "owner" | "trusted" | "untrusted";
  /** Hidden text or invisible characters were removed while cleaning. */
  hiddenRemoved?: boolean;
  /** Scanned raw length vs visible length: a big drop means the visible text differs from the raw. */
  rawLength?: number;
  visibleLength?: number;
  /** Extra text fields from the same item (subject, display name, signature, headers). */
  fields?: string[];
}

export interface ScreenResult {
  reasons: QuarantineReason[];
}

const anyMatch = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

export function screenItem(input: ScreenInput): ScreenResult {
  const reasons = new Set<QuarantineReason>();
  const texts = [input.text, ...(input.fields ?? [])];
  for (const t of texts) {
    if (
      looksLikeInstruction(t) ||
      anyMatch(ROLE_AND_TOOL_MARKERS, t) ||
      anyMatch(INSTRUCTIONS_TO_AGENT, t)
    ) {
      reasons.add("instruction_like");
    }
    if (input.trust === "untrusted") {
      if (anyMatch(CLAIMS_ABOUT_OWNER, t)) reasons.add("claims_about_owner");
      if (anyMatch(IDENTITY_CLAIMS, t)) reasons.add("identity_claim");
      if (anyMatch(RELATION_CHANGES, t)) reasons.add("relation_change");
    }
  }
  if (input.hiddenRemoved === true) reasons.add("hidden_text");
  if (
    input.rawLength !== undefined &&
    input.visibleLength !== undefined &&
    input.rawLength > 2000 &&
    input.visibleLength < input.rawLength * 0.1 &&
    input.trust === "untrusted"
  ) {
    // The visible text is a small part of what was sent: most of the message was markup or hidden.
    reasons.add("hidden_text");
  }
  return { reasons: [...reasons] };
}
