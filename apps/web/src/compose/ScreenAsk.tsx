import type { Message, ScreenCapture, ScreenImageChoice } from "@psyche/protocol";
import {
  AppearanceProvider,
  GatewayProvider,
  mentionsScreen,
  readVoiceSettings,
  type ScreenAskAnswer,
  type ScreenAskCaptureView,
  ScreenAskRegionView,
  ScreenAskView,
  t,
  type UiSlots,
  UiSlotsProvider,
  useSettings,
  useStore,
  useThread,
} from "@psyche/ui";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShellPlatform } from "../shell/platform.ts";
import {
  microphoneSource,
  VoiceCapture,
  type VoiceSegment,
  type VoiceState,
} from "../shell/voice.ts";
import { kitClient } from "./kit-client.ts";
import { PushToTalk } from "./push-to-talk.ts";

/**
 * The ask panel's renderer (docs/design/screen-ask-2026.md): the desktop opens it on the ask
 * shortcut and says what to capture (`onOpen {mode, rect?}`). This renderer calls `screen.capture`
 * right then (never in the background), shows the chip, takes the request typed or spoken, and
 * sends it with `chat.send.screen` to a new chat or the current one. The answer streams in the
 * panel; Open in Psyche shows the thread. Esc before sending discards the capture.
 *
 * Voice mode is the voice pop-up (Psyche never speaks): the voice key held in any app opens the
 * panel with no screen context and dictates while held. Letting go finishes the dictation; the
 * words are sent as a plain `chat.send` unless Review before sending
 * (`voice.conversation.reviewBeforeSend`) is on, which leaves them in the input for Return. The
 * answer streams in as text. Holding the key again, even while an answer streams, starts a fresh
 * ask; Esc closes without sending.
 */

export const SCREEN_ASK_ROUTE = "/screen-ask";
export const SCREEN_ASK_REGION_ROUTE = "/screen-ask-region";

export type ScreenAskOpen =
  | { mode: "window" }
  /** Voice mode: no screen context, dictation starts at once. */
  | { mode: "voice" }
  | { mode: "region"; rect: { x: number; y: number; width: number; height: number } };

/** What the desktop's ask panel window offers its renderer (preload `screenAsk`). */
export interface ScreenAskBridge {
  onOpen(cb: (open: unknown) => void): () => void;
  done(): void;
  openThread(threadId: string): void;
  resize(height: number): void;
  selectArea(): void;
  region(rect: { x: number; y: number; width: number; height: number } | null): void;
  /** The voice key going down / up from any app (push-to-talk in voice mode). */
  onVoiceKey?(cb: (down: boolean) => void): () => void;
}

export function parseOpen(arg: unknown): ScreenAskOpen | null {
  const a = arg as { mode?: unknown; rect?: Record<string, unknown> } | null;
  if (a?.mode === "window") return { mode: "window" };
  if (a?.mode === "voice") return { mode: "voice" };
  if (a?.mode === "region" && a.rect) {
    const { x, y, width, height } = a.rect;
    if ([x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)))
      return {
        mode: "region",
        rect: { x, y, width, height } as { x: number; y: number; width: number; height: number },
      };
  }
  return null;
}

/**
 * The agent's reply to `messageId`: every agent message after it, for the chat's block renderer,
 * and the text still streaming in.
 */
export function answerParts(
  messages: readonly Message[],
  messageId: string,
  streaming: readonly { text: string }[],
): { messages: Message[]; streamingText: string } {
  const at = messages.findIndex((m) => m.id === messageId);
  const after = at === -1 ? [] : messages.slice(at + 1).filter((m) => m.role === "agent");
  return { messages: after, streamingText: streaming.map((s) => s.text).join("") };
}

/**
 * What goes with the request (spec §3.3): a pinned or dropped image as chosen; otherwise the
 * image goes when it is a region, the owner always includes it, or the request is about the
 * screen. With `auto` the Gateway sends the text context and the agent can look if it needs to.
 */
