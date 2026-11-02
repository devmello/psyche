import type { Widget } from "@psyche/protocol";
import { Check, Copy, LayoutPanelTop, Pin, PinOff, ShieldAlert } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useStore } from "../data/index.ts";
import { put } from "../data/state.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { copyText } from "../lib/clipboard.ts";
import { cn } from "../lib/utils.ts";
import { useSlots } from "../slots.tsx";
import { WidgetContext, type WidgetContextValue } from "./context.ts";
import { RenderNode } from "./nodes.tsx";
import { widgetText } from "./text.ts";

/**
 * The host-drawn widget frame (generative-ui-2026 §7.4 layer 3): the spec cannot remove or restyle
 * it. It is deliberately not an approval card: no elevated surface, no shield or lock icon, no
 * amber, normal flow with `contain` so nothing inside can reach the dock or composer. Approvals stay
 * in `ApprovalDock` (docs/05 §3.7).
 */

const ANNOUNCE_MS = 5000;

/** One polite live region per widget, one announcement per 5 s, only when the revision changes. */
function useAnnouncement(widget: Widget): string {
  const [text, setText] = useState("");
  const rev = useRef(widget.rev);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(widget);
  latest.current = widget;
  useEffect(() => {
    if (widget.rev === rev.current) return;
    rev.current = widget.rev;
    const fire = () => {
      last.current = Date.now();
      timer.current = undefined;
      const w = latest.current;
      setText(t("widgets.frame.announce", { title: w.spec.title, summary: w.spec.fallbackText }));
    };
    const wait = ANNOUNCE_MS - (Date.now() - last.current);
    if (wait <= 0) fire();
    else if (timer.current === undefined) timer.current = setTimeout(fire, wait);
  }, [widget.rev]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return text;
}

export default function WidgetView({
  widget,
  surface = "chat",
}: {
  widget: Widget;
  surface?: WidgetContextValue["surface"];
}): ReactElement {
  const store = useStore();
  const { writeClipboard } = useSlots();
  const [copied, setCopied] = useState(false);
  const announcement = useAnnouncement(widget);
  const tainted = widget.taint.length > 0;
  const ctx = useMemo(
    () => ({ threadId: widget.threadId, widgetId: widget.id, tainted, surface }),
    [widget.threadId, widget.id, tainted, surface],
  );
  const live = widget.state === "live";
  const sources = widget.taint
    .map((s) => s.origin ?? s.sender ?? s.sourceKind)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");
  return (
    <section
      aria-label={widget.spec.title}
      data-widget={widget.id}
      data-state={widget.state}
      data-untrusted={tainted ? "true" : undefined}
      data-testid="widget"
      className={cn(
        "my-2 overflow-clip rounded-lg border bg-background text-label-primary [contain:layout_paint]",
        tainted ? "border-untrusted" : "border-border",
      )}
    >
      <header className="flex min-w-0 items-center gap-2 border-border border-b px-3 py-1.5 text-callout text-label-secondary">
        <LayoutPanelTop className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">{t("widgets.frame.madeBy")}</span>
        <h3 className="min-w-0 flex-1 truncate font-medium text-label-primary">
          {widget.spec.title}
        </h3>
        {tainted ? (
          <span
            className="inline-flex shrink-0 items-center gap-1"
            title={t("widgets.frame.untrustedSources", { sources })}
            data-testid="widget-untrusted"
          >
            <ShieldAlert className="size-3.5" aria-hidden="true" />
            {t("widgets.frame.untrusted")}
          </span>
        ) : null}
        <span className="inline-flex shrink-0 items-center gap-1" data-testid="widget-state">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", live ? "bg-label-secondary" : "bg-fill-primary")}
          />
          {surface === "feed"
            ? t("widgets.feed.snapshot")
            : live
              ? t("widgets.frame.live")
              : t("widgets.frame.frozen")}
        </span>
        {surface === "feed" ? null : (
          <button
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-fill-quaternary"
            aria-label={widget.pinned ? t("widgets.frame.unpinHome") : t("widgets.frame.pinHome")}
            aria-pressed={widget.pinned}
            title={widget.pinned ? t("widgets.frame.unpinHome") : t("widgets.frame.pinHome")}
            data-testid="widget-pin"
            onClick={() => {
              store
                .call("widgets.pin", { widgetId: widget.id, pinned: !widget.pinned })
                .then((r) => store.update((s) => put(s, "widgets", r.widget)))
                .catch((err: unknown) => toast.error(describeError(err)));
            }}
          >
            {widget.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-fill-quaternary"
          aria-label={copied ? t("widgets.frame.copied") : t("widgets.frame.copy")}
          title={t("widgets.frame.copy")}
          onClick={() => {
            void copyText(widgetText(widget.spec), writeClipboard).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </header>
      <div className="px-3 py-2.5">
        <WidgetContext.Provider value={ctx}>
          <RenderNode node={widget.spec.root} depth={0} />
        </WidgetContext.Provider>
      </div>
      <div className="sr-only" aria-live="polite" role="status" data-testid="widget-live">
        {announcement}
      </div>
    </section>
  );
}
