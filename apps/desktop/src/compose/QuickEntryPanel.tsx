import { t } from "@psyche/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import type { GatewayStatus } from "../client/index.ts";
import type { ShellPlatform } from "../shell/platform.ts";

/** The Quick Entry window's route. It is served by the small panel entry, not the full app. */
export const QUICK_ENTRY_ROUTE = "/quick";

interface MainThreadList {
  threads?: { thread: { id: string; kind: string } }[];
}

/**
 * Quick Entry as its own small client (panel.html): the status line, the input and the main chat's
 * `chat.send`. It reads the Gateway through the platform port and keeps no store, so the hidden
 * window holds none of the app's threads, messages or streaming text.
 */
export function QuickEntryPanel({ platform }: { platform: ShellPlatform }): ReactElement {
  const gateway = platform.gateway;
  const [status, setStatus] = useState<GatewayStatus | undefined>();
  const [approvals, setApprovals] = useState(0);
  const [mainId, setMainId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const paired = status?.phase === "paired";

  const refresh = useCallback(() => {
    void gateway
      .call("threads.list", { limit: 50 })
      .then((r) => {
        const main = (r as MainThreadList).threads?.find((x) => x.thread.kind === "main");
        if (main) setMainId(main.thread.id);
      })
      .catch(() => undefined);
    void gateway
      .call("approvals.list", {})
      .then((r) => {
        const list = (r as { approvals?: { status: string }[] }).approvals ?? [];
        setApprovals(list.filter((a) => a.status === "pending").length);
      })
      .catch(() => undefined);
  }, [gateway]);

  useEffect(() => {
    void gateway.getStatus().then(setStatus);
    const offStatus = gateway.onStatus(setStatus);
    const offResync = gateway.onResync(refresh);
    // Only approval events matter here; everything else the Gateway says is ignored.
    const offEvent = gateway.onEvent((e) => {
      if (e.event === "approval.created" || e.event === "approval.updated") refresh();
    });
    // The window is kept hidden between uses: refetch each time it comes back.
    const onFocus = () => {
      refresh();
      input.current?.focus();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      offStatus();
      offResync();
      offEvent();
      window.removeEventListener("focus", onFocus);
    };
  }, [gateway, refresh]);

  useEffect(() => {
    if (paired) refresh();
  }, [paired, refresh]);

  const done = () => platform.windows?.closeWindow();
  const send = async () => {
    const content = text.trim();
    if (!content || !mainId) return;
    setText("");
    await gateway.call("chat.send", { threadId: mainId, content }).catch(() => {
      setText(content);
    });
    done();
  };

  return (
    <div className="shell" style={{ gridTemplateColumns: "1fr" }} data-testid="quick-entry">
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 13, color: "var(--shell-muted)" }}>
          {t("web.quickEntry.status", { online: paired, approvals })}
        </div>
        <input
          ref={input}
          // biome-ignore lint/a11y/noAutofocus: the window exists to take this input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
            if (e.key === "Escape") done();
          }}
          disabled={!paired}
          placeholder={t("web.quickEntry.placeholder")}
          aria-label={t("web.quickEntry.label")}
          data-testid="quick-input"
          style={{
            padding: 8,
            borderRadius: 8,
            border: "1px solid var(--shell-border)",
            font: "inherit",
          }}
        />
      </div>
    </div>
  );
}
