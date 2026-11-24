import { APPROVAL_TTL_MS, type McpApp } from "@psyche/protocol";
import { AppWindow, ShieldAlert } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useStore } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { useSlots } from "../slots.tsx";

/** An approval card's whole life, plus time for the tool to run after the tap. */
export const MCP_APP_CALL_TIMEOUT_MS = APPROVAL_TTL_MS + 5 * 60_000;

/**
 * An MCP App a connector's tool declares, under that tool's row (generative-ui-2026 P9). The page
 * is the server's own HTML, so it is untrusted: it stays closed until the owner presses Run app,
 * runs only in the artifact sandbox (no network, no storage; the CSP and permissions it declares
 * are not granted) and is framed as "Built from untrusted content", with no approval look. Its one
 * way out is the JSON-RPC bridge: `tools/call` for a tool of its own connector, which the Gateway
 * gates like a model's call (rules, approval card with the taint banner, receipts). It cannot ask
 * for or answer an approval itself.
 */
export function McpAppPanel({
  tool,
  toolCallId,
}: {
  tool: string;
  /** The transcript tool call that showed the app: the Gateway ties the app's calls to its server. */
  toolCallId?: string;
}): ReactElement | null {
  const store = useStore();
  const slots = useSlots();
  const [app, setApp] = useState<McpApp | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    store
      .call("mcp.app", { tool })
      .then((r) => {
        if (live && r.available && r.app !== undefined) setApp(r.app);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [store, tool]);
  const callTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      if (toolCallId === undefined) throw new Error(t("widgets.app.callUnavailable"));
      try {
        // The call can wait on the owner's tap (a card lives APPROVAL_TTL_MS), so it must not time out
        // at the client's 30 s default: the tool would still run and the page never hear.
        return await store.call(
          "mcp.app.call",
          { toolCallId, name, arguments: args },
          { timeoutMs: MCP_APP_CALL_TIMEOUT_MS },
        );
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : t("widgets.app.callFailed"));
      }
    },
    [store, toolCallId],
  );
  if (app === null) return null;
  const title = t("widgets.app.title", { server: app.serverId });
  return (
    <section
      aria-label={title}
      data-testid="mcp-app"
      className="my-1 ms-6 overflow-clip rounded-lg border border-border bg-background text-label-primary"
    >
      <header className="flex min-w-0 items-center gap-2 border-border border-b px-3 py-1.5 text-callout text-label-secondary">
        <AppWindow className="size-3.5 shrink-0" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 truncate font-medium text-label-primary">{title}</h3>
        <span className="inline-flex shrink-0 items-center gap-1" data-testid="mcp-app-untrusted">
          <ShieldAlert className="size-3.5" aria-hidden="true" />
          {t("widgets.app.untrusted")}
        </span>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-0.5 text-accent-11 hover:bg-fill-quaternary"
          aria-expanded={open}
          data-testid="mcp-app-run"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t("widgets.app.hide") : t("widgets.app.run")}
        </button>
      </header>
      <div className="px-3 py-2">
        <p className="text-callout text-label-secondary">{t("widgets.app.note")}</p>
        {open ? (
          slots.renderMcpApp ? (
            <div className="mt-2" data-testid="mcp-app-frame">
              {slots.renderMcpApp({
                html: app.html,
                title,
                ...(toolCallId === undefined ? {} : { callTool }),
              })}
            </div>
          ) : (
            <p className="mt-2 text-callout text-label-secondary">{t("widgets.app.unavailable")}</p>
          )
        ) : null}
      </div>
    </section>
  );
}
