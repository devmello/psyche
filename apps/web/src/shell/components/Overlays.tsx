import { t } from "@psyche/ui";
import { type ReactElement, type RefObject, useEffect, useId, useRef, useState } from "react";
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
/**
 * Modal dialog focus (docs/a11y-audit.md W2): remembers what had focus, keeps Tab inside the
 * dialog, closes on Escape and gives focus back when the dialog goes.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  // Read during the first render, before any effect moves focus into the dialog.
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  // Callers pass onClose inline; a ref keeps the effect (and its focus return) to one run.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      el.querySelector<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])")?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const focusable = [
        ...el.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el?.addEventListener("keydown", onKey);
    return () => {
      el?.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [ref, opener]);
}

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
    const timer = setTimeout(() => {
      void store
        .call<{ results?: { id: string; title?: string; kind?: string; route?: string | null }[] }>(
          "search.query",
          { query: q, limit: 8 },
        )
        .then((r) =>
          setHits(
            (r?.results ?? []).map((x) => ({
              id: x.id,
              label: t("web.palette.hit", {
                kind: x.kind ?? t("web.palette.result"),
                title: x.title ?? x.id,
              }),
              route: x.route ?? `/search?q=${encodeURIComponent(q)}`,
            })),
          ),
        )
        .catch(() => setHits([]));
    }, 150);
    return () => clearTimeout(timer);
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
  const dialog = useRef<HTMLDivElement>(null);
  const listId = useId();
  useDialogFocus(dialog, props.onClose);
  const choose = (i: number) => {
    rows[i]?.run();
    props.onClose();
  };
  return (
    // biome-ignore lint/a11y: backdrop click closes; Esc is handled on the input
    <div className="overlay" onClick={props.onClose} data-testid="palette">
      {/* biome-ignore lint/a11y: stops the backdrop click */}
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("web.palette.label")}
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
          placeholder={t("web.palette.placeholder")}
          aria-label={t("web.palette.placeholder")}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          {...(rows[sel] ? { "aria-activedescendant": `${listId}-${sel}` } : {})}
        />
        <div role="listbox" aria-label={t("web.palette.results")} id={listId}>
          {rows.map((r, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled on the input
            <div
              key={r.key}
              id={`${listId}-${i}`}
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
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  return (
    // biome-ignore lint/a11y: backdrop click closes; Esc closes through useDialogFocus
    <div className="overlay" onClick={onClose} data-testid="shortcut-sheet">
      {/* biome-ignore lint/a11y: stops the backdrop click */}
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="psyche-shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 id="psyche-shortcuts-title" style={{ marginTop: 0, flex: 1 }}>
            {t("web.shortcuts.title")}
          </h2>
          <button type="button" className="pill" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <table>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.action}>
                <td style={{ paddingInlineEnd: 16 }}>
                  <kbd>{chordLabel(s.chord, mac)}</kbd>
                </td>
                <td>
                  {s.scope === "global"
                    ? t("web.shortcuts.systemWide", { label: s.label })
                    : s.label}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ListedModels {
  providers?: { models?: { ref: string; capabilities?: { embeddings?: boolean } }[] }[];
}

/** Chat models from `models.list` (embedding models cannot chat); none from older Gateways. */
export function chatModelRefs(listed: ListedModels | undefined): string[] {
  const refs = (listed?.providers ?? []).flatMap((p) =>
    (p.models ?? []).filter((m) => m.capabilities?.embeddings !== true).map((m) => m.ref),
  );
  return [...new Set(refs)];
}

/**
 * ⌘⇧I model picker: a free `provider/model` field, with the Gateway's known models
 * (`models.list`: role chains, config and the last endpoint probes) as suggestions.
 */
export function ModelPicker(props: {
  current: string | null;
  onPick: (modelRef: string) => void;
  onClose: () => void;
}): ReactElement {
  const { store } = useShell();
  const [v, setV] = useState(props.current ?? "");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void store
      .call<ListedModels>("models.list", {})
      .then((r) => {
        if (live) setSuggestions(chatModelRefs(r));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [store]);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, props.onClose);
  const valid = /^[a-z0-9][a-z0-9_.-]*\/.+$/.test(v);
  return (
    // biome-ignore lint/a11y: backdrop click closes; Esc is handled on the input
    <div className="overlay" onClick={props.onClose} data-testid="model-picker">
      {/* biome-ignore lint/a11y: stops the backdrop click */}
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("web.modelPicker.label")}
        onClick={(e) => e.stopPropagation()}
      >
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
          placeholder={t("web.modelPicker.placeholder", { example: "anthropic/claude-opus-5-5" })}
          aria-label={t("web.modelPicker.reference")}
          list="psyche-model-suggestions"
        />
        <datalist id="psyche-model-suggestions" data-testid="model-suggestions">
          {suggestions.map((ref) => (
            <option key={ref} value={ref} />
          ))}
        </datalist>
      </div>
    </div>
  );
}
