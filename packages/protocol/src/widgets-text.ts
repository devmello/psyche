import type { WidgetSpec } from "./schemas/widgets.ts";

/**
 * A plain-text rendering of a widget (generative-ui-2026 §8): the channels' fallback, the copy
 * button, and a screen-reader-friendly summary. The spec's own `fallbackText` comes first, then one
 * line per main node (progress → "3/5 · 60%", checklist → ☐/☑ lines, table → first 5 rows, stat →
 * "label: value"). Controls become nothing. Pure and total: never throws on a malformed node.
 */

type N = Record<string, unknown>;
const s = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const list = (v: unknown): N[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as N[]) : [];

const MARK: Record<string, string> = { done: "☑", failed: "✗", skipped: "–", active: "▸" };

function lines(n: N, out: string[], rows: number, depth: number): void {
  if (depth > 12 || !n || typeof n !== "object") return;
  switch (n.type) {
    case "progress": {
      const value = typeof n.value === "number" ? n.value : undefined;
      const max = typeof n.max === "number" ? n.max : undefined;
      out.push(
        value === undefined
          ? s(n.label)
          : max === undefined
            ? `${s(n.label)}: ${value}`
            : `${s(n.label)}: ${value}/${max} · ${Math.round((value / max) * 100)}%`,
      );
      for (const st of list(n.steps)) out.push(`${MARK[s(st.state)] ?? "☐"} ${s(st.label)}`);
      break;
    }
    case "checklist":
      for (const i of list(n.items)) out.push(`${MARK[s(i.state)] ?? "☐"} ${s(i.label)}`);
      break;
    case "timeline":
      for (const i of list(n.entries)) out.push(`${s(i.time)} ${s(i.label)}`.trim());
      break;
    case "stat":
      out.push(
        `${s(n.label)}: ${s(n.value)}${n.unit ? ` ${s(n.unit)}` : ""}${n.delta ? ` (${s(n.delta)})` : ""}`,
      );
      break;
    case "kv":
      for (const r of list(n.rows)) out.push(`${s(r.label)}: ${s(r.value)}`);
      break;
    case "status":
      out.push(s(n.label));
      break;
    case "text":
      out.push(s(n.text));
      break;
    case "markdown":
      out.push(s(n.md));
      break;
    case "code":
      out.push(s(n.code));
      break;
    case "table": {
      const cols = list(n.columns);
      const all = list(n.rows);
      out.push(cols.map((c) => s(c.label)).join(" | "));
      for (const r of all.slice(0, rows)) out.push(cols.map((c) => s(r[s(c.key)])).join(" | "));
      if (all.length > rows) out.push(`… ${all.length - rows} more`);
      break;
    }
    case "list":
      for (const i of list(n.items)) out.push(`- ${s(i.title)}${i.meta ? ` (${s(i.meta)})` : ""}`);
      break;
    case "chart":
      out.push(s(n.fallbackText) || s(n.label));
      break;
    case "map":
      for (const p of list(n.places))
        out.push(`- ${s(p.name)}${p.address ? `, ${s(p.address)}` : ""}`);
      break;
    case "link":
      out.push(`${s(n.label)}: ${s(n.url)}`);
      break;
    case "image":
      out.push(s(n.alt));
      break;
    case "card":
      if (n.title) out.push(s(n.title));
      if (n.subtitle) out.push(s(n.subtitle));
      break;
    default:
      // Controls (button, choices, form) become nothing; unknown nodes show their own fallback.
      if (
        typeof n.fallbackText === "string" &&
        !["button", "choices", "form"].includes(s(n.type))
      ) {
        out.push(n.fallbackText);
      }
  }
  const kids = [...list(n.children), ...list(n.tabs).flatMap((t) => list(t.children))];
  for (const c of kids) lines(c, out, rows, depth + 1);
}

export function widgetFallbackText(spec: WidgetSpec, options: { rows?: number } = {}): string {
  const out: string[] = [];
  lines(spec.root as N, out, options.rows ?? 5, 0);
  return [spec.fallbackText, ...out].filter((l) => l.trim() !== "").join("\n");
}
