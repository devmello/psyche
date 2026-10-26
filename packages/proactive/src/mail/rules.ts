/**
 * `mail/RULES.md`: the owner's sender rules for the digest (docs/workflows/mail-and-meetings-
 * 2026.md §4.1 "Learning"). A plain ledger like `interests.md`: the owner reads, edits and
 * exports it, and the digest applies it before any model (mail [14][15]). Lines it does not
 * understand are kept verbatim.
 *
 * ```
 * - allow: dana@example.com — screened in 2026-10-26
 * - always archive: deals@shop.example — from the digest card
 * - not now: news@paper.example (until 2026-11-02)
 * - category newsletters: weekly@acme.example
 * ```
 * A pattern is an address (`dana@example.com`) or a domain (`@example.com` or `example.com`).
 */

export type RuleDecision = "allow" | "always_archive" | "not_now" | "category";

export interface SenderRule {
  decision: RuleDecision;
  pattern: string;
  /** `category`: the category the owner moved the sender to. */
  category?: string;
  /** `not_now`: hidden until then. */
  until?: string;
  why: string;
}

export interface RulesFile {
  lines: (string | { rule: number })[];
  rules: SenderRule[];
}

const LINE =
  /^- (allow|always archive|not now|category ([a-z_]+)): (\S+)(?: \(until (\d{4}-\d{2}-\d{2})\))?(?: [—–-]+ (.*))?$/;

export function parseRules(text: string): RulesFile {
  const lines: RulesFile["lines"] = [];
  const rules: SenderRule[] = [];
  let comment = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.includes("<!--")) comment = true;
    const m = comment ? null : LINE.exec(line);
    if (line.includes("-->")) comment = false;
    if (m === null) {
      lines.push(line);
      continue;
    }
    const head = m[1] ?? "";
    const decision: RuleDecision = head.startsWith("category")
      ? "category"
      : head === "always archive"
        ? "always_archive"
        : head === "not now"
          ? "not_now"
          : "allow";
    const rule: SenderRule = {
      decision,
      pattern: (m[3] ?? "").toLowerCase(),
      why: (m[5] ?? "").trim(),
    };
    if (m[2] !== undefined) rule.category = m[2];
    if (m[4] !== undefined) rule.until = m[4];
    lines.push({ rule: rules.length });
    rules.push(rule);
  }
  return { lines, rules };
}

export function formatRule(r: SenderRule): string {
  const head =
    r.decision === "category"
      ? `category ${r.category ?? "fyi"}`
      : r.decision === "always_archive"
        ? "always archive"
        : r.decision === "not_now"
          ? "not now"
          : "allow";
  return `- ${head}: ${r.pattern}${r.until === undefined ? "" : ` (until ${r.until})`}${r.why === "" ? "" : ` — ${r.why}`}`;
}

export function serializeRules(f: RulesFile): string {
  const out: string[] = [];
  const seen = new Set<number>();
  for (const l of f.lines) {
    if (typeof l === "string") out.push(l);
    else {
      seen.add(l.rule);
      const r = f.rules[l.rule];
      if (r !== undefined) out.push(formatRule(r));
    }
  }
  const added = f.rules.filter((_, i) => !seen.has(i));
  if (added.length > 0 && out.length > 0 && out.at(-1) !== "") out.push("");
  for (const r of added) out.push(formatRule(r));
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

/** The address part of `Name <a@b.c>`, lowercased. */
export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim().toLowerCase();
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1);
}

function matchesPattern(pattern: string, address: string): boolean {
  if (pattern.includes("@") && !pattern.startsWith("@")) return pattern === address;
  const domain = pattern.replace(/^@/, "");
  const d = domainOf(address);
  return d === domain || d.endsWith(`.${domain}`);
}

/** The owner's rule for a sender (an exact address beats a domain), honouring `not now`. */
export function ruleFor(
  rules: readonly SenderRule[],
  from: string,
  today: string,
): SenderRule | undefined {
  const address = addressOf(from);
  const live = rules.filter(
    (r) =>
      matchesPattern(r.pattern, address) && (r.decision !== "not_now" || (r.until ?? "") >= today),
  );
  return live.find((r) => r.pattern === address) ?? live[0];
}

/** Adds or replaces the rule for a pattern (the card's Allow / Not now / Always archive). */
export function setRule(f: RulesFile, rule: SenderRule): void {
  const i = f.rules.findIndex((r) => r.pattern === rule.pattern);
  if (i >= 0) f.rules[i] = rule;
  else f.rules.push(rule);
}
