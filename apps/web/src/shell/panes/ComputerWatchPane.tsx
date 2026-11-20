import { ComputerWatch, type ComputerWatchClient, describeError, t } from "@psyche/ui";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { useShell } from "../context.tsx";
import type { ShellStore } from "../store.ts";

/**
 * The Virtual screen watch pane (Linux, design §7.5) wired to the Gateway's `computerWatch.*`
 * methods. The pane only pulls frames while it is on screen: it reports its visibility with
 * `attention.report { pane: "vscreen" }`, and `ComputerWatch` itself stops polling when
 * `visible` is false.
 */

interface State {
  status: Awaited<ReturnType<ComputerWatchClient["status"]>>;
  parked: boolean;
}

/** The pane's client over the shell's store. `onParked` hears whether a card is waiting. */
export function watchClient(
  store: Pick<ShellStore, "call">,
  onParked: (parked: boolean) => void,
): ComputerWatchClient {
  const call = async <T,>(method: string, params: unknown): Promise<T> => {
    const res = await store.call<T>(method, params);
    if (res === undefined) throw new Error(`${method} is not available`);
    return res;
  };
  return {
    async status() {
      const res = await call<State>("computerWatch.status", {});
      onParked(res.parked);
      return res.status;
    },
    frame: (since, maxWidth) =>
      call("computerWatch.frame", {
        ...(since === undefined ? {} : { since }),
        ...(maxWidth === undefined ? {} : { maxWidth }),
      }),
    async input(events) {
      await call("computerWatch.input", { events });
    },
    async setTakenOver(on) {
      await call("computerWatch.takeOver", { on });
    },
    async stop() {
      const res = await call<{ ok: boolean }>("computerWatch.stop", { closeApps: true });
      // Refused because an app asks to save: the card (computerWatch.parked) takes over.
      onParked(!res.ok);
    },
  };
}

export function ComputerWatchPane({ covered }: { covered: boolean }): ReactElement {
  const { store } = useShell();
  const [parked, setParked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const client = useMemo(() => watchClient(store, setParked), [store]);

  // Frames are pulled only while the pane is shown; tell the Gateway so it can refuse otherwise.
  useEffect(() => {
    const report = (visible: boolean) =>
      void store.call("attention.report", { pane: "vscreen", visible }).catch(() => undefined);
    report(!covered);
    return () => report(false);
  }, [store, covered]);

  useEffect(() => store.tap((e) => e.event === "computerWatch.parked" && setParked(true)), [store]);

  const resolve = (action: "look" | "discard" | "keep_open") =>
    store
      .call("computerWatch.resolveParked", { action })
      .then(() => {
        if (action !== "look") setParked(false);
        setProblem(null);
      })
      .catch((err: unknown) => setProblem(describeError(err)));

  return (
    <div style={{ height: "100%" }} data-testid="computer-watch-pane">
      <ComputerWatch
        client={client}
        visible={!covered}
        parked={parked}
        onLook={() => void resolve("look")}
        onDiscard={() => void resolve("discard")}
        onKeepOpen={() => void resolve("keep_open")}
      />
      {problem ? (
        <p role="alert" style={{ padding: 8, color: "var(--shell-muted)" }}>
          {t("computerWatch.error")}
        </p>
      ) : null}
    </div>
  );
}
