import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { moveFocus, type NavShape } from "./model.ts";

/**
 * Roving tabindex for a chart's marks: one tab stop, arrow keys move between marks
 * (`moveFocus` decides where). `register(i)` is the ref callback of mark `i`; `tabIndex(i)` and
 * `onKeyDown` go on each mark. Enter and Space fall through to the mark's own click.
 */
export function useRovingNav(shape: NavShape, initial = 0) {
  const [active, setActive] = useState(initial);
  const nodes = useRef(new Map<number, HTMLElement>());
  const register = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(i, el);
      else nodes.current.delete(i);
    },
    [],
  );
  const onKeyDown = (from: number) => (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = moveFocus(from, e.key, shape);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    nodes.current.get(next)?.focus();
  };
  return {
    active,
    setActive,
    register,
    onKeyDown,
    tabIndex: (i: number) => (i === active ? 0 : -1),
  };
}
