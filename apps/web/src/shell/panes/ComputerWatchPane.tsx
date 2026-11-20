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
  machine?: string,
): ComputerWatchClient {
  // A paired computer's pane names it in every call; the Host's pane sends nothing extra.
  const scope = machine === undefined ? {} : { machine };
  const call = async <T,>(method: string, params: unknown): Promise<T> => {
    const res = await store.call<T>(method, params);
    if (res === undefined) throw new Error(`${method} is not available`);
    return res;
  };
  return {
    async status() {
      const res = await call<State>("computerWatch.status", { ...scope });
      onParked(res.parked);
      return res.status;
    },
    frame: (since, maxWidth) =>
      call("computerWatch.frame", {
        ...scope,
        ...(since === undefined ? {} : { since }),
        ...(maxWidth === undefined ? {} : { maxWidth }),
      }),
    async input(events) {
      await call("computerWatch.input", { ...scope, events });
    },
    async setTakenOver(on) {
      await call("computerWatch.takeOver", { ...scope, on });
    },
    async stop() {
      const res = await call<{ ok: boolean }>("computerWatch.stop", {
        ...scope,
        closeApps: true,
      });
      // Refused because an app asks to save: the card (computerWatch.parked) takes over.
      onParked(!res.ok);
    },
  };
}

/**
 * `machine` is a machine id (the pane's `target`): the pane then watches that computer's private
 * screen and says so in its title. Without it the pane shows the Host's own virtual screen.
 */
export function ComputerWatchPane({
  covered,
  machine,
}: {
  covered: boolean;
  machine?: string | null | undefined;
}): ReactElement {
  const { store } = useShell();
  const [parked, setParked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const machineId = machine ?? undefined;
  const client = useMemo(() => watchClient(store, setParked, machineId), [store, machineId]);
  const [name, setName] = useState<string | null>(null);

  // The computer's name for the title; it follows a rename.
  useEffect(() => {
    if (machineId === undefined) {
      setName(null);
      return;
    }
    let live = true;
    const load = () =>
      void store
        .call<{ machines: { id: string; name: string }[] }>("machines.list", {})
        .then((res) => live && setName(res?.machines.find((m) => m.id === machineId)?.name ?? null))
        .catch(() => undefined);
    load();
    const off = store.tap((e) => e.event === "machines.changed" && load());
    return () => {
      live = false;
      off();
    };
  }, [store, machineId]);

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
      .call("computerWatch.resolveParked", {
        action,
        ...(machineId === undefined ? {} : { machine: machineId }),
      })
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
        {...(name === null ? {} : { machine: { name } })}
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
