import type { McpApp } from "@psyche/protocol";
import { AppWindow, ShieldAlert } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { useStore } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { useSlots } from "../slots.tsx";

/**
 * An MCP App a connector's tool declares, under that tool's row (generative-ui-2026 P9). The page
 * is the server's own HTML, so it is untrusted: it stays closed until the owner presses Run app,
 * runs only in the artifact sandbox (no network, no tool channel, no storage; the CSP and
 * permissions it declares are not granted) and is framed as "Built from untrusted content", with
 * no approval look. It has no way to call a tool or ask for an approval: nothing it posts reaches
 * the Gateway.
 */
export function McpAppPanel({ tool }: { tool: string }): ReactElement | null {
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
              {slots.renderMcpApp({ html: app.html, title })}
            </div>
          ) : (
            <p className="mt-2 text-callout text-label-secondary">{t("widgets.app.unavailable")}</p>
          )
        ) : null}
      </div>
    </section>
  );
}
