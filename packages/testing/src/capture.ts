import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findPatterns, type PatternKind } from "./secret-patterns.ts";
import { fixtureSecretSet } from "./secret-registry.ts";
import { findSecrets, forEachString, type SecretEncoding, type SecretSet } from "./secrets.ts";

/**
 * Model-visible capture (cross-cutting criterion "No secret in model-visible text"; security
 * §4.6–§4.7, §14 logs, §15.4 item 7). Fakes and harnesses call `captureModelVisible` with every
 * string that would reach a model, a transcript, a log, a notification or a receipt; the Vitest
 * guard (`@psyche/testing/vitest`) scans each test's captures, and `pnpm check:secrets` scans the
 * JSONL files written when `PSYCHE_CAPTURE_DIR` is set.
 */

export type CaptureKind =
  | "prompt"
  | "tool_result"
  | "transcript"
  | "log"
  | "audit"
  | "notification"
  | "receipt"
  | "approval_card"
  | "screenshot_text"
  | "other";

export interface CaptureOptions {
  /** Where it came from, e.g. `FakeModelProvider.stream` or a test name. */
  where?: string;
  /**
   * Pattern kinds expected in this capture (a test of a card validator, a receipt showing a
   * published test card's last4 is fine but a full number is not). Per capture, never global.
   */
  allow?: PatternKind[];
}

export interface Capture extends CaptureOptions {
  seq: number;
  kind: CaptureKind;
  value: unknown;
}

export type LeakKind = "registered_secret" | "placeholder_resolution" | PatternKind;

/** A leak, described without the leaked value. */
export interface Leak {
  kind: LeakKind;
  captureKind: CaptureKind;
  where?: string;
  /** JSON-ish path inside the captured value. */
  path: string;
  offset: number;
  /** Registry label (`cred:github-login.password`) for registered secrets. */
  label?: string;
  encoding?: SecretEncoding;
}

let seq = 0;
let buffer: Capture[] = [];

/** Record a model-visible value. Cheap; scanning happens later. */
export function captureModelVisible(
  kind: CaptureKind,
  value: unknown,
  options: CaptureOptions = {},
): void {
  const capture: Capture = { seq: seq++, kind, value, ...options };
  buffer.push(capture);
  const dir = process.env.PSYCHE_CAPTURE_DIR;
  if (dir !== undefined && dir !== "") writeCapture(dir, capture);
}

/** Captures recorded since the last drain, oldest first; empties the buffer. */
export function drainCaptures(): Capture[] {
  const out = buffer;
  buffer = [];
  return out;
}

export function peekCaptures(): readonly Capture[] {
  return buffer;
}

function writeCapture(dir: string, capture: Capture): void {
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(capture, jsonReplacer);
  appendFileSync(join(dir, `captures-${process.pid}.jsonl`), `${line}\n`, { mode: 0o600 });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, cause: value.cause };
  }
  return value;
}

let fixtureSet: SecretSet | undefined;

/**
 * Leaks in one capture: values from the shared fixture registry, values registered with
 * `registerSecret`, and pattern hits (cards, SSNs, IBANs, bank accounts, passports, private keys)
 * except kinds the capture allows.
 */
export function scanCapture(capture: Capture, extra: SecretSet[] = []): Leak[] {
  fixtureSet ??= fixtureSecretSet();
  const base = { captureKind: capture.kind, ...(capture.where ? { where: capture.where } : {}) };
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  const matches = [fixtureSet, ...extra].flatMap((set) => set.find(capture.value));
  matches.push(...findSecrets(capture.value));
  for (const m of matches) {
    const key = `${m.label}|${m.encoding}|${m.path}|${m.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leaks.push({
      ...base,
      kind: m.label.startsWith("cred:") ? "placeholder_resolution" : "registered_secret",
      label: m.label,
      encoding: m.encoding,
      path: m.path,
      offset: m.offset,
    });
  }
  forEachString(capture.value, (text, path) => {
    for (const p of findPatterns(text, capture.allow)) {
      leaks.push({ ...base, kind: p.kind, path, offset: p.offset });
    }
  });
  return leaks;
}

export function scanCaptures(captures: readonly Capture[], extra: SecretSet[] = []): Leak[] {
  return captures.flatMap((c) => scanCapture(c, extra));
}

export function describeLeak(l: Leak): string {
  const what = l.label === undefined ? l.kind : `${l.kind} ${l.label} (${l.encoding})`;
  return `${what} in ${l.captureKind}${l.where ? ` from ${l.where}` : ""} at ${l.path} offset ${l.offset}`;
}

export class ModelVisibleLeakError extends Error {
  readonly leaks: Leak[];
  constructor(leaks: Leak[], where?: string) {
    const lines = leaks.slice(0, 10).map((l) => `  - ${describeLeak(l)}`);
    const more = leaks.length > 10 ? `\n  … and ${leaks.length - 10} more` : "";
    super(
      `Model-visible leak${where === undefined ? "" : ` in ${where}`}: ${leaks.length} hit(s)\n${lines.join("\n")}${more}`,
    );
    this.name = "ModelVisibleLeakError";
    this.leaks = leaks;
  }
}

/** Scan and drain the buffered captures; throws `ModelVisibleLeakError` on any leak. */
export function assertNoModelVisibleLeaks(where?: string, extra: SecretSet[] = []): void {
  const leaks = scanCaptures(drainCaptures(), extra);
  if (leaks.length > 0) throw new ModelVisibleLeakError(leaks, where);
}
