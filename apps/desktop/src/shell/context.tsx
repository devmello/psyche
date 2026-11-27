import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
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

export function useShellState<T>(select: (s: ShellState) => T): T {
  const { store } = useShell();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
