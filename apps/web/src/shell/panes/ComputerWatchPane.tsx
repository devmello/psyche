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
  // Until the computer's name is known (or if it can't be found), the pane says so instead of
  // looking like the Host's screen, and sends nothing to it.
  const [lookup, setLookup] = useState<"loading" | "found" | "missing">("loading");

  // The computer's name for the title; it follows a rename.
  useEffect(() => {
    setLookup("loading");
    setName(null);
    if (machineId === undefined) return;
    let live = true;
    const load = () =>
      void store
        .call<{ machines: { id: string; name: string }[] }>("machines.list", {})
        .then((res) => {
          if (!live) return;
          const found = res?.machines.find((m) => m.id === machineId)?.name ?? null;
          setName(found);
          setLookup(found === null ? "missing" : "found");
        })
        .catch(() => live && setLookup("missing"));
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
      void store
        .call("attention.report", {
          pane: "vscreen",
          visible,
          ...(machineId === undefined ? {} : { machine: machineId }),
        })
        .catch(() => undefined);
    // Each computer's pane reports on its own: hiding one never hides another.
    report(!covered && (machineId === undefined || lookup === "found"));
    return () => report(false);
  }, [store, covered, machineId, lookup]);

  // A parked card belongs to one screen: only the pane for that screen shows it.
  useEffect(
    () =>
      store.tap((e) => {
        if (e.event !== "computerWatch.parked") return;
        const from = (e.payload as { machine?: string } | undefined)?.machine;
        if (from === machineId) setParked(true);
      }),
    [store, machineId],
  );

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

  if (machineId !== undefined && lookup !== "found") {
    return (
      <div style={{ height: "100%" }} data-testid="computer-watch-pane">
        <p role="status" style={{ padding: 16, color: "var(--shell-muted)" }}>
          {t(
            lookup === "loading" ? "computerWatch.machineLoading" : "computerWatch.machineMissing",
          )}
        </p>
      </div>
    );
  }

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
