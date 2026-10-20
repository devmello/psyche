import type { ApprovalRequest, Message, PermissionMode, Thread } from "@psyche/protocol";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShell, useShellState } from "../context.tsx";
import {
  microphoneSource,
  VoiceCapture,
  type VoiceSegment,
  type VoiceState,
  webSpeechDictation,
} from "../voice.ts";

export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "balanced", "auto", "plan"];

/** Slash commands the composer always knows (docs/06 §3.2); the Gateway may add more. */
export const BUILTIN_COMMANDS = [
  { name: "model", description: "Pick the model for this thread" },
  { name: "schedule", description: "Schedule a task or reminder" },
  { name: "forget", description: "Forget something Psyche remembered" },
  { name: "incognito", description: "Start an incognito side chat" },
] as const;

export interface SlashCommand {
  name: string;
  description: string;
}

/** Commands whose name starts with what follows a leading "/" (no match once a space is typed). */
export function matchCommands(text: string, all: readonly SlashCommand[]): SlashCommand[] {
  const m = /^\/([a-z0-9-]*)$/i.exec(text);
  if (!m) return [];
  const prefix = (m[1] ?? "").toLowerCase();
  return all.filter((c) => c.name.startsWith(prefix)).slice(0, 8);
}

function messageText(m: Message): string {
  return m.blocks
    .map((b) => (b.type === "text" ? b.md : b.type === "tool_call" ? "" : `[${b.type}]`))
    .filter(Boolean)
    .join("\n");
}

function MessageRow({ m }: { m: Message }): ReactElement {
  const text = messageText(m);
  const cls = m.role === "user" ? "msg-user" : m.role === "system" ? "msg-system" : "msg-agent";
  return (
    <div className={cls} data-role={m.role} data-testid="message">
      {text}
    </div>
  );
}

