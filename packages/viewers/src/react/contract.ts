import type { ViewerRenderKind } from "@psyche/protocol";
import type { ComponentType } from "react";
import type { ConversionService } from "../core/convert.ts";
import type {
  OpenInPaneRequest,
  PageState,
  SendToChatPayload,
  ViewerItem,
  ViewerSelection,
} from "../core/types.ts";

/**
 * The props every viewer takes (S11 shells and S12 screens render viewers only through this).
 * Content is fetched by the host (`load`), never by the viewer from a URL it chose.
 */
export interface ViewerProps {
  item: ViewerItem;
  /** Returns the file bytes (Library over HTTP, a workspace read, an attachment). */
  load: (signal: AbortSignal) => Promise<Uint8Array>;
  pageState?: PageState;
  onPageStateChange?: (state: PageState) => void;
  onSelectionChange?: (selection: ViewerSelection | null) => void;
  /** "Open in pane": browser for links, editor for files, artifact pane, etc. */
  onOpenInPane?: (request: OpenInPaneRequest) => void;
  /** "Send to chat": attaches the item (and selection) to the next message. */
  onSendToChat?: (payload: SendToChatPayload) => void;
  /** Saves bytes the viewer produced (filled PDF preview, export) to the Library. */
  onSaveToLibrary?: (file: { name: string; mime: string; bytes: Uint8Array }) => void;
  /** Office → PDF/thumbnail conversion (slides); a placeholder shows when absent. */
  conversion?: ConversionService;
  /** Compact rendering for inline chat cards. */
  compact?: boolean;
}

export type ViewerComponent = ComponentType<ViewerProps>;

export type ViewerComponentMap = Partial<Record<ViewerRenderKind, ViewerComponent>>;
