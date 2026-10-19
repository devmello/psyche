import type { LibraryItem } from "@psyche/protocol";

/** Where content came from. Untrusted content is data, never instructions (docs/05). */
export type Provenance = "trusted" | "untrusted";

/** What a viewer shows: a Library item, a workspace file or an inline attachment. */
export interface ViewerItem {
  /** Stable id (Library item id or workspace path). */
  id: string;
  name: string;
  mime: string;
  size?: number;
  provenance: Provenance;
  /** Opaque version tag for conflict detection (Library sha256 or file mtime+size). */
  etag?: string;
  libraryItem?: LibraryItem;
}

/** Per-viewer position the shell may persist and restore. */
export interface PageState {
  /** 1-based page (PDF, slides). */
  page?: number;
  /** 1 = 100 %. */
  zoom?: number;
  /** Active sheet name (spreadsheets). */
  sheet?: string;
  /** Top visible line (code, text). */
  line?: number;
}

export type ViewerSelection =
  | { kind: "text"; text: string; page?: number }
  | { kind: "cells"; sheet: string; range: string; text: string }
  | { kind: "lines"; from: number; to: number; text: string }
  | { kind: "field"; name: string; page: number };

/** A pane the viewer asks the shell to open (mirrors protocol `view.open`). */
export interface OpenInPaneRequest {
  pane: "browser" | "editor" | "files" | "artifact" | "diff";
  target: string;
}

/** What "Send to chat" attaches to the next message. */
export interface SendToChatPayload {
  itemId: string;
  name: string;
  selection?: ViewerSelection;
  /** Short quoted text, already bounded by the viewer. */
  quote?: string;
}
