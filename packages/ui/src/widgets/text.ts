import type { WidgetSpec } from "@psyche/protocol";

/**
 * A plain-text rendering of a spec for copy (and later the channel fallback, §8): the
 * spec's own `fallbackText`, then one line per main node.
 */
type N = Record<string, unknown>;
const s = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";

function lines(n: N, out: string[]): void {
  switch (n.type) {
    case "progress": {
      const max = typeof n.max === "number" ? n.max : undefined;
      const value = typeof n.value === "number" ? n.value : undefined;
      out.push(
        value === undefined
          ? s(n.label)
          : max === undefined
            ? `${s(n.label)}: ${value}`
            : `${s(n.label)}: ${value}/${max} · ${Math.round((value / max) * 100)}%`,
      );
      break;
    }
    case "checklist":
      for (const i of (n.items as N[]) ?? [])
        out.push(`${i.state === "done" ? "☑" : "☐"} ${s(i.label)}`);
      break;
    case "timeline":
      for (const i of (n.entries as N[]) ?? []) out.push(`${s(i.time)} ${s(i.label)}`.trim());
      break;
    case "stat":
      out.push(`${s(n.label)}: ${s(n.value)}${n.unit ? ` ${s(n.unit)}` : ""}`);
      break;
    case "kv":
      for (const r of (n.rows as N[]) ?? []) out.push(`${s(r.label)}: ${s(r.value)}`);
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
    case "table": {
      const cols = (n.columns as N[]) ?? [];
      out.push(cols.map((c) => s(c.label)).join(" | "));
      for (const r of ((n.rows as N[]) ?? []).slice(0, 5))
        out.push(cols.map((c) => s(r[s(c.key)])).join(" | "));
      break;
    }
    case "list":
      for (const i of (n.items as N[]) ?? [])
        out.push(`- ${s(i.title)}${i.meta ? ` (${s(i.meta)})` : ""}`);
      break;
    default:
      if (typeof n.fallbackText === "string") out.push(n.fallbackText);
  }
  const kids = [
    ...((n.children as N[]) ?? []),
    ...((n.tabs as N[]) ?? []).flatMap((t) => (t.children as N[]) ?? []),
  ];
  for (const c of kids) lines(c, out);
}

export function widgetText(spec: WidgetSpec): string {
  const out: string[] = [spec.title, spec.fallbackText];
  lines(spec.root as N, out);
  return out.filter(Boolean).join("\n");
}
