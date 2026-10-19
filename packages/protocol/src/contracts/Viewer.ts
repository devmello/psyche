import type { Unsubscribe } from "./Clock.ts";

/**
 * Viewer registry types (architecture §5 viewers, §13; owner S13, consumed by S11 / S12).
 * Viewers register by MIME type (with `type/*` wildcards) and extension. Resolution order:
 * exact MIME → wildcard MIME → extension; ties broken by higher `priority`.
 */

export type ViewerRenderKind =
  | "pdf"
  | "sheet"
  | "document"
  | "slides"
  | "image"
  | "media"
  | "code"
  | "json"
  | "markdown"
  | "email"
  | "artifact"
  | "text";

export interface ViewerSpec {
  id: string;
  label?: string;
  mimeTypes: string[];
  /** Lower-case, without the dot. */
  extensions?: string[];
  canEdit: boolean;
  render: ViewerRenderKind;
  priority?: number;
}

export interface ViewerRegistry {
  register(spec: ViewerSpec): Unsubscribe;
  resolve(mime: string, name?: string): ViewerSpec | undefined;
  list(): ViewerSpec[];
}
