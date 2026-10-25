import { useAui } from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";
import * as m from "motion/react-m";
import { type ReactElement, type RefObject, useLayoutEffect, useState } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { t } from "../i18n/core.ts";
import { fade } from "../motion/index.ts";
import { usePersona } from "../slots.tsx";

/** The element's border-box height, kept current with a ResizeObserver (0 before layout). */
export function useElementHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}

/**
 * Before the first message (redesign-2026 §5.2): the 64 px avatar and the persona's name, centred
 * at about 40% of the column's height. The main chat opens with the agent's greeting
 * (`chat.greet`), so this shows only until it arrives, or in a new side chat.
 */
export function EmptyThread(): ReactElement {
  const persona = usePersona();
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 pb-[20vh] text-center"
      data-testid="chat-empty"
    >
      <Avatar
        name={persona.name}
        creature={persona.creature}
        {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
        size={64}
        decorative
      />
      <p className="text-title-2 text-label-primary">{persona.name}</p>
      <p className="max-w-[44ch] text-body text-label-secondary">
        {t("chat.thread.empty", { name: persona.name })}
      </p>
    </div>
  );
}

const SUGGESTIONS = ["chat.suggest.today", "chat.suggest.inbox", "chat.suggest.plan"] as const;

/**
 * Three chips above the composer in an empty chat; one fills the composer (§5.2). Raised and
 * opaque: the toolbar and the composer already spend the two-glass budget (motion.md §5).
 */
export function ComposerSuggestions(): ReactElement {
  const aui = useAui();
  return (
    <ul className="flex flex-wrap justify-center gap-2" aria-label={t("chat.suggest.label")}>
      {SUGGESTIONS.map((key) => (
        <li key={key}>
          <button
            type="button"
            className="bg-surface-raised shadow-elevation-1 inline-flex h-8 cursor-default items-center rounded-full px-3 text-body text-label-primary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              aui.composer.setText(t(key));
              document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
            }}
          >
            {t(key)}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A 28 px pill centred above the composer when the reader has scrolled up (§5.2); opaque, so it never stacks glass on the composer. */
export function JumpToLatest({ onJump }: { onJump: () => void }): ReactElement {
  return (
    <m.div className="flex justify-center" {...fade}>
      <button
        type="button"
        onClick={onJump}
        className="bg-surface-raised shadow-elevation-1 inline-flex h-7 cursor-default items-center gap-1.5 rounded-full px-3 text-body text-label-primary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="jump-to-latest"
      >
        <ArrowDown className="size-3.5 text-label-secondary" aria-hidden="true" />
        {t("chat.thread.jumpToLatest")}
      </button>
    </m.div>
  );
}
