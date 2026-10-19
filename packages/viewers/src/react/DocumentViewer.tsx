import { useState } from "react";
import { docxToHtml } from "../core/docx.ts";
import { sanitizeEmailHtml } from "../core/email.ts";
import { ArtifactFrame } from "./ArtifactFrame.tsx";
import type { ViewerProps } from "./contract.ts";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

type Mode = "layout" | "text";

/**
 * Renders a DOCX with docx-preview (layout) into a detached container, then sanitizes the
 * result. Images are inlined as data: URLs so the sandboxed frame can show them.
 */
export async function docxLayoutHtml(bytes: Uint8Array): Promise<string> {
  const { renderAsync } = await import("docx-preview");
  const body = document.createElement("div");
  const styles = document.createElement("div");
  await renderAsync(bytes.slice(), body, styles, {
    inWrapper: true,
    ignoreLastRenderedPageBreak: true,
    useBase64URL: true,
    renderComments: false,
    experimental: false,
  });
  return `${styles.innerHTML}${body.innerHTML}`;
}

/**
 * DOCX viewer (P4): Layout (docx-preview, looks like Word) and Text (mammoth, semantic HTML)
 * modes. Documents are untrusted, so either rendering is sanitized and shown in the artifact
 * sandbox with scripts off; if the layout renderer fails, the Text mode is the fallback.
 */
export function DocumentViewer(props: ViewerProps & { artifactHostUrl?: string }) {
  const [mode, setMode] = useState<Mode>("layout");
  const state = useLoadable(`${props.item.id}:${mode}`, async (signal) => {
    const bytes = await props.load(signal);
    let html: string;
    let fellBack = false;
    if (mode === "layout") {
      try {
        html = await docxLayoutHtml(bytes);
      } catch {
        html = (await docxToHtml(bytes)).html;
        fellBack = true;
      }
    } else html = (await docxToHtml(bytes)).html;
    return { html: sanitizeEmailHtml(html).html, fellBack };
  });
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This document could not be opened"
        detail={state.error.message}
      />
    );
  return (
    <div className="psy-docx">
      <Toolbar label="Document">
        <fieldset className="psy-segmented" aria-label="View">
          {(["layout", "text"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "layout" ? "Layout" : "Text"}
            </button>
          ))}
        </fieldset>
        {state.status === "ready" && state.value.fellBack ? (
          <span role="note">Layout view unavailable; showing text</span>
        ) : null}
        {props.onSendToChat ? (
          <button
            type="button"
            onClick={() => props.onSendToChat?.({ itemId: props.item.id, name: props.item.name })}
          >
            Send to chat
          </button>
        ) : null}
      </Toolbar>
      {state.status === "loading" ? (
        <ViewerMessage kind="loading" title={`Opening ${props.item.name}…`} />
      ) : (
        <ArtifactFrame
          title={props.item.name}
          html={state.value.html}
          policy={{ allowScripts: false }}
          {...(props.artifactHostUrl === undefined ? {} : { hostUrl: props.artifactHostUrl })}
          onOpenLink={(href) => props.onOpenInPane?.({ pane: "browser", target: href })}
          minHeight={400}
        />
      )}
    </div>
  );
}
