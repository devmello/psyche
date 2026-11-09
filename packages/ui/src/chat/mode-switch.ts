/**
 * The composer's Manual / Balanced / Auto switch: the rules behind it, free of React so the
 * desktop chat and the web shell share them. Auto runs only on a model on the Gateway's
 * auto-mode allowlist (`models.list` reports it per model as `autoMode`); on any other model the
 * switch offers the owner's nearest allowed model in one tap instead of only refusing.
 */

/** The slice of `models.list` the switch reads. */
export interface ListedModels {
  providers?: {
    id?: string;
    kind?: string;
    local?: boolean;
    /** A key is stored, or a subscription CLI is installed and signed in (the Gateway decides). */
    keyConfigured?: boolean;
    models?: {
      ref: string;
      autoMode?: boolean;
      capabilities?: { toolCalling?: boolean; embeddings?: boolean };
    }[];
  }[];
  roles?: { primary?: string; utility?: string };
}

/** The modes the switch sets (plan mode keeps its own `/plan` command). */
export const SWITCH_MODES = ["manual", "balanced", "auto"] as const;
export type SwitchMode = (typeof SWITCH_MODES)[number];

export function isSwitchMode(v: unknown): v is SwitchMode {
  return typeof v === "string" && (SWITCH_MODES as readonly string[]).includes(v);
}

const providerOf = (ref: string): string => ref.slice(0, Math.max(0, ref.indexOf("/")));

/**
 * The model that keeps a thread out of Auto, or null when Auto is (or may be) available. A thread
 * without a pin runs on the primary role's model. Only a model the Gateway reported with
 * `autoMode: false` blocks; anything unknown is left to the Gateway to judge.
 */
export function autoModeBlockedBy(
  listed: ListedModels | undefined,
  modelRef: string | null | undefined,
): string | null {
  const ref = modelRef ?? listed?.roles?.primary;
  if (ref === undefined) return null;
  for (const p of listed?.providers ?? []) {
    for (const m of p.models ?? []) {
      if (m.ref === ref && m.autoMode === false) return ref;
    }
  }
  return null;
}

/** The top tier costs the most: offered only when nothing smaller that Auto allows is configured. */
const TOP_TIER = /(?:fable|opus|mythos)/;

/**
 * An allowed model the owner has configured, to offer when the current one cannot run Auto: the
 * provider has a key (a subscription CLI counts once the Gateway reports it configured), the
 * model can call tools, is not an embedding model, and the Gateway said `autoMode: true`.
 * Order: the owner's utility model, then their primary model, then a model of the current
 * model's provider, then listing order; a top-tier model (Fable, Opus) comes last so a tap never
 * picks the most expensive one by accident. Null when none is configured.
 */
export function autoModeSuggestion(
  listed: ListedModels | undefined,
  currentRef: string | null | undefined,
): string | null {
  const current = currentRef ?? listed?.roles?.primary;
  const preferred = [current, listed?.roles?.primary]
    .filter((r): r is string => r !== undefined)
    .map(providerOf);
  const candidates: { ref: string; rank: number }[] = [];
  (listed?.providers ?? []).forEach((p, order) => {
    if (p.keyConfigured !== true) return;
    for (const m of p.models ?? []) {
      if (m.autoMode !== true) continue;
      if (m.capabilities?.embeddings === true || m.capabilities?.toolCalling === false) continue;
      const i = preferred.indexOf(providerOf(m.ref));
      const own =
        m.ref === listed?.roles?.utility ? 0 : m.ref === listed?.roles?.primary ? 1 : undefined;
      const rank =
        own ??
        10 + (TOP_TIER.test(m.ref) ? 1000 : 0) + (i === -1 ? preferred.length : i) * 100 + order;
      candidates.push({ ref: m.ref, rank });
    }
  });
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.ref ?? null;
}

/** The Gateway refused Auto because of the model (`threads.update` → `details.reason`). */
export function isAutoModelRefusal(err: unknown): { model: string | null } | null {
  const e = err as { code?: unknown; details?: unknown } | null;
  if (e?.code !== "forbidden") return null;
  const d = e.details as { reason?: unknown; model?: unknown } | undefined;
  if (d?.reason !== "auto_model_not_allowed") return null;
  return { model: typeof d.model === "string" ? d.model : null };
}

/** A short model name for the offer: `anthropic/claude-sonnet-5-5` → `claude-sonnet-5-5`. */
export function shortModel(ref: string): string {
  return ref.slice(ref.indexOf("/") + 1);
}

/** Browser storage key for "the Auto explainer was shown" (a per-viewer convenience only). */
export const AUTO_EXPLAINER_KEY = "psyche.autoModeExplainerSeen";

export function autoExplainerSeen(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(AUTO_EXPLAINER_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAutoExplainerSeen(storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(AUTO_EXPLAINER_KEY, "1");
  } catch {
    // Private windows and blocked storage: the explainer may show again, nothing else.
  }
}

/** The browser's local storage, or undefined when it is blocked (private windows, previews). */
export function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Whether the choice was also saved as the default for new chats. */
export type DefaultSaved = "saved" | "skipped" | "failed";

/**
 * The calls one switch click makes; `call` is the chat's gateway call function. The chat itself
 * changes first (a refusal throws and nothing else is written). Only the main chat saves the
 * default for new chats: a side or incognito chat's choice stays with that chat. A device that
 * may not write the default (no `operator.admin`) reports `failed` so the switch can say so.
 */
export async function applyModeChoice(
  call: (method: string, params: unknown) => Promise<unknown>,
  thread: { id: string; kind?: string },
  mode: SwitchMode,
  modelRef?: string,
): Promise<DefaultSaved> {
  await call("threads.update", {
    threadId: thread.id,
    permissionMode: mode,
    ...(modelRef === undefined ? {} : { modelRef }),
  });
  if (thread.kind !== "main") return "skipped";
  try {
    await call("settings.set", { key: "permissions.mode", value: mode });
    return "saved";
  } catch {
    return "failed";
  }
}
