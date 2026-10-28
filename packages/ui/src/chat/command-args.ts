/**
 * Slash-command arguments with a known set of values (`/model `, `/mode `, `/export `): a command
 * declares `args: { kind: "enum", options }` and the composer shows a popup of the values above
 * the field. Free-text commands declare nothing and keep their plain behaviour. A new command
 * with a fixed set of values gets the popup by adding the declaration, with no composer change.
 */

import type { ModelProviderSummary, ModelRoles, PermissionMode } from "@psyche/protocol";
import { t } from "../i18n/core.ts";

/** One value a command takes. */
export interface ArgOption {
  /** What the command receives (`anthropic/claude-sonnet-5-5`, `balanced`). */
  readonly value: string;
  /** The row's main text; defaults to the value. */
  readonly label?: string;
  /** A short secondary line: the provider, a mode's one-line description. */
  readonly detail?: string;
  /** Short tags after the label ("Vision", "Auto-capable"). */
  readonly badges?: readonly string[];
  /** Present when the value cannot be used now: the reason, shown in place of the detail. */
  readonly disabledReason?: string;
}

/** What the sources read: the Gateway data the chat column already holds, no extra calls. */
export interface ArgContext {
  /** `models.list`, once loaded. */
  readonly models: { providers: readonly ModelProviderSummary[]; roles: ModelRoles } | undefined;
  /** The thread's pinned model; null when it follows the router's primary. */
  readonly modelRef: string | null;
  readonly permissionMode: PermissionMode | undefined;
}

export interface EnumArgs {
  readonly kind: "enum";
  /** The valid values. A promise is awaited once the popup opens; see {@link memoizeOptions}. */
  readonly options: (ctx: ArgContext) => Promise<readonly ArgOption[]> | readonly ArgOption[];
  /** The value in effect now, marked in the list. */
  readonly current?: (ctx: ArgContext) => string | null | undefined;
}

export type ArgSpec = EnumArgs;

/**
 * Wraps an async source so it loads once per session: the popup opens often and a slow source
 * must not be asked again each time. A failed load is dropped so the next open retries.
 */
export function memoizeOptions<A extends unknown[]>(
  load: (...args: A) => Promise<readonly ArgOption[]>,
): (...args: A) => Promise<readonly ArgOption[]> {
  let cached: Promise<readonly ArgOption[]> | undefined;
  return (...args) => {
    if (cached === undefined) {
      cached = load(...args);
      cached.catch(() => {
        cached = undefined;
      });
    }
    return cached;
  };
}

/** What follows `/name ` while the owner types the argument, or null when it is not that. */
export function argQuery(text: string): { name: string; query: string } | null {
  const m = /^\/([a-z]+) (\S*)$/.exec(text);
  return m === null ? null : { name: m[1] as string, query: m[2] as string };
}

/** The options whose value, label or detail contain the query; prefix matches come first. */
export function filterOptions(options: readonly ArgOption[], query: string): ArgOption[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...options];
  const rank = (o: ArgOption): number => {
    const label = (o.label ?? o.value).toLowerCase();
    const value = o.value.toLowerCase();
    if (value.startsWith(q) || label.startsWith(q)) return 0;
    if (value.includes(q) || label.includes(q)) return 1;
    return o.detail?.toLowerCase().includes(q) ? 2 : -1;
  };
  return options
    .map((o, i) => ({ o, i, r: rank(o) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o);
}

/** Typed in full: the argument is already complete, so the popup gets out of the way. */
export function isComplete(options: readonly ArgOption[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return q !== "" && options.some((o) => o.value.toLowerCase() === q);
}

// ── Sources ──────────────────────────────────────────────────────────────

/**
 * `autoMode` on a model entry: whether the model may run Auto mode (the Gateway reports it when
 * it can; undefined is unknown, which never blocks anything).
 */
function autoModeOf(entry: unknown): boolean | undefined {
  const v = (entry as { autoMode?: unknown }).autoMode;
  return typeof v === "boolean" ? v : undefined;
}

/**
 * `/model`: the same `models.list` the model picker reads. A model a provider cannot serve now
 * stays in the list, greyed, with the reason.
 */
export function modelOptions(ctx: ArgContext): ArgOption[] {
  const out: ArgOption[] = [];
  for (const provider of ctx.models?.providers ?? []) {
    const unreachable =
      provider.probe.state === "unreachable" || provider.probe.state === "auth_failed";
    for (const model of provider.models) {
      const caps = model.capabilities;
      const badges: string[] = [];
      if (caps?.vision === true) badges.push(t("chat.args.badge.vision"));
      if (caps?.reasoning === true) badges.push(t("chat.args.badge.reasoning"));
      if (caps?.toolCalling === true) badges.push(t("chat.args.badge.tools"));
      if (autoModeOf(model) === true) badges.push(t("chat.args.badge.autoCapable"));
      if (provider.local) badges.push(t("chat.args.badge.local"));
      const disabledReason =
        caps?.embeddings === true
          ? t("chat.args.model.notChat")
          : !provider.local && !provider.keyConfigured
            ? t("chat.args.model.noKey")
            : provider.local && unreachable
              ? t("chat.args.model.unreachable")
              : undefined;
      out.push({
        value: model.ref,
        label: model.ref.slice(model.ref.indexOf("/") + 1),
        detail: provider.label,
        ...(badges.length > 0 ? { badges } : {}),
        ...(disabledReason === undefined ? {} : { disabledReason }),
      });
    }
  }
  return out;
}

export function currentModel(ctx: ArgContext): string | null {
  return ctx.modelRef ?? ctx.models?.roles.primary ?? null;
}

const MODES: readonly PermissionMode[] = ["manual", "balanced", "auto", "plan"];

/**
 * `/mode`: the permission modes, each with a one-line description. Auto is greyed when the
 * thread's model is known not to be Auto-capable.
 */
export function modeOptions(ctx?: ArgContext): ArgOption[] {
  const ref = ctx === undefined ? null : currentModel(ctx);
  const model = ctx?.models?.providers.flatMap((p) => p.models).find((m) => m.ref === ref);
  const noAuto = model !== undefined && autoModeOf(model) === false;
  return MODES.map((mode) => ({
    value: mode,
    detail: t(`chat.args.mode.${mode}`),
    ...(mode === "auto" && noAuto ? { disabledReason: t("chat.args.mode.autoNeedsModel") } : {}),
  }));
}

/** `/export`: the two formats. */
export function exportOptions(): ArgOption[] {
  return [
    { value: "md", label: "md", detail: t("chat.export.markdown") },
    { value: "json", label: "json", detail: t("chat.export.json") },
  ];
}
