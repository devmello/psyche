import type { EditorSlotProps } from "@psyche/ui";
import { type ComponentProps, lazy, type ReactElement, Suspense } from "react";

/**
 * The viewers load on first use. `@psyche/viewers` brings CodeMirror (with its merge view),
 * Univer, PDF.js and the Office generators; none of it is needed to show the shell, so the
 * startup bundle holds only these thin wrappers and the real modules arrive with the first Files
 * pane, canvas or Markdown editor. The fallback is empty: the panes draw their own loading
 * states once they are in.
 */
const FilesPaneChunk = lazy(async () => ({
  default: (await import("./viewers.tsx")).ComposedFilesPane,
}));

const CanvasChunk = lazy(async () => ({
  default: (await import("./canvas.tsx")).ComposedCanvas,
}));

const MarkdownEditorChunk = lazy(async () => {
  const { renderMarkdownEditor } = await import("./viewers.tsx");
  return { default: (props: EditorSlotProps) => renderMarkdownEditor(props) };
});

export function LazyFilesPane(props: ComponentProps<typeof FilesPaneChunk>): ReactElement {
  return (
    <Suspense fallback={null}>
      <FilesPaneChunk {...props} />
    </Suspense>
  );
}

export function LazyCanvas(props: ComponentProps<typeof CanvasChunk>): ReactElement {
  return (
    <Suspense fallback={null}>
      <CanvasChunk {...props} />
    </Suspense>
  );
}

/** The kit's `renderEditor` slot: the Markdown editor, loaded when a Soul or Memory file opens. */
export function renderLazyMarkdownEditor(props: EditorSlotProps): ReactElement {
  return (
    <Suspense fallback={null}>
      <MarkdownEditorChunk {...props} />
    </Suspense>
  );
}
