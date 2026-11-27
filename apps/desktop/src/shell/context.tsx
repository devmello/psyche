import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ShellPlatform } from "./platform.ts";
import type { ShellState, ShellStore } from "./store.ts";

interface ShellContextValue {
  platform: ShellPlatform;
  store: ShellStore;
  mac: boolean;
}

const Ctx = createContext<ShellContextValue | null>(null);

export function ShellProvider(props: ShellContextValue & { children: ReactNode }): ReactElement {
  const { children, ...value } = props;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): ShellContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShell outside ShellProvider");
  return v;
}

/**
 * Subscribes to a slice of the store. `isEqual` (default `Object.is`) lets a selector that builds a
 * new value (a derived array or object) keep the previous one while its content is unchanged, so
 * the component re-renders only when the slice does.
 */
export function useShellState<T>(
  select: (s: ShellState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const { store } = useShell();
  const last = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const next = select(store.getState());
    if (last.current !== null && isEqual(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  });
}
