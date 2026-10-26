/**
 * @psyche/viewers (S13): viewers, the Markdown editor, the artifact sandbox and text extraction.
 * React components are exported here; `@psyche/viewers/core` has the DOM-free parts.
 */
export * from "./core/index.ts";
export { type LineMark, type LineMarksConfig, lineMarks } from "./core/line-marks.ts";
export { markdownExtensions, richPreview } from "./core/markdown-editor.ts";
export { ArtifactFrame, type ArtifactFrameProps } from "./react/ArtifactFrame.tsx";
export { ArtifactViewer, type ArtifactViewerProps } from "./react/ArtifactViewer.tsx";
export { CodeView, CodeViewer } from "./react/CodeViewer.tsx";
export type { ViewerComponent, ViewerComponentMap, ViewerProps } from "./react/contract.ts";
export { DocumentViewer } from "./react/DocumentViewer.tsx";
export { EmailViewer, type EmailViewerProps } from "./react/EmailViewer.tsx";
export { ImageViewer, MediaViewer } from "./react/ImageViewer.tsx";
export { JsonViewer, parseJsonText } from "./react/JsonViewer.tsx";
export {
  type EditorMode,
  MarkdownEditor,
  type MarkdownEditorProps,
} from "./react/MarkdownEditor.tsx";
export { PdfViewer, type PdfViewerProps } from "./react/PdfViewer.tsx";
export { SheetViewer } from "./react/SheetViewer.tsx";
export { SlidesViewer } from "./react/SlidesViewer.tsx";
export {
  DEFAULT_VIEWER_COMPONENTS,
  ViewerHost,
  type ViewerHostProps,
} from "./react/ViewerHost.tsx";
