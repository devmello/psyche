import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { type GatewayClient, GatewayRequestError } from "./client.ts";
import type { UiState } from "./state.ts";
import { GatewayStore } from "./store.ts";

const StoreContext = createContext<GatewayStore | null>(null);

export interface GatewayProviderProps {
  client: GatewayClient;
  children?: ReactNode;
  /** Supply a prebuilt store (tests); otherwise one is created per client. */
  store?: GatewayStore;
}

/** Makes the Gateway available to every hook below it. */
export function GatewayProvider({ client, children, store }: GatewayProviderProps): ReactElement {
  const ref = useRef<GatewayStore | null>(null);
  if (store !== undefined) ref.current = store;
  else if (ref.current === null || ref.current.client !== client) {
    ref.current = new GatewayStore(client);
  }
  const current = ref.current;
  useEffect(() => {
    current.start();
    return () => current.stop();
  }, [current]);
  return <StoreContext.Provider value={current}>{children}</StoreContext.Provider>;
}

/** Client for the detached store: never connects; every request says why (#560). */
const NO_GATEWAY: GatewayClient = {
  request: (method) =>
    Promise.reject(
      new GatewayRequestError(
        method,
        "unavailable",
        `${method} needs a Gateway: this component is rendered outside <GatewayProvider>`,
      ),
    ),
  subscribe: () => () => {},
  connectionState: () => "offline",
  onConnectionState: () => () => {},
};

let detachedStore: GatewayStore | null = null;

/**
 * The store from the nearest `<GatewayProvider>`. Outside one (a kit component rendered bare in a
 * story, test or preview) it is a shared detached store: data hooks stay idle with no data and
 * no error, and actions reject with "rendered outside <GatewayProvider>" instead of the whole
 * component throwing on render (#560).
 */
export function useStore(): GatewayStore {
  const store = useContext(StoreContext);
  if (store !== null) return store;
  detachedStore ??= new GatewayStore(NO_GATEWAY, { detached: true });
  return detachedStore;
}

/**
 * Selects from the store. The result is cached per (state, selector), so selectors may build new
 * arrays without making `useSyncExternalStore` loop.
 */
export function useStoreState<T>(select: (s: UiState) => T): T {
  const store = useStore();
  const cache = useRef<{ state: UiState; select: (s: UiState) => T; value: T } | null>(null);
  const get = () => {
    const state = store.getState();
    const c = cache.current;
    if (c !== null && c.state === state && c.select === select) return c.value;
    const value = select(state);
    cache.current = { state, select, value };
    return value;
  };
  return useSyncExternalStore(store.subscribeStore, get, get);
}
