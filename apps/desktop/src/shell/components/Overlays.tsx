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

interface ListedModel {
  ref: string;
  label?: string;
  capabilities?: { embeddings?: boolean };
}
interface ListedModels {
  providers?: { id?: string; label?: string; models?: ListedModel[] }[];
}

/** Chat models from `models.list` (embedding models cannot chat); none from older Gateways. */
export function chatModelRefs(listed: ListedModels | undefined): string[] {
  const refs = (listed?.providers ?? []).flatMap((p) =>
    (p.models ?? []).filter((m) => m.capabilities?.embeddings !== true).map((m) => m.ref),
  );
  return [...new Set(refs)];
}

export interface ModelGroup {
  provider: string;
  models: { ref: string; name: string }[];
}

/** The picker's list: chat models grouped by configured provider, each shown by its label. */
export function chatModelGroups(listed: ListedModels | undefined): ModelGroup[] {
  const seen = new Set<string>();
  const groups: ModelGroup[] = [];
  for (const p of listed?.providers ?? []) {
    const models: ModelGroup["models"] = [];
    for (const m of p.models ?? []) {
      if (m.capabilities?.embeddings === true || seen.has(m.ref)) continue;
      seen.add(m.ref);
      const name = m.label !== undefined && m.label.trim() !== "" ? m.label : m.ref;
      models.push({ ref: m.ref, name });
    }
    if (models.length > 0) groups.push({ provider: p.label ?? p.id ?? "", models });
  }
  return groups;
}

const MODEL_REF = /^[a-z0-9][a-z0-9_.-]*\/.+$/;

/**
 * ⌘⇧I model picker: the models the configured providers offer (`models.list`), with the
 * current one checked. "Other model…" opens a free `provider/model` field; either way
 * `onPick` gets the same `provider/model` string, so saved threads keep working.
 */
export function ModelPicker(props: {
  current: string | null;
  onPick: (modelRef: string) => void;
  onClose: () => void;
}): ReactElement {
  const { store } = useShell();
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  const [other, setOther] = useState(false);
  const [v, setV] = useState(props.current ?? "");
  useEffect(() => {
    let live = true;
    void store
      .call<ListedModels>("models.list", {})
      .then((r) => {
        if (live) setGroups(chatModelGroups(r));
      })
      .catch(() => {
        if (live) setGroups([]);
      });
    return () => {
      live = false;
    };
  }, [store]);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, props.onClose);
  const valid = MODEL_REF.test(v);
  const pick = (ref: string) => {
    props.onPick(ref);
    props.onClose();
  };
  const showField = other || (groups !== null && groups.length === 0);
  return (
    // biome-ignore lint/a11y: backdrop click closes; Esc is handled in the dialog
    <div className="overlay" onClick={props.onClose} data-testid="model-picker">
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("web.modelPicker.label")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      >
        {groups !== null && groups.length === 0 ? (
          <p data-testid="model-picker-empty">{t("desktop.modelPicker.empty")}</p>
        ) : null}
        {groups?.map((g) => (
          <div key={g.provider} role="group" aria-label={g.provider}>
            <div>{g.provider}</div>
            {g.models.map((m) => (
              <button
                key={m.ref}
                type="button"
                data-testid="model-option"
                data-ref={m.ref}
                aria-pressed={m.ref === props.current}
                onClick={() => pick(m.ref)}
              >
                {m.ref === props.current ? "✓ " : ""}
                {m.name}
              </button>
            ))}
          </div>
        ))}
        {groups !== null && groups.length > 0 && !other ? (
          <button type="button" data-testid="model-other" onClick={() => setOther(true)}>
            {t("desktop.modelPicker.other")}
          </button>
        ) : null}
        {showField ? (
          <div>
            <input
              // biome-ignore lint/a11y/noAutofocus: opened on purpose
              autoFocus
              value={v}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) pick(v);
              }}
              placeholder={t("web.modelPicker.placeholder", {
                example: "anthropic/claude-opus-5-5",
              })}
              aria-label={t("web.modelPicker.reference")}
            />
            <button type="button" disabled={!valid} onClick={() => pick(v)}>
              {t("desktop.modelPicker.use")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
