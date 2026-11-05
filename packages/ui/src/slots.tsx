import type {
  Artifact,
  LibraryItem,
  MissingPermission,
  Receipt,
  SearchHit,
  Task,
} from "@psyche/protocol";
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from "react";
import type { PreviewSlot } from "./blocks/ArtifactCard.tsx";
import type { TouchIdFix } from "./blocks/answer-error.ts";
import type { ArtifactRenderProps } from "./canvas/CanvasPane.tsx";
import { LinkPromptProvider } from "./links/LinkPrompt.tsx";
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

/** A Gateway this computer can connect to (desktop: `apps/desktop/src/main/gateway-manager.ts`). */
export interface GatewayEntry {
  id: string;
  name: string;
  /** The address; null for This Mac. */
  origin: string | null;
  /** A Gateway on another computer. */
  remote: boolean;
  active: boolean;
  /** Its identity is pinned: the key, or the fingerprint a pairing link named. */
  pinned: boolean;
  /** On the local network, reached over a pinned self-signed certificate. */
  lan?: boolean;
}

/** A Gateway the network announced; a claim, not a proof (desktop: `lib/lan-discovery.ts`). */
export interface DiscoveredGateway {
  id: string;
  name: string;
  /** `sha256:<hex>` it announced for its identity key, or null. */
  fingerprint: string | null;
  /** Announced more than once with different keys: not addable. */
  conflict: boolean;
  saved: boolean;
}

/**
 * The saved Gateways (remote-gateway design §1.3). Switching restarts the app on the other one;
 * adding, forgetting and pairing again are confirmed in a native dialog the window cannot draw.
 * `add` rejects with `invalid_params` and `details.problem` for an address it will not use.
 */
export interface GatewaysSlot {
  list(): Promise<GatewayEntry[]>;
  add(address: string, name?: string): Promise<GatewayEntry>;
  /** Looks for Gateways on the local network; absent where the app cannot (no Bonjour). */
  discover?(): Promise<DiscoveredGateway[]>;
  /** Adds one `discover` returned, by its id: the app never takes an address from here. */
  addDiscovered?(id: string): Promise<GatewayEntry>;
  remove(id: string): Promise<void>;
  switchTo(id: string, opts?: { stopLocal?: boolean }): Promise<void>;
  repair(id: string): Promise<void>;
  /**
   * Adds the Gateway a pasted `psyche-pair:v1` link names (confirmed in a native dialog). Rejects
   * with `invalid_params` and `details.problem` (`link_<problem>` for the link).
   */
  addLink?(link: string): Promise<GatewayEntry>;
  /** A pairing link the OS opened in the app, once; shown in the field, never acted on. */
  takePendingLink?(): Promise<string | null>;
  /** The OS opened a pairing link while the window is open. Returns the unsubscribe. */
  onPendingLink?(cb: () => void): () => void;
}

/**
 * The sandbox PC's one-time setup on Windows, which only the desktop app can do (an elevated
 * service install and the guest image download; apps/desktop `main/sandbox-pc`). Everything after
 * it, creating, starting, snapshots, is the helper's `vm.*` through the Gateway.
 */
export interface SandboxPcState {
  /** `off`: not turned on yet (or the download was cancelled); `ready`: service and image are in place. */
  phase: "unsupported" | "off" | "installing" | "downloading" | "restarting" | "ready" | "failed";
  /** Plain words: why it is unsupported or what went wrong. */
  message?: string;
  serviceInstalled: boolean;
  /** The complete guest image on disk, if any. */
  imageVersion: string | null;
  download?: { receivedBytes: number; totalBytes: number };
  /** The published image's download size, once known. */
  downloadBytes?: number;
  /** What it takes unpacked. */
  diskBytes?: number;
}

export interface SandboxPcSlot {
  getState(): Promise<SandboxPcState>;
  /** Re-reads what is installed and the image size (may use the network). */
  refresh(): Promise<SandboxPcState>;
  /** Installs the service (one administrator prompt), restarts the helper, downloads the image. */
  turnOn(): Promise<SandboxPcState>;
  cancel(): Promise<void>;
  onState(cb: (state: SandboxPcState) => void): () => void;
}

