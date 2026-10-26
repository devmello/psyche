import { useMemo, useRef } from "react";
import type { LineMark } from "../core/line-marks.ts";
import type { DocumentStore } from "../core/markdown.ts";
import { MarkdownEditor } from "./MarkdownEditor.tsx";

export interface ControlledMarkdownEditorProps {
  path: string;
  /** The host's text (its draft, or the file). */
  value: string;
  /** Every edit, at once: the host keeps the draft and owns Save / Discard. */
  onChange: (value: string) => void;
  readOnly?: boolean;
  marks?: readonly LineMark[];
  onMarkActivate?: (id: string) => void;
}

/**
 * `MarkdownEditor` as a controlled field, for a host that owns saving (the kit's `renderEditor`
 * slot: Soul & Memory's file editor has its own budget, Save and Discard). Its store accepts every
 * edit immediately and hands it to `onChange`; when `value` changes for any other reason
 * (Discard, a reload after Save), the editor follows it as a remote change. Only the Rich / Source
 * / Diff switch shows.
 */
export function ControlledMarkdownEditor(props: ControlledMarkdownEditorProps) {
  const { value } = props;
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  /** The last text this editor handed out, so its own edits are not echoed back as remote. */
  const sent = useRef(value);
  const version = useRef(0);
  // One store per document path; it loads the host's text as it was when the path opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the value only seeds a new path.
  const store = useMemo<DocumentStore>(() => {
    const opened = value;
    sent.current = value;
    return {
      load: async () => ({ content: opened, etag: "slot:0" }),
      save: async (content) => {
        sent.current = content;
        onChange.current(content);
        version.current += 1;
        return { ok: true, etag: `slot:${version.current}` };
      },
    };
  }, [props.path]);
  const remote = useMemo(() => {
    if (value === sent.current) return undefined;
    sent.current = value;
    version.current += 1;
    return { content: value, etag: `host:${version.current}` };
  }, [value]);
  return (
    <MarkdownEditor
      path={props.path}
      store={store}
      autosaveMs={0}
      chrome="modes"
      {...(remote ? { remote } : {})}
      {...(props.readOnly ? { readOnly: true } : {})}
      {...(props.marks ? { marks: props.marks } : {})}
      {...(props.onMarkActivate ? { onMarkActivate: props.onMarkActivate } : {})}
    />
  );
}
