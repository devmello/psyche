import type { Message, ScreenCapture, ScreenImageChoice } from "@psyche/protocol";
import {
  GatewayProvider,
  mentionsScreen,
  type ScreenAskAnswer,
  type ScreenAskCaptureView,
  ScreenAskRegionView,
  ScreenAskView,
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

/**
 * The ask panel's renderer (docs/design/screen-ask-2026.md): the desktop opens it on the ask
 * shortcut and says what to capture (`onOpen {mode, rect?}`). This renderer calls `screen.capture`
 * right then (never in the background), shows the chip, takes the request typed or spoken, and
 * sends it with `chat.send.screen` to a new chat or the current one. The answer streams in the
 * panel; Open in Psyche shows the thread. Esc before sending discards the capture.
 */

export const SCREEN_ASK_ROUTE = "/screen-ask";
export const SCREEN_ASK_REGION_ROUTE = "/screen-ask-region";

export type ScreenAskOpen =
  | { mode: "window" }
  | { mode: "region"; rect: { x: number; y: number; width: number; height: number } };

/** What the desktop's ask panel window offers its renderer (preload `screenAsk`). */
export interface ScreenAskBridge {
  onOpen(cb: (open: unknown) => void): () => void;
  done(): void;
  openThread(threadId: string): void;
  resize(height: number): void;
  selectArea(): void;
  region(rect: { x: number; y: number; width: number; height: number } | null): void;
}

export function parseOpen(arg: unknown): ScreenAskOpen | null {
  const a = arg as { mode?: unknown; rect?: Record<string, unknown> } | null;
  if (a?.mode === "window") return { mode: "window" };
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

/** The agent's reply to `messageId`: the text of every agent message after it, or what streams. */
export function answerText(
  messages: readonly Message[],
  messageId: string,
  streaming: readonly { text: string }[],
): string {
  const at = messages.findIndex((m) => m.id === messageId);
  const after = at === -1 ? [] : messages.slice(at + 1).filter((m) => m.role === "agent");
  const done = after
    .flatMap((m) => m.blocks.flatMap((b) => (b.type === "text" ? [b.md] : [])))
    .join("\n\n");
  const live = streaming.map((s) => s.text).join("");
  return [done, live].filter(Boolean).join("\n\n");
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
      <ScreenAskBody platform={platform} {...(bridge ? { bridge } : {})} />
    </GatewayProvider>
  );
}

type Captured =
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

  useEffect(
    () =>
      bridge?.onOpen((arg) => {
        const o = parseOpen(arg);
        if (!o) return;
        setOpen(o);
        // A fresh trigger (window) starts over; a region replaces the capture and keeps the text.
        if (o.mode === "window") {
          setText("");
          setSent(null);
          setFailed(false);
        }
        void capture(o);
      }),
    [bridge, capture],
  );

  const close = useCallback(() => {
    generation.current++;
    if (!sent) discard();
    setOpen(null);
    bridge?.done();
  }, [bridge, discard, sent]);

  const dictation = usePanelDictation(platform, (said) =>
    setText((t) => (t.trim() === "" ? said : `${t.trimEnd()} ${said}`)),
  );

  const thread = useThread(sent?.threadId ?? null);
  const answer: ScreenAskAnswer | undefined = useMemo(() => {
    if (!sent) return undefined;
    if (failed || thread.failedRuns.length > 0) return { status: "failed", text: "" };
    const body = answerText(thread.messages, sent.messageId, thread.streaming);
    return { status: thread.running || body === "" ? "streaming" : "done", text: body };
  }, [sent, failed, thread.messages, thread.streaming, thread.running, thread.failedRuns]);

  const submit = async () => {
    const content = text.trim();
    if (content === "" || sent) return;
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

  if (open === null) return null;
  const view: ScreenAskCaptureView =
    captured.status === "ready"
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
    <ScreenAskView
      capture={view}
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
      {...(sent && sent.threadId !== "" ? { onOpen: () => bridge?.openThread(sent.threadId) } : {})}
      {...(bridge ? { onHeight: (h: number) => bridge.resize(h) } : {})}
    />
  );
}

/** The composer's dictation (the same `VoiceCapture` and engine), as one mic toggle. */
function usePanelDictation(platform: ShellPlatform, onText: (said: string) => void) {
  const [state, setState] = useState<VoiceState>({ phase: "idle" });
  const sink = useRef(onText);
  sink.current = onText;
  const capture = useMemo(
    () =>
      new VoiceCapture((m, p) => platform.gateway.call(m, p), microphoneSource(), setState, {
        onInterrupted: (said) => sink.current(said),
      }),
    [platform],
  );
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
