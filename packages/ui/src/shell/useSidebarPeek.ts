import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Hover-to-expand timing for the compact sidebar: intent to open, grace before it closes. */
export const PEEK_OPEN_DELAY = 250;
export const PEEK_CLOSE_DELAY = 300;

/** A popup (menu) opened from inside the sidebar keeps it expanded while it is open. */
const OPEN_POPUP = '[aria-haspopup][aria-expanded="true"]';

/** Whether the focused element shows a focus ring, i.e. the focus came from the keyboard. */
function focusFromKeyboard(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

export interface SidebarPeek {
  /** The compact sidebar is showing expanded, over the content. */
  peek: boolean;
  /** Spread on the element that wraps the compact sidebar (pointer, focus and key events). */
  hostProps: {
    ref: (el: HTMLElement | null) => void;
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onPointerDown: () => void;
    onFocus: (e: FocusEvent<HTMLElement>) => void;
    onBlur: (e: FocusEvent<HTMLElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  };
}

/**
 * The compact rail expands over the content while the pointer rests on it (after
 * `PEEK_OPEN_DELAY`) or the keyboard focuses something inside, and folds back
 * `PEEK_CLOSE_DELAY` after the pointer and the focus have left. It never opens for a press or a
 * drag (a held button, touch input), a press inside cancels a pending open, a menu opened from
 * inside holds it, and Escape folds it. `enabled` off (full sidebar, hidden) resets everything.
 */
export function useSidebarPeek(enabled: boolean): SidebarPeek {
  const [peek, setPeek] = useState(false);
  const host = useRef<HTMLElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hover = useRef(false);
  const keyboard = useRef(false);
  const suppressed = useRef(false);
  const buttons = useRef(0);

  const clearOpen = useCallback(() => {
    clearTimeout(openTimer.current);
    openTimer.current = undefined;
  }, []);
  const clearClose = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  const scheduleClose = useCallback(() => {
    clearClose();
    closeTimer.current = setTimeout(function check() {
      closeTimer.current = undefined;
      const el = host.current;
      if (hover.current) return;
      if (keyboard.current && el?.contains(document.activeElement)) return;
      // A menu from the sidebar is open: wait for it to close, then fold.
      if (el?.querySelector(OPEN_POPUP)) {
        closeTimer.current = setTimeout(check, PEEK_CLOSE_DELAY);
        return;
      }
      keyboard.current = false;
      setPeek(false);
    }, PEEK_CLOSE_DELAY);
  }, [clearClose]);

  const scheduleOpen = useCallback(() => {
    if (openTimer.current !== undefined) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = undefined;
      if (hover.current && buttons.current === 0 && !suppressed.current) setPeek(true);
    }, PEEK_OPEN_DELAY);
  }, []);

  useEffect(() => {
    if (enabled) return;
    clearOpen();
    clearClose();
    hover.current = false;
    keyboard.current = false;
    setPeek(false);
  }, [enabled, clearOpen, clearClose]);
  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );

  return {
    peek: enabled && peek,
    hostProps: {
      ref: (el) => {
        host.current = el;
      },
      onPointerEnter: (e) => {
        if (!enabled || e.pointerType === "touch") return;
        hover.current = true;
        suppressed.current = false;
        buttons.current = e.buttons;
        clearClose();
        if (!peek && e.buttons === 0) scheduleOpen();
      },
      onPointerMove: (e) => {
        if (!enabled || e.pointerType === "touch") return;
        buttons.current = e.buttons;
        // A drag that ended inside the sidebar: the pointer resting here now counts as intent.
        if (hover.current && !peek && e.buttons === 0 && !suppressed.current) scheduleOpen();
      },
      onPointerLeave: () => {
        hover.current = false;
        suppressed.current = false;
        clearOpen();
        if (peek) scheduleClose();
      },
      // A press is a click, not a rest: it cancels a pending open, and a click on the rail
      // doesn't expand it afterwards until the pointer has left and come back.
      onPointerDown: () => {
        clearOpen();
        if (!peek) suppressed.current = true;
      },
      onFocus: (e) => {
        if (!enabled || !focusFromKeyboard(e.target)) return;
        keyboard.current = true;
        clearOpen();
        clearClose();
        setPeek(true);
      },
      onBlur: (e) => {
        if (!keyboard.current) return;
        const next = e.relatedTarget;
        if (next instanceof Node && host.current?.contains(next)) return;
        scheduleClose();
      },
      onKeyDown: (e) => {
        if (e.key !== "Escape" || !peek) return;
        // Escape inside a menu belongs to the menu (its popup is a portal, but events bubble).
        if (!(e.target instanceof Node && host.current?.contains(e.target))) return;
        clearOpen();
        clearClose();
        keyboard.current = false;
        hover.current = false;
        setPeek(false);
      },
    },
  };
}