export function imageChoice(
  choice: ScreenImageChoice,
  o: { mode: "window" | "region"; always: boolean; text: string },
): ScreenImageChoice {
  if (choice !== "auto") return choice;
  return o.mode === "region" || o.always || mentionsScreen(o.text) ? "pinned" : "auto";
}

export interface ScreenAskProps {
  platform: ShellPlatform;
  bridge?: ScreenAskBridge;
}

export function ScreenAsk({ platform, bridge }: ScreenAskProps): ReactElement {
  const client = useMemo(() => kitClient(platform.gateway), [platform]);
  return (
    <GatewayProvider client={client}>
      {/* This window is its own renderer: without the provider it gets no theme (always light, no
          colour scales), which is what made the panel unreadable. */}
      <AppearanceProvider>
        <ScreenAskBody platform={platform} {...(bridge ? { bridge } : {})} />
      </AppearanceProvider>
    </GatewayProvider>
  );
}

type Captured =
  | { status: "none" }
  | { status: "capturing"; mode: "window" | "region" }
  | { status: "ready"; capture: ScreenCapture }
  | { status: "failed"; mode: "window" | "region" };

function ScreenAskBody({ platform, bridge }: ScreenAskProps): ReactElement | null {
  const store = useStore();
  const [open, setOpen] = useState<ScreenAskOpen | null>(null);
  const [captured, setCaptured] = useState<Captured>({ status: "capturing", mode: "window" });
  const [image, setImage] = useState<ScreenImageChoice>("auto");
  const [text, setText] = useState("");
  const { settings, set: setSetting } = useSettings();
  const destination: "new" | "current" =
    settings["screenAsk.destination"] === "current" ? "current" : "new";
  const alwaysImage = settings["screenAsk.alwaysImage"] === true;
  const review = readVoiceSettings(settings).reviewBeforeSend;
  const [sent, setSent] = useState<{ threadId: string; messageId: string } | null>(null);
  const [failed, setFailed] = useState(false);
  /** The capture to discard if the panel closes unsent. */
  const unsent = useRef<string | null>(null);
  const generation = useRef(0);

  const discard = useCallback(() => {
    const id = unsent.current;
    unsent.current = null;
    if (id) void store.call("screen.discard", { captureId: id }).catch(() => undefined);
  }, [store]);

  const capture = useCallback(
    async (o: ScreenAskOpen) => {
      const gen = ++generation.current;
      discard();
      if (o.mode === "voice") {
        setCaptured({ status: "none" });
        return;
      }
      setCaptured({ status: "capturing", mode: o.mode });
      setImage("auto");
      try {
        const cap = await store.call(
          "screen.capture",
          o.mode === "region" ? o : { mode: "window" },
        );
        if (gen !== generation.current) {
          void store.call("screen.discard", { captureId: cap.captureId }).catch(() => undefined);
          return;
        }
        unsent.current = cap.captureId;
        setCaptured({ status: "ready", capture: cap });
      } catch {
        if (gen === generation.current) setCaptured({ status: "failed", mode: o.mode });
      }
    },
    [store, discard],
  );

  /** What is open now, for the voice key's handler (IPC order: the open comes before the key). */
  const openRef = useRef<ScreenAskOpen | null>(null);
  /** Set on submit (before `sent` renders), cleared by a fresh ask. */
  const sentRef = useRef(false);

  const append = (said: string) =>
    setText((t) => (t.trim() === "" ? said : `${t.trimEnd()} ${said}`));
  /** The voice key was let go: voice mode sends at once unless the owner reviews first. */
  const onDictated = (said: string) => {
    if (openRef.current?.mode === "voice" && !review && !sentRef.current) void submit(said);
    else append(said);
  };
  const dictation = usePanelDictation(platform, append, onDictated);
  const { ptt } = dictation;

  useEffect(
    () =>
      bridge?.onOpen((arg) => {
        const o = parseOpen(arg);
        if (!o) return;
        openRef.current = o;
        setOpen(o);
        // A fresh trigger (window) starts over; a region replaces the capture and keeps the text.
        if (o.mode !== "region") {
          sentRef.current = false;
          setText("");
          setSent(null);
          setFailed(false);
        }
        void capture(o);
        // Voice mode listens at once: the held voice key is what opened it. Started here, in IPC
        // order, so the key's own down is a repeat and its up always finds this dictation.
        if (o.mode === "voice") ptt.down();
      }),
    [bridge, capture, ptt],
  );

  const close = useCallback(() => {
    generation.current++;
    ptt.cancel();
    if (!sent) discard();
    openRef.current = null;
    setOpen(null);
    bridge?.done();
  }, [bridge, discard, sent, ptt]);

  // Push-to-talk: down starts (a fresh ask if one was already sent), up finishes.
  useEffect(
    () =>
      bridge?.onVoiceKey?.((down) => {
        if (!down) {
          ptt.up();
          return;
        }
        if (openRef.current === null || ptt.held) return;
        if (sentRef.current) {
          // Nothing is spoken, so there is nothing to interrupt: the answer stays in its thread.
          const o: ScreenAskOpen = { mode: "voice" };
          openRef.current = o;
          sentRef.current = false;
          generation.current++;
          setCaptured({ status: "none" });
          setText("");
          setSent(null);
          setFailed(false);
          setOpen(o);
        }
        ptt.down();
      }),
    [bridge, ptt],
  );

  const thread = useThread(sent?.threadId ?? null);
  const answer: ScreenAskAnswer | undefined = useMemo(() => {
    if (!sent) return undefined;
    if (failed || thread.failedRuns.length > 0) return { status: "failed", messages: [] };
    const parts = answerParts(thread.messages, sent.messageId, thread.streaming);
    const empty = parts.messages.length === 0 && parts.streamingText === "";
    return { status: thread.running || empty ? "streaming" : "done", ...parts };
  }, [sent, failed, thread.messages, thread.streaming, thread.running, thread.failedRuns]);

  const submit = async (said?: string) => {
    const content = (said ?? text).trim();
    if (content === "" || sentRef.current) return;
    sentRef.current = true;
    if (said !== undefined) setText(said);
    const cap = captured.status === "ready" ? captured.capture : null;
    const choice = cap
      ? imageChoice(image, { mode: cap.mode, always: alwaysImage, text: content })
      : image;
    const newChat = async () =>
      (await store.call("threads.create", { kind: "side", title: content.slice(0, 80) })).thread.id;
    const sendTo = (threadId: string) =>
      store.call("chat.send", {
        threadId,
        content,
        ...(cap && choice !== "dropped"
          ? { screen: { captureId: cap.captureId, image: choice } }
          : {}),
      });
    try {
      let threadId: string;
      if (destination === "current") {
        const { threads } = await store.call("threads.list", { kind: "main" });
        threadId = threads[0]?.thread.id ?? (await newChat());
      } else {
        threadId = await newChat();
      }
      let res: { messageId: string };
      try {
        res = await sendTo(threadId);
      } catch (err) {
        // The current chat is mid-turn: the ask goes to a new chat rather than waiting.
        const e = err as { code?: string; details?: { reason?: string } };
        if (e?.code !== "conflict" || e.details?.reason !== "thread_busy") throw err;
        threadId = await newChat();
        res = await sendTo(threadId);
      }
      // Sent: the capture now belongs to the thread (or was dropped and is discarded here).
      if (image === "dropped") discard();
      unsent.current = null;
      setSent({ threadId, messageId: res.messageId });
    } catch {
      setSent({ threadId: "", messageId: "" });
      setFailed(true);
    }
  };

  // A card's Open lands in the thread in the main window.
  const slots = useMemo<UiSlots>(() => {
    const threadId = sent?.threadId;
    if (!bridge || !threadId) return {};
    const openThread = () => bridge.openThread(threadId);
    return {
      openArtifact: openThread,
      openLibraryItem: openThread,
      openTask: openThread,
      openReceipt: openThread,
    };
  }, [bridge, sent?.threadId]);

  if (open === null) return null;
  const view: ScreenAskCaptureView | undefined =
    captured.status === "none"
      ? undefined
      : captured.status === "ready"
        ? {
            status: "ready",
            mode: captured.capture.mode,
            thumbnail: captured.capture.thumbnail ?? null,
            appName: captured.capture.context?.appName ?? null,
            ...(captured.capture.refusal ? { refusal: captured.capture.refusal } : {}),
            image,
          }
        : { status: captured.status, mode: captured.mode, thumbnail: null, appName: null, image };

  return (
    <UiSlotsProvider value={slots}>
      <ScreenAskView
        {...(view ? { capture: view } : {})}
        {...(open.mode === "voice" ? { placeholder: t("screenAsk.voice.placeholder") } : {})}
        text={text}
        onText={setText}
        onSubmit={() => void submit()}
        onCancel={close}
        onDrop={() => setImage("dropped")}
        onTogglePin={() => setImage((i) => (i === "pinned" ? "auto" : "pinned"))}
        onRecapture={() => void capture(open.mode === "region" ? open : { mode: "window" })}
        onSelectArea={() => bridge?.selectArea()}
        {...(platform.permissions
          ? {
              onAllowCapture: () => {
                void platform.permissions?.request("screenRecording").then(() => capture(open));
              },
            }
          : {})}
        destination={destination}
        onDestination={(d) => void setSetting("screenAsk.destination", d).catch(() => undefined)}
        dictation={dictation}
        {...(answer ? { answer } : {})}
        {...(sent && sent.threadId !== ""
          ? { onOpen: () => bridge?.openThread(sent.threadId) }
          : {})}
        {...(bridge ? { onHeight: (h: number) => bridge.resize(h) } : {})}
      />
    </UiSlotsProvider>
  );
}

