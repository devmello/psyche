import type { CompactionResult, ContextLimits, Message } from "@psyche/protocol";
import { type ReactElement, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  GatewayRequestError,
  loadOlderMessages,
  useStore,
  useStoreState,
  useThreadContext,
} from "../../data/index.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { usePersona } from "../../slots.tsx";
import { CompactionMarker } from "./CompactionMarker.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import {
  type CompactionBlock,
  compactionView,
  formatTokens,
  limitFromLabel,
  usageView,
} from "./types.ts";

/**
 * The context UI bound to the Gateway (agent-core's context protocol, docs/archive/status/s02.md): the
 * header meter, "Compact now", this chat's own limits and the compaction markers.
 */

/** Runs "Compact now" and says how it went in a toast: compacted, nothing to compact, or busy. */
export async function compactWithToast(
  compact: () => Promise<CompactionResult | null>,
): Promise<void> {
  try {
    const c = await compact();
    if (c === null) toast(t("context.compact.nothing"));
    else
      toast(
        t("context.compact.done", {
          turns: c.replacedTurns,
          before: formatTokens(c.tokensBefore),
          after: formatTokens(c.tokensAfter),
        }),
      );
  } catch (err) {
    toast.error(
      err instanceof GatewayRequestError && err.code === "conflict"
        ? t("context.compact.busy")
        : t("context.compact.failed", { reason: describeError(err) }),
    );
  }
}

/** The header's context meter; nothing until the thread's first turn reports its usage. */
export function ThreadContextMeter({
  threadId,
  onEditLimits,
}: {
  threadId: string;
  onEditLimits?: () => void;
}): ReactElement | null {
  const { usage, limits, compact, compacting } = useThreadContext(threadId);
  // Nothing before the first turn, or from a Gateway without the context methods.
  if (!usage?.limits) return null;
  return (
    <ContextMeter
      usage={usageView(usage, limits)}
      onCompact={() => void compactWithToast(compact)}
      compacting={compacting}
      {...(onEditLimits ? { onEditLimits } : {})}
    />
  );
}

const BOUNDS = {
  maxTokens: { min: 1_000 },
  compactAt: { min: 20, max: 95 },
  keepRecentTurns: { min: 1, max: 20 },
} as const;

type Drafts = Record<keyof ContextLimits, string>;

const draftsOf = (l: ContextLimits | undefined): Drafts => ({
  maxTokens: l?.maxTokens === undefined ? "" : String(l.maxTokens),
  compactAt: l?.compactAt === undefined ? "" : String(Math.round(l.compactAt * 100)),
  keepRecentTurns: l?.keepRecentTurns === undefined ? "" : String(l.keepRecentTurns),
});