function useCountdown(expiresAt: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Approval dock above the composer (docs/06 §3.3): host-rendered, Deny left / Allow right,
 * Deny preselected, buttons disabled for 400 ms, ⌘Return approves and ⌘D denies (handled in
 * ShellApp). S12 ships the full card; this is the structural stand-in with the same rules.
 */
export function ApprovalDock({ approval }: { approval: ApprovalRequest }): ReactElement {
  const { store } = useShell();
  const [armed, setArmed] = useState(false);
  const [scope, setScope] = useState(approval.scopesOffered[0] ?? "once");
  const countdown = useCountdown(approval.expiresAt);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm the 400 ms delay per approval
  useEffect(() => {
    setArmed(false);
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, [approval.id]);
  const answer = (decision: "approve" | "deny") =>
    void store
      .answerApproval(approval.id, decision, decision === "approve" ? scope : undefined)
      .catch(() => store.toast("Psyche couldn't send that answer. The card stays open.", "error"));
  return (
    <fieldset
      className="dock"
      aria-labelledby={`ap-${approval.id}`}
      data-testid="approval-dock"
      data-approval-id={approval.id}
    >
      <div style={{ display: "flex", gap: 8 }}>
        <strong id={`ap-${approval.id}`} tabIndex={-1} style={{ flex: 1 }}>
          Approval needed · {approval.summary}
        </strong>
        <span title="Expires in">{countdown}</span>
      </div>
      <fieldset
        style={{
          border: 0,
          padding: "8px 0",
          margin: 0,
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {approval.scopesOffered.map((s) => (
          <label key={s}>
            <input
              type="radio"
              name={`scope-${approval.id}`}
              checked={scope === s}
              onChange={() => setScope(s)}
            />{" "}
            {s === "once"
              ? "Allow once"
              : s === "task"
                ? "Allow for this task"
                : s === "site"
                  ? "Allow for this site"
                  : s === "always"
                    ? "Always allow"
                    : s}
          </label>
        ))}
      </fieldset>
      <div style={{ fontSize: 12, color: "var(--shell-muted)" }}>
        Binding {approval.bindingHash.slice(0, 15)}… any change voids this card
      </div>
      <div className="row">
        <button type="button" disabled={!armed} onClick={() => answer("deny")} data-action="deny">
          Deny
        </button>
        <button
          type="button"
          disabled={!armed}
          onClick={() => answer("approve")}
          data-action="approve"
        >
          Allow with scope
        </button>
      </div>
    </fieldset>
  );
}

interface QueuedItem {
  messageId: string;
  content: string;
}

export function Composer(props: {
  thread: Thread | null;
  disabled: boolean;
  running: boolean;
  onModeCycle: () => void;
  focusToken: number;
}): ReactElement {
  const { store } = useShell();
  const unavailable = useShellState((s) => s.unavailable);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>(() => [...BUILTIN_COMMANDS]);
  const [sel, setSel] = useState(0);
  const [voice, setVoice] = useState<VoiceState>({ phase: "idle" });
  const ref = useRef<HTMLTextAreaElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pushToTalk = useRef(false);
  const threadId = props.thread?.id ?? null;

  const capture = useMemo(() => {
    const local = webSpeechDictation();
    return new VoiceCapture((m, p) => store.call(m, p), microphoneSource(), setVoice, {
      ...(local ? { local } : {}),
      onInterrupted: (said) => setText((t) => (t ? `${t} ${said}` : said)),
    });
  }, [store]);

  useEffect(() => {
    void store
      .call<{ commands: SlashCommand[] }>("commands.list", {})
      .then((r) => {
        if (r?.commands) {
          const names = new Set<string>(BUILTIN_COMMANDS.map((c) => c.name));
          setCommands([...BUILTIN_COMMANDS, ...r.commands.filter((c) => !names.has(c.name))]);
        }
      })
      .catch(() => undefined);
  }, [store]);

  useEffect(() => {
    if (props.focusToken > 0) ref.current?.focus();
  }, [props.focusToken]);

  useEffect(() => {
    const off = store.tap((e) => {
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
  }, [store, capture]);

  const suggestions = matchCommands(text, commands);

  const send = async () => {
    const content = text.trim();
    if (!content || !threadId || props.disabled) return;
    if (files.length > 0 && !unavailable.includes("library.upload")) {
      // Uploads go to the Library first; the Gateway has no upload method yet (requested from S01).
      store.toast("Attachments can't be uploaded yet; sending the text only.", "warn");
    }
    setText("");
    setFiles([]);
    try {
      const res = (await store.call<{ messageId: string; queued: boolean }>("chat.send", {
        threadId,
        content,
      })) ?? { messageId: "", queued: false };
      if (res.queued) setQueue((q) => [...q, { messageId: res.messageId, content }]);
    } catch {
      setText(content);
      store.toast("Psyche couldn't send that message. It's back in the composer.", "error");
    }
  };

  const removeQueued = (messageId: string) => {
    setQueue((q) => q.filter((i) => i.messageId !== messageId));
    if (threadId)
      void store.call("chat.queue.remove", { threadId, messageId }).catch(() => undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel(
          (s) => (s + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        setText(`/${suggestions[sel]?.name ?? ""} `);
        setSel(0);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void send();
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((f) => [...f, ...Array.from(list)].slice(0, 32));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  };
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };

  const finishVoice = async () => {
    const said = await capture.stop();
    if (said) setText((t) => (t ? `${t} ${said}` : said));
  };
  const micDown = () => {
    holdTimer.current = setTimeout(() => {
      pushToTalk.current = true;
      void capture.start(threadId ?? undefined);
    }, 300);
  };
  const micUp = () => {
    clearTimeout(holdTimer.current);
    if (pushToTalk.current) {
      pushToTalk.current = false;
      void finishVoice();
      return;
    }
    if (voice.phase === "listening") void finishVoice();
    else void capture.start(threadId ?? undefined);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target for attachments
    <div
      className="composer"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      data-testid="composer"
    >
      {queue.length > 0 ? (
        <ul className="chips" aria-label="Follow-up queue" data-testid="follow-up-queue">
          {queue.map((q) => (
            <li key={q.messageId} className="chip">
              Queued: “{q.content.slice(0, 40)}” (followUp){" "}
              <button
                type="button"
                aria-label="Remove from queue"
                onClick={() => removeQueued(q.messageId)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul className="chips" aria-label="Attachments">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${f.lastModified}`} className="chip">
              {f.name}{" "}
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {suggestions.length > 0 ? (
        <div
          className="suggest"
          role="listbox"
          aria-label="Commands"
          data-testid="slash-suggestions"
        >
          {suggestions.map((c, i) => (
            <div key={c.name} role="option" tabIndex={-1} aria-selected={i === sel}>
              /{c.name} <span style={{ color: "var(--shell-muted)" }}>{c.description}</span>
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        ref={ref}
        value={
          (voice.phase === "listening" || voice.phase === "finishing") && voice.partial
            ? `${text} ${voice.partial}`.trim()
            : text
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        disabled={props.disabled}
        placeholder={props.disabled ? "Psyche can't reach the Gateway" : "Message Psyche…"}
        aria-label="Message"
        data-testid="composer-input"
      />
      <div className="bar">
        <label className="pill">
          +
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => addFiles(e.target.files)}
            aria-label="Attach files"
          />
        </label>
        <span className="grow" style={{ fontSize: 12, color: "var(--shell-muted)" }}>
          {voice.phase === "unavailable"
            ? voice.reason
            : voice.phase === "listening"
              ? "Listening…"
              : ""}
        </span>
        <button
          type="button"
          className="pill"
          aria-pressed={voice.phase === "listening"}
          onPointerDown={micDown}
          onPointerUp={micUp}
          title="Dictate: click to toggle, hold to talk"
          data-testid="mic"
        >
          mic
        </button>
        {props.running ? (
          <button
            type="button"
            className="pill"
            onClick={() => threadId && void store.call("chat.cancel", { threadId })}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="pill"
            onClick={() => void send()}
            disabled={props.disabled}
            data-testid="send"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

export function ChatView(props: {
  thread: Thread | null;
  onModeCycle: () => void;
  onModelPicker: () => void;
  focusToken: number;
}): ReactElement {
  const { store } = useShell();
  const status = useShellState((s) => s.status);
  const messages = useShellState((s) => (props.thread ? s.messages[props.thread.id] : undefined));
  const streaming = useShellState((s) => s.streaming);
  const approvals = useShellState((s) => s.approvals);
  const threadId = props.thread?.id;

  useEffect(() => {
    if (threadId) void store.loadHistory(threadId);
  }, [store, threadId]);

  const live = Object.entries(streaming).filter(([, v]) => v.threadId === threadId);
  const dock = approvals.filter(
    (a) => a.requestedBy.threadId === threadId || a.requestedBy.threadId === null,
  );
  const offline = status.phase !== "paired";
  return (
    <section className="chat" aria-label="Chat" data-testid="chat">
      <header>
        <strong>
          {props.thread
            ? props.thread.kind === "main"
              ? "Main chat"
              : props.thread.title
            : "Psyche"}
        </strong>
        <span className="grow" />
        <button
          type="button"
          className="pill"
          onClick={props.onModeCycle}
          title="Permission mode (⌘⇧M)"
          data-testid="mode-pill"
        >
          {props.thread?.permissionMode ?? "balanced"}
        </button>
        <button
          type="button"
          className="pill"
          onClick={props.onModelPicker}
          title="Model (⌘⇧I)"
          data-testid="model-pill"
        >
          {props.thread?.modelRef ?? "default model"}
        </button>
      </header>
      <div className="messages" aria-live="polite">
        {(messages ?? []).map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
        {live.map(([id, v]) => (
          <div key={id} className="msg-agent" data-testid="streaming">
            {v.text}
          </div>
        ))}
        {!props.thread ? (
          <p className="msg-system">Psyche is getting your main chat ready.</p>
        ) : null}
      </div>
      {dock.slice(-1).map((a) => (
        <ApprovalDock key={a.id} approval={a} />
      ))}
      <Composer
        thread={props.thread}
        disabled={offline}
        running={props.thread?.activeWriterRunId != null}
        onModeCycle={props.onModeCycle}
        focusToken={props.focusToken}
      />
    </section>
  );
}

/**
 * Quick entry (docs/06 §3.21): a one-line composer into the main chat in a frameless window on
 * a global hotkey. A pending approval is only a link to the full card, never answered here.
 */
export function QuickEntry(props: { thread: Thread | null; onDone: () => void }): ReactElement {
  const { store } = useShell();
  const status = useShellState((s) => s.status);
  const approvals = useShellState((s) => s.approvals.length);
  const [text, setText] = useState("");
  const send = async () => {
    const content = text.trim();
    if (!content || !props.thread) return;
    setText("");
    await store.call("chat.send", { threadId: props.thread.id, content }).catch(() => {
      setText(content);
      store.toast("Psyche couldn't send that message.", "error");
    });
    props.onDone();
  };
  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 13, color: "var(--shell-muted)" }}>
        Psyche · {status.phase === "paired" ? "main chat" : "offline"}
        {approvals > 0 ? ` · ${approvals} approval${approvals > 1 ? "s" : ""} waiting` : ""}
      </div>
      <input
        // biome-ignore lint/a11y/noAutofocus: the window exists to take this input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void send();
          if (e.key === "Escape") props.onDone();
        }}
        disabled={status.phase !== "paired"}
        placeholder="Ask or tell Psyche…"
        aria-label="Quick entry"
        data-testid="quick-input"
        style={{
          padding: 8,
          borderRadius: 8,
          border: "1px solid var(--shell-border)",
          font: "inherit",
        }}
      />
    </div>
  );
}
