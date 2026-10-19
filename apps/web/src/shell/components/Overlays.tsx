import { type ReactElement, useEffect, useRef, useState } from "react";
import { useShell } from "../context.tsx";
import { chordLabel, SHORTCUTS } from "../keyboard.ts";

export interface PaletteAction {
  id: string;
  label: string;
  run: () => void;
}

interface SearchHit {
  id: string;
  label: string;
  route: string;
}

/**
 * ⌘K command palette shell (docs/06 §2.5): actions plus results from `search.query`. Result
 * rendering is S12/S16's; this lists titles and routes into the right screen.
 */
export function CommandPalette(props: {
  actions: PaletteAction[];
  onClose: () => void;
  onNavigate: (route: string) => void;
}): ReactElement {
  const { store } = useShell();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      void store
        .call<{ results?: { id: string; title?: string; kind?: string; route?: string | null }[] }>(
          "search.query",
          { query: q, limit: 8 },
        )
        .then((r) =>
          setHits(
            (r?.results ?? []).map((x) => ({
              id: x.id,
              label: `${x.kind ?? "result"} · ${x.title ?? x.id}`,
              route: x.route ?? `/search?q=${encodeURIComponent(q)}`,
            })),
          ),
        )
        .catch(() => setHits([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q, store]);
  const actions = props.actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));
  const rows: { key: string; label: string; run: () => void }[] = [
    ...actions.map((a) => ({ key: a.id, label: a.label, run: a.run })),
    ...hits.map((h) => ({
      key: `hit-${h.id}`,
      label: h.label,
      run: () => props.onNavigate(h.route),
    })),
  ];
  const choose = (i: number) => {
    rows[i]?.run();
    props.onClose();
  };
  return (
    // biome-ignore lint/a11y: backdrop click closes; Esc is handled on the input
    <div className="overlay" onClick={props.onClose} data-testid="palette">
      {/* biome-ignore lint/a11y: stops the backdrop click */}
      <div
        className="dialog"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
            if (e.key === "ArrowDown") setSel((s) => Math.min(rows.length - 1, s + 1));
            if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
            if (e.key === "Enter") choose(sel);
          }}
          placeholder="Search or run a command"
          aria-label="Search or run a command"
        />
        <div role="listbox" aria-label="Results">
          {rows.map((r, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled on the input
            <div
              key={r.key}
              role="option"
              tabIndex={-1}
              aria-selected={i === sel}
              onClick={() => choose(i)}
              style={{ padding: 6 }}
            >
              {r.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ShortcutSheet({ onClose }: { onClose: () => void }): ReactElement {
  const { mac } = useShell();
  return (
    // biome-ignore lint/a11y: backdrop click closes; Esc closes through the global handler
    <div className="overlay" onClick={onClose} data-testid="shortcut-sheet">
      <div className="dialog" role="dialog" aria-label="Keyboard shortcuts">
        <h2 style={{ marginTop: 0 }}>Keyboard shortcuts</h2>
        <table>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.action}>
                <td style={{ paddingRight: 16 }}>
                  <kbd>{chordLabel(s.chord, mac)}</kbd>
                </td>
                <td>
                  {s.label}
                  {s.scope === "global" ? " (system-wide)" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** ⌘⇧I model picker: a free `provider/model` field until the Gateway lists models. */
export function ModelPicker(props: {
  current: string | null;
  onPick: (modelRef: string) => void;
  onClose: () => void;
}): ReactElement {
  const [v, setV] = useState(props.current ?? "");
  const valid = /^[a-z0-9][a-z0-9_.-]*\/.+$/.test(v);
  return (
    // biome-ignore lint/a11y: backdrop click closes; Esc is handled on the input
    <div className="overlay" onClick={props.onClose} data-testid="model-picker">
      {/* biome-ignore lint/a11y: stops the backdrop click */}
      <div className="dialog" role="dialog" aria-label="Model" onClick={(e) => e.stopPropagation()}>
        <input
          // biome-ignore lint/a11y/noAutofocus: dialog's only field
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
            if (e.key === "Enter" && valid) {
              props.onPick(v);
              props.onClose();
            }
          }}
          placeholder="provider/model, e.g. anthropic/claude-opus-5-5"
          aria-label="Model reference"
        />
      </div>
    </div>
  );
}