/** Parses the drafts: blank follows Settings; anything else must be a whole number in bounds. */
export function parseLimitDrafts(
  d: Drafts,
  contextWindow: number | undefined,
): { limits: ContextLimits; errors: Partial<Drafts> } {
  const limits: ContextLimits = {};
  const errors: Partial<Drafts> = {};
  const whole = (raw: string, min: number, max: number) => {
    const n = Number(raw.replaceAll(",", "").trim());
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  if (d.maxTokens.trim()) {
    const max = contextWindow ?? Number.MAX_SAFE_INTEGER;
    const n = whole(d.maxTokens, BOUNDS.maxTokens.min, max);
    if (n === null)
      errors.maxTokens = contextWindow
        ? t("context.limits.errorWindow", { min: BOUNDS.maxTokens.min, max: contextWindow })
        : t("context.limits.errorMin", { min: BOUNDS.maxTokens.min });
    else limits.maxTokens = n;
  }
  if (d.compactAt.trim()) {
    const n = whole(d.compactAt, BOUNDS.compactAt.min, BOUNDS.compactAt.max);
    if (n === null)
      errors.compactAt = t("context.limits.errorRange", {
        min: BOUNDS.compactAt.min,
        max: BOUNDS.compactAt.max,
      });
    else limits.compactAt = n / 100;
  }
  if (d.keepRecentTurns.trim()) {
    const n = whole(d.keepRecentTurns, BOUNDS.keepRecentTurns.min, BOUNDS.keepRecentTurns.max);
    if (n === null)
      errors.keepRecentTurns = t("context.limits.errorRange", {
        min: BOUNDS.keepRecentTurns.min,
        max: BOUNDS.keepRecentTurns.max,
      });
    else limits.keepRecentTurns = n;
  }
  return { limits, errors };
}

function LimitField({
  label,
  description,
  placeholder,
  suffix,
  value,
  error,
  onChange,
}: {
  label: string;
  description: string;
  placeholder: string;
  suffix: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <p id={`${id}-desc`} className="text-xs text-muted-foreground">
        {description}
      </p>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          className="w-36"
          value={value}
          placeholder={placeholder}
          aria-describedby={`${id}-desc${error ? ` ${id}-error` : ""}`}
          aria-invalid={error !== undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="text-sm text-muted-foreground">{suffix}</span>
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * This chat's own context limits (`threads.setContextLimits`). A blank field follows Settings
 * (its placeholder shows the value in effect); "Follow Settings" clears the override.
 */
export function ThreadContextDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const ctx = useThreadContext(open ? threadId : null);
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(ctx.threadLimits));
  const [errors, setErrors] = useState<Partial<Drafts>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const own = ctx.threadLimits;
  useEffect(() => {
    if (!open) return;
    setDrafts(draftsOf(own));
    setErrors({});
    setFailure(null);
  }, [open, own]);
  const eff = ctx.limits;
  const contextWindow = eff?.contextWindow;
  const save = async (limits: ContextLimits | null) => {
    setSaving(true);
    setFailure(null);
    try {
      await ctx.setLimits(limits);
      onOpenChange(false);
      toast(limits === null ? t("context.limits.followingSettings") : t("context.limits.saved"));
    } catch (err) {
      setFailure(describeError(err));
    } finally {
      setSaving(false);
    }
  };
  const submit = () => {
    const { limits, errors: next } = parseLimitDrafts(drafts, contextWindow);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void save(Object.keys(limits).length === 0 ? null : limits);
  };
  const set = (k: keyof Drafts) => (v: string) => setDrafts((d) => ({ ...d, [k]: v }));
  // A blank field shows the value in effect now.
  const inherited = (k: keyof Drafts) =>
    eff === undefined
      ? ""
      : k === "compactAt"
        ? String(Math.round(eff.compactAt * 100))
        : String(eff[k]);
  const hasOwn = own !== undefined && Object.keys(own).length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("context.limits.title")}</DialogTitle>
            <DialogDescription>
              {eff
                ? t("context.limits.now", {
                    max: eff.maxTokens,
                    from: limitFromLabel(eff.maxTokensFrom),
                    window: contextWindow ? activeI18n().number(contextWindow) : "none",
                  })
                : t("context.limits.blankFollows")}
            </DialogDescription>
          </DialogHeader>
          <LimitField
            label={t("context.limits.maxTokens")}
            description={t("context.limits.maxTokensHint")}
            placeholder={inherited("maxTokens")}
            suffix={t("context.limits.tokens")}
            value={drafts.maxTokens}
            error={errors.maxTokens}
            onChange={set("maxTokens")}
          />
          <LimitField
            label={t("context.limits.compactAt")}
            description={t("context.limits.compactAtHint")}
            placeholder={inherited("compactAt")}
            suffix={t("context.limits.percentOfLimit")}
            value={drafts.compactAt}
            error={errors.compactAt}
            onChange={set("compactAt")}
          />
          <LimitField
            label={t("context.limits.keep")}
            description={t("context.limits.keepHint")}
            placeholder={inherited("keepRecentTurns")}
            suffix={t("context.limits.turns")}
            value={drafts.keepRecentTurns}
            error={errors.keepRecentTurns}
            onChange={set("keepRecentTurns")}
          />
          {failure ? (
            <p role="alert" className="text-sm text-danger-text">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            {hasOwn ? (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => void save(null)}
              >
                {t("context.limits.followSettings")}
              </Button>
            ) : null}
            <Button type="submit" disabled={saving}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const excerpt = (m: Message) =>
  m.blocks
    .map((b) => (b.type === "text" ? b.md : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** The most history pages "Show what was replaced" loads looking for the first replaced turn. */
const MAX_PAGES = 20;

/**
 * A compaction block in its system message: the marker, and on request the turns it replaced
 * (they stay in the transcript; older pages load until the range's first message is in).
 */
export function CompactionMessage({
  message,
  block,
}: {
  message: Message;
  block: CompactionBlock;
}): ReactElement {
  const persona = usePersona();
  const store = useStore();
  const threadId = message.threadId;
  const messages = useStoreState((s) => s.messages[threadId]);
  const [state, setState] = useState<"idle" | "loading" | "shown">("idle");
  const { fromMessageId, toMessageId } = block.replaced;
  const showReplaced = async () => {
    setState("loading");
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const loaded = store.getState().messages[threadId] ?? [];
        if (fromMessageId === null || loaded.some((m) => m.id === fromMessageId)) break;
        if (!(await loadOlderMessages(store, threadId))) break;
      }
    } catch {
      // Whatever loaded is shown; the rest stays above in the transcript.
    } finally {
      setState("shown");
    }
  };
  let replaced: ReactElement | undefined;
  if (state === "shown") {
    const all = messages ?? [];
    const from = fromMessageId === null ? 0 : all.findIndex((m) => m.id === fromMessageId);
    const to = toMessageId === null ? -1 : all.findIndex((m) => m.id === toMessageId);
    const turns =
      to < 0 ? [] : all.slice(Math.max(0, from), to + 1).filter((m) => m.role !== "system");
    replaced =
      turns.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("context.marker.notLoaded")}</p>
      ) : (
        <ol
          aria-label={t("context.marker.replacedList")}
          className="flex flex-col gap-1.5 border-s-2 border-gray-6 ps-2"
        >
          {turns.map((m) => (
            <li key={m.id} className="text-sm">
              <span className="font-medium">
                {t("context.marker.speaker", {
                  name: m.role === "user" ? t("common.you") : persona.name,
                })}{" "}
              </span>
              <span className="line-clamp-3 text-muted-foreground">
                {excerpt(m) || t("common.noText")}
              </span>
            </li>
          ))}
        </ol>
      );
  }
  return (
    <CompactionMarker
      compaction={compactionView(block, message.createdAt)}
      onShowReplaced={() => void showReplaced()}
      loadingReplaced={state === "loading"}
      {...(replaced ? { replaced } : {})}
    />
  );
}
