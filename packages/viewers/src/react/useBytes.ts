import { useEffect, useState } from "react";

export type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: Error };

/** Runs an async loader keyed by `key`, aborting the previous run. */
export function useLoadable<T>(
  key: unknown,
  run: (signal: AbortSignal) => Promise<T>,
): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the identity of the load.
  useEffect(() => {
    const ac = new AbortController();
    setState({ status: "loading" });
    run(ac.signal).then(
      (value) => {
        if (!ac.signal.aborted) setState({ status: "ready", value });
      },
      (error: unknown) => {
        if (!ac.signal.aborted)
          setState({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
      },
    );
    return () => ac.abort();
  }, [key]);
  return state;
}
