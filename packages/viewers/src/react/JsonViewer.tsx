import { useState } from "react";
import { CodeView } from "./CodeViewer.tsx";
import type { ViewerProps } from "./contract.ts";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

const PAGE = 100;
const MAX_TREE_BYTES = 20 * 1024 * 1024;

type Parsed =
  | { ok: true; value: unknown; text: string }
  | { ok: false; error: string; text: string };

/** Parses JSON, or JSON Lines (one value per line) when the file is `.jsonl`. */
export function parseJsonText(text: string, name: string): Parsed {
  try {
    if (/\.jsonl$/i.test(name)) {
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      return { ok: true, value: lines.map((l) => JSON.parse(l) as unknown), text };
    }
    return { ok: true, value: JSON.parse(text) as unknown, text };
  } catch (err) {
    return { ok: false, error: (err as Error).message, text };
  }
}

/** JSON tree viewer (P4) with a Raw toggle; invalid JSON falls back to the code view. */
export function JsonViewer(props: ViewerProps) {
  const state = useLoadable(props.item.id, async (signal) => {
    const bytes = await props.load(signal);
    const text = new TextDecoder().decode(bytes);
    if (bytes.byteLength > MAX_TREE_BYTES)
      return { ok: false, error: "Too large for the tree view", text } as Parsed;
    return parseJsonText(text, props.item.name);
  });
  const [raw, setRaw] = useState(false);
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${props.item.name}…`} />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This file could not be opened"
        detail={state.error.message}
      />
    );
  const parsed = state.value;
  return (
    <div className="psy-json">
      <Toolbar label="JSON">
        {parsed.ok ? (
          <button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
            {raw ? "Tree" : "Raw"}
          </button>
        ) : (
          <span role="note">Not valid JSON: {parsed.error}</span>
        )}
      </Toolbar>
      {parsed.ok && !raw ? (
        <ul className="psy-json__tree" aria-label={`${props.item.name} tree`}>
          <JsonNode label="(root)" value={parsed.value} depth={0} />
        </ul>
      ) : (
        <CodeView {...props} compact text={parsed.text} language="json" />
      )}
    </div>
  );
}

function JsonNode(props: { label: string; value: unknown; depth: number }) {
  const { value } = props;
  const isObj = typeof value === "object" && value !== null;
  const [open, setOpen] = useState(props.depth < 2);
  const [shown, setShown] = useState(PAGE);
  if (!isObj) {
    return (
      <li>
        <span className="psy-json__key">{props.label}</span>:{" "}
        <span className={`psy-json__${value === null ? "null" : typeof value}`}>
          {JSON.stringify(value)}
        </span>
      </li>
    );
  }
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="psy-json__toggle"
      >
        <span className="psy-json__key">{props.label}</span> <small>{summary}</small>
      </button>
      {open ? (
        <ul>
          {entries.slice(0, shown).map(([k, v]) => (
            <JsonNode key={k} label={k} value={v} depth={props.depth + 1} />
          ))}
          {entries.length > shown ? (
            <li>
              <button type="button" onClick={() => setShown(shown + PAGE)}>
                Show {Math.min(PAGE, entries.length - shown)} more of {entries.length - shown}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