export interface UiSlots {
  /** Windows desktop: turning the sandbox PC on (service install, guest image download). */
  sandboxPc?: SandboxPcSlot;
  /**
   * The name of the Host when this app is a client of a Gateway on another computer. Things that
   * run on the Host say so, and what only works on this Mac stays out (design §4.2).
   */
  remoteHost?: string;
  /** The saved Gateways and the switcher (desktop only). */
  gateways?: GatewaysSlot;
  /** Opens a Settings section (`server`): the host's own window or route. */
  openSettings?: (section: string) => void;
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
  /**
   * A `packages/viewers` body for a canvas artifact (code in CodeMirror, say). Return undefined
   * to keep the kit's own rendering (chat-experience-2026 §4.2).
   */
  renderArtifact?: (props: ArtifactRenderProps) => ReactNode;
  /**
   * An MCP App (a `ui://` page a connector's tool declares) in the artifact sandbox: scripts on,
   * no network, no tool or data channel. Absent where the host has no sandbox: the app is not shown.
   */
  renderMcpApp?: (props: { html: string; title: string }) => ReactNode;
  /** The Markdown editor from `packages/viewers` (Rich / Source / Diff). */
  renderEditor?: (props: EditorSlotProps) => ReactNode;
  /** Writes the system clipboard (the desktop's goes through main; #507). */
  writeClipboard?: (text: string, opts?: { clearAfterMs?: number }) => Promise<void>;
  /** Opens an https page in the system browser (a connector's sign-in; #505). */
  openExternal?: (url: string) => Promise<void>;
  /**
   * Opens the original of a cited source passage outside Psyche from its search document id
   * (desktop: Mail for a message, Finder for a file in a granted folder; the host resolves the
   * target, the kit sends only the id). Resolves to what it opened, "none" when nothing safe
   * could be opened. Absent where the host has no opener: the kit's source viewer is all there is.
   */
  openSource?: (docId: string) => Promise<"mail" | "file" | "none">;
  /**
   * ⌘L or "Open in a side chat" on a search result: a chat about it in a pane beside the current
   * view. Hosts without panes leave it out and the kit opens the chat full screen instead.
   */
  openSideChat?: (hit: SearchHit) => void;
  /** Opens an http(s) page in Psyche's own browser pane (a chat link's "Open in Psyche"). */
  openInPsyche?: (url: string) => Promise<void> | void;
  /**
   * Puts text in the chat composer and shows the chat (Settings → Connectors "Try it", #640).
   * Hosts whose Settings is a separate window supply it; otherwise the kit opens `/chat` itself.
   */
  prefillComposer?: (text: string) => void;
  /**
   * The host's composer dictation (#690): a hook, called with the open
   * thread and a sink for dictated text, that returns their state for the kit to draw.
   */
  useComposerVoice?: UseComposerVoice;
  /**
   * A permission card's fix-it button (security §3.13): `open` goes where the owner fixes it
   * (Connectors, the macOS System Settings pane, the sandbox setup), `check` re-reads macOS
   * access before the card's Check again. The chat's approval dock supplies it. `true` means the
   * owner finished fixing it there (the sandbox setup reported srt ready).
   */
  permissionAction?: (
    need: MissingPermission,
    action: "open" | "check",
  ) => Promise<boolean | undefined> | boolean | undefined;
  /**
   * The desktop's fixes when Touch ID cannot confirm a card from the window: start the bundled
   * Mac helper, or open Settings → Devices (where the owner checks the key id and registers it).
   * Resolves once done; the owner then clicks Allow again (nothing is approved on its own).
   */
  touchIdFix?: (fix: TouchIdFix) => Promise<void>;
  /** The desktop: cards that need Touch ID are approved once only from this window. */
  touchIdOnceOnly?: boolean;
  /**
   * A client of another computer's Gateway (remote-gateway design §6.2): a card that needs Touch
   * ID is approved here only with a passkey made on this computer. Without one the card says
   * "Answer on {host}" and Allow stays off (Deny still works); ordinary cards are unaffected.
   * Absent on This Mac and on the web, which have their own paths.
   */
  remotePresence?: { hostName: string; hasPasskey: boolean };
  /** The host's native folder picker; resolves to the real path, or null when cancelled. */
  pickFolder?: (opts?: { title?: string }) => Promise<string | null>;
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
  return (
    <SlotsContext.Provider value={merged}>
      <LinkPromptProvider>{children}</LinkPromptProvider>
    </SlotsContext.Provider>
  );
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
