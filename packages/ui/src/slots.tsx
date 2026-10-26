import type { Artifact, LibraryItem, Receipt, Task } from "@psyche/protocol";
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from "react";
import type { PreviewSlot } from "./blocks/ArtifactCard.tsx";
import type { UseComposerVoice } from "./voice/controls.tsx";

/**
 * What the shell plugs into the kit: navigation (routes from UI design §2.7), pane commands and
 * the `packages/viewers` renderers (S13). Every field is optional; the kit degrades to
 * plain-text previews and no-op navigation.
 */
export interface EditorSlotProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  /** Budget meter limit in characters (20k per persona file, 4k for USER.md). */
  budget?: number;
  readOnly?: boolean;
  /**
   * Margin marks beside lines, by line text (the teaching loop's "Learned from you", §5.2). The
   * viewers' `MarkdownEditor` takes them as `marks` / `onMarkActivate`.
   */
  marks?: readonly EditorLineMark[];
  onMarkActivate?: (id: string) => void;
}

/** One margin mark: the line it sits beside (by text) and its tooltip. */
export interface EditorLineMark {
  id: string;
  text: string;
  label: string;
}

export interface UiSlots {
  /** Navigate to an in-app route, e.g. `/agent/activity/<taskId>`. */
  navigate?: (route: string) => void;
  openArtifact?: (artifact: Artifact) => void;
  openLibraryItem?: (item: LibraryItem) => void;
  openTask?: (task: Task) => void;
  openReceipt?: (receipt: Receipt) => void;
  /** Thumbnails and previews from `packages/viewers`. */
  renderPreview?: PreviewSlot;
  /** Option previews and email bodies, rendered in the artifact sandbox. */
  renderSandboxed?: (html: string) => ReactNode;
  /** The Markdown editor from `packages/viewers` (Rich / Source / Diff). */
  renderEditor?: (props: EditorSlotProps) => ReactNode;
  /** Writes the system clipboard (the desktop's goes through main; #507). */
  writeClipboard?: (text: string) => Promise<void>;
  /** Opens an https page in the system browser (a connector's sign-in; #505). */
  openExternal?: (url: string) => Promise<void>;
  /**
   * Puts text in the chat composer and shows the chat (Settings → Connectors "Try it", #640).
   * Hosts whose Settings is a separate window supply it; otherwise the kit opens `/chat` itself.
   */
  prefillComposer?: (text: string) => void;
  /**
   * The host's composer dictation and voice conversation (#690): a hook, called with the open
   * thread and a sink for dictated text, that returns their state for the kit to draw.
   */
  useComposerVoice?: UseComposerVoice;
  /** Persona shown in agent messages and cards. */
  persona?: { name: string; creature?: string; imageSrc?: string };
}

const SlotsContext = createContext<UiSlots>({});

export function UiSlotsProvider({
  value,
  children,
}: {
  value: UiSlots;
  children?: ReactNode;
}): ReactElement {
  const parent = useContext(SlotsContext);
  const merged = useMemo(() => ({ ...parent, ...value }), [parent, value]);
  return <SlotsContext.Provider value={merged}>{children}</SlotsContext.Provider>;
}

export function useSlots(): UiSlots {
  return useContext(SlotsContext);
}

export function usePersona(): { name: string; creature: string; imageSrc?: string } {
  const p = useSlots().persona;
  return {
    name: p?.name ?? "Psyche",
    creature: p?.creature ?? "moth",
    ...(p?.imageSrc === undefined ? {} : { imageSrc: p.imageSrc }),
  };
}