/**
 * The composer's dictation (the same `VoiceCapture` and engine), as one mic toggle plus
 * push-to-talk for the voice key. `onText` takes words from the mic button or a session the
 * Gateway ended; `onDictated` takes what push-to-talk heard when the key came up.
 */
function usePanelDictation(
  platform: ShellPlatform,
  onText: (said: string) => void,
  onDictated: (said: string) => void,
) {
  const [state, setState] = useState<VoiceState>({ phase: "idle" });
  const sink = useRef(onText);
  sink.current = onText;
  const dictated = useRef(onDictated);
  dictated.current = onDictated;
  const { capture, ptt } = useMemo(() => {
    let ptt: PushToTalk | undefined;
    const capture = new VoiceCapture(
      (m, p) => platform.gateway.call(m, p),
      microphoneSource(),
      (s) => {
        setState(s);
        ptt?.onState(s);
      },
      { onInterrupted: (said) => sink.current(said) },
    );
    ptt = new PushToTalk(capture, (said) => dictated.current(said));
    return { capture, ptt };
  }, [platform]);
  useEffect(() => {
    const off = platform.gateway.onEvent((e) => {
      const p = e.payload as { sessionId?: string; segment?: VoiceSegment; reason?: string };
      if (typeof p?.sessionId !== "string") return;
      if (e.event === "voice.segment" && typeof p.segment?.text === "string")
        capture.onSegment(p.sessionId, p.segment);
      else if (e.event === "voice.ended" && typeof p.reason === "string")
        capture.onEnded(p.sessionId, p.reason);
    });
    return () => {
      off();
      capture.cancel();
    };
  }, [platform, capture]);
  return {
    phase: state.phase,
    ...("partial" in state ? { partial: state.partial } : {}),
    ...(state.phase === "unavailable" ? { reason: state.reason } : {}),
    ptt,
    toggle: () => {
      if (state.phase === "listening")
        void capture.stop().then((said) => {
          if (said) sink.current(said);
        });
      else void capture.start();
    },
  };
}

/** The region overlay's renderer: the dragged box goes back to main in overlay CSS px. */
export function ScreenAskRegion({ bridge }: { bridge?: ScreenAskBridge }): ReactElement {
  return <ScreenAskRegionView onDone={(rect) => bridge?.region(rect)} />;
}
