import type { NodeInfo, VmGuest, VmSnapshot } from "@psyche/protocol";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { useCall, useGatewayQuery, useVmGuests } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatRelative } from "../../lib/format.ts";
import { type SandboxPcSlot, type SandboxPcState, usePersona, useSlots } from "../../slots.tsx";
import { ErrorNotice, Group, StatusChip } from "./shared.tsx";

/**
 * The sandbox PC on Windows (Settings → Sandbox PC, and onboarding's Safety step): the one-time
 * "Turn on" (an elevated service install and the guest image download, which only the desktop app
 * can do, through the `sandboxPc` slot) and, once the Windows helper offers `vm.*`, creating,
 * starting and stopping the guest and its snapshots. Everything after the setup goes through the
 * Gateway like any write: `nodes.invoke` on the helper, `vm.snapshots.*`.
 */

const MB = 1e6;
const GB = 1e9;

/** "1.4 GB" or "600 MB" in the reader's number format. */
export function formatSize(bytes: number): string {
  return bytes >= GB
    ? t("settings.sandboxPc.gb", { value: Math.round((bytes / GB) * 10) / 10 })
    : t("settings.sandboxPc.mb", { value: Math.max(1, Math.round(bytes / MB)) });
}

/** The slot's state, kept current; null until the first answer. */
export function useSandboxPc(): {
  slot: SandboxPcSlot | undefined;
  state: SandboxPcState | null;
  turnOn: () => void;
  updateService: () => void;
  cancel: () => void;
  refresh: () => void;
} {
  const slot = useSlots().sandboxPc;
  const [state, setState] = useState<SandboxPcState | null>(null);
  useEffect(() => {
    if (slot === undefined) return;
    let alive = true;
    const off = slot.onState((s) => alive && setState(s));
    void slot.getState().then((s) => alive && setState(s));
    // The image size and whether the service exists are read when the card opens.
    void slot.refresh().then((s) => alive && setState(s));
    return () => {
      alive = false;
      off();
    };
  }, [slot]);
  return {
    slot,
    state,
    turnOn: () => void slot?.turnOn().then(setState),
    updateService: () => void slot?.updateService().then(setState),
    cancel: () => void slot?.cancel(),
    refresh: () => void slot?.refresh().then(setState),
  };
}

export interface SandboxPcSetupProps {
  persona: string;
  state: SandboxPcState;
  onTurnOn: () => void;
  onCancel: () => void;
}

/** The "Turn on the sandbox PC" card: what it needs, then its progress. */
export function SandboxPcSetup({
  persona,
  state,
  onTurnOn,
  onCancel,
}: SandboxPcSetupProps): ReactElement {
  const busy =
    state.phase === "installing" ||
    state.phase === "updating" ||
    state.phase === "downloading" ||
    state.phase === "restarting";
  const size =
    state.downloadBytes !== undefined && state.diskBytes !== undefined
      ? t("settings.sandboxPc.oneTime", {
          download: formatSize(state.downloadBytes),
          disk: formatSize(state.diskBytes),
        })
      : t("settings.sandboxPc.oneTimeNoSize");
  return (
    <Group
      title={t("settings.sandboxPc.title")}
      description={t("settings.sandboxPc.explain", { persona })}
      actions={
        state.phase === "ready" ? (
          <StatusChip tone="success">{t("settings.sandboxPc.ready")}</StatusChip>
        ) : undefined
      }
    >
      {state.phase === "unsupported" ? (
        <p className="text-callout text-label-secondary" data-testid="sandbox-pc-unsupported">
          {t("settings.sandboxPc.unsupported", {
            reason: (state.message ?? "").replace(/\.$/, ""),
          })}
        </p>
      ) : null}
      {state.phase === "off" || state.phase === "failed" ? (
        <div className="flex flex-col gap-3">
          <p className="text-callout text-label-secondary">{size}</p>
          {state.phase === "failed" ? (
            <ErrorNotice
              what={t("settings.sandboxPc.failed", { reason: state.message ?? "" })}
              did={t("settings.sandboxPc.failedDid")}
            />
          ) : null}
          <div>
            <Button type="button" onClick={onTurnOn}>
              {t("settings.sandboxPc.turnOn")}
            </Button>
          </div>
        </div>
      ) : null}
      {busy ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          {state.phase === "installing" || state.phase === "updating" ? (
            <p className="text-callout text-label-secondary">
              {t("settings.sandboxPc.waitingAdmin")}
            </p>
          ) : null}
          {state.phase === "restarting" ? (
            <p className="text-callout text-label-secondary">
              {t("settings.sandboxPc.restarting")}
            </p>
          ) : null}
          {state.phase === "downloading" && state.download ? (
            <>
              <Progress
                value={Math.round(
                  (state.download.receivedBytes / Math.max(1, state.download.totalBytes)) * 100,
                )}
                aria-label={t("settings.sandboxPc.progressLabel")}
              />
              <p className="text-callout text-label-secondary tabular-nums">
                {t("settings.sandboxPc.downloading", {
                  received: formatSize(state.download.receivedBytes),
                  total: formatSize(state.download.totalBytes),
                })}
              </p>
              <div>
                <Button type="button" variant="plain" onClick={onCancel}>
                  {t("settings.sandboxPc.cancelDownload")}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {state.phase === "ready" && state.imageVersion !== null ? (
        <p className="text-callout text-label-secondary">
          {t("settings.sandboxPc.readyText", { version: state.imageVersion })}
        </p>
      ) : null}
    </Group>
  );
}

export interface SandboxPcServiceUpdateProps {
  state: SandboxPcState;
  onUpdate: () => void;
}

/**
 * After an app update brought a newer sandbox PC service than the one installed: say so and offer
 * the one-click update. Nothing is elevated until the button is pressed.
 */
export function SandboxPcServiceUpdate({
  state,
  onUpdate,
}: SandboxPcServiceUpdateProps): ReactElement | null {
  const update = state.serviceUpdate;
  if (update === undefined || state.phase === "unsupported") return null;
  const updating = state.phase === "updating";
  const busy = updating || state.phase === "installing" || state.phase === "downloading";
  return (
    <Group
      title={t("settings.sandboxPc.update.title")}
      description={t(
        update.compatible
          ? "settings.sandboxPc.update.explainCompatible"
          : "settings.sandboxPc.update.explainRequired",
      )}
      actions={
        <StatusChip tone={update.compatible ? "info" : "approval"}>
          {t(
            update.compatible
              ? "settings.sandboxPc.update.available"
              : "settings.sandboxPc.update.required",
          )}
        </StatusChip>
      }
    >
      <div className="flex flex-col gap-3" data-testid="sandbox-pc-service-update">
        <p className="text-callout text-label-secondary">
          {t("settings.sandboxPc.update.versions", {
            installed: update.installed,
            bundled: update.bundled,
          })}
        </p>
        {state.message ? (
          <ErrorNotice
            what={t("settings.sandboxPc.update.failed", { reason: state.message })}
            did={t("settings.sandboxPc.update.failedDid")}
          />
        ) : null}
        {updating ? (
          <p className="text-callout text-label-secondary" aria-live="polite">
            {t("settings.sandboxPc.waitingAdmin")}
          </p>
        ) : (
          <>
            <p className="text-callout text-label-secondary">
              {t("settings.sandboxPc.update.oneStep")}
            </p>
            <div>
              <Button type="button" disabled={busy} onClick={onUpdate}>
                {t("settings.sandboxPc.update.button")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Group>
  );
}

const STOPPED: ReadonlySet<VmGuest["phase"]> = new Set([
  "created",
  "installed",
  "stopped",
  "saved",
  "failed",
]);

export interface SandboxPcControlsProps {
  guest: VmGuest | undefined;
  /** The helper offers `vm.*` (the service is installed and it restarted). */
  helperReady: boolean;
  /** The service and image are in place. */
  setUp: boolean;
  snapshots: readonly VmSnapshot[];
  baseSnapshot: string | null;
  busy: boolean;
  error: string | null;
  now: number;
  onCreate: () => void;
  onStart: () => void;
  onStop: () => void;
  onResume: () => void;
  onSnapshot: (base: boolean) => void;
  onRestore: (id: string) => void;
  onReset: () => void;
  onDeleteSnapshot: (id: string) => void;
}

/** Create / start / stop the guest and its snapshots. */
export function SandboxPcControls(p: SandboxPcControlsProps): ReactElement {
  const stopped = p.guest !== undefined && STOPPED.has(p.guest.phase);
  const disabled = p.busy || !p.helperReady;
  return (
    <Group
      title={t("settings.sandboxPc.controls.title")}
      description={t("settings.sandboxPc.controls.hint")}
    >
      {!p.helperReady ? (
        <p className="text-callout text-label-secondary" data-testid="sandbox-pc-helper-offline">
          {t("settings.sandboxPc.controls.helperOffline")}
        </p>
      ) : null}
      {p.error ? (
        <ErrorNotice what={t("settings.sandboxPc.controls.failed", { reason: p.error })} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {p.guest === undefined ? (
          <Button type="button" disabled={disabled || !p.setUp} onClick={p.onCreate}>
            {p.busy
              ? t("settings.sandboxPc.controls.working")
              : t("settings.sandboxPc.controls.create")}
          </Button>
        ) : null}
        {stopped ? (
          <Button type="button" disabled={disabled} onClick={p.onStart}>
            {t("settings.sandboxPc.controls.start")}
          </Button>
        ) : null}
        {p.guest?.phase === "paused" ? (
          <Button type="button" disabled={disabled} onClick={p.onResume}>
            {t("settings.sandboxPc.controls.resume")}
          </Button>
        ) : null}
        {p.guest?.phase === "running" || p.guest?.phase === "paused" ? (
          <Button type="button" variant="plain" disabled={disabled} onClick={p.onStop}>
            {t("settings.sandboxPc.controls.stop")}
          </Button>
        ) : null}
      </div>
      {p.guest !== undefined ? (
        <div className="flex flex-col gap-2" data-testid="sandbox-pc-snapshots">
          <h4 className="text-headline text-label-primary">
            {t("settings.sandboxPc.snapshots.title")}
          </h4>
          <p className="text-callout text-label-secondary">
            {t("settings.sandboxPc.snapshots.hint")}
          </p>
          {!stopped ? (
            <p className="text-callout text-label-secondary">
              {t("settings.sandboxPc.snapshots.stopFirst")}
            </p>
          ) : null}
          {p.snapshots.length === 0 ? (
            <p className="text-callout text-label-secondary">
              {t("settings.sandboxPc.snapshots.none")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {p.snapshots.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    {t("settings.sandboxPc.snapshots.item", {
                      label: s.label || s.id,
                      when: formatRelative(s.createdAt, p.now),
                    })}
                    {s.id === p.baseSnapshot ? (
                      <StatusChip tone="info" className="ms-2">
                        {t("settings.sandboxPc.snapshots.fresh")}
                      </StatusChip>
                    ) : null}
                  </span>
                  <Button
                    type="button"
                    variant="plain"
                    size="sm"
                    disabled={disabled || !stopped}
                    onClick={() => p.onRestore(s.id)}
                  >
                    {t("settings.sandboxPc.snapshots.restore")}
                  </Button>
                  <Button
                    type="button"
                    variant="plain"
                    size="sm"
                    disabled={disabled}
                    onClick={() => p.onDeleteSnapshot(s.id)}
                  >
                    {t("settings.sandboxPc.snapshots.delete")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="plain"
              disabled={disabled || !stopped}
              onClick={() => p.onSnapshot(false)}
            >
              {t("settings.sandboxPc.snapshots.save")}
            </Button>
            <Button
              type="button"
              variant="plain"
              disabled={disabled || !stopped}
              onClick={() => p.onSnapshot(true)}
            >
              {t("settings.sandboxPc.snapshots.saveFresh")}
            </Button>
            {p.baseSnapshot !== null ? (
              <Button
                type="button"
                variant="plain"
                disabled={disabled || !stopped}
                onClick={p.onReset}
              >
                {t("settings.sandboxPc.snapshots.reset")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Group>
  );
}

/** The helper that serves `vm.*`: this PC's own Windows helper, online, with `vm.create`. */
export function windowsVmHelper(nodes: readonly NodeInfo[] | undefined): NodeInfo | undefined {
  return nodes?.find(
    (n) =>
      n.kind === "win-helper" &&
      n.status === "online" &&
      n.capabilities.some((c) => c.name === "vm.create"),
  );
}

/** The card and the controls, wired to the desktop slot and the Gateway. */
export function SandboxPcConnected({ now }: { now?: number }): ReactElement | null {
  const persona = usePersona();
  const pc = useSandboxPc();
  const call = useCall();
  const nodes = useGatewayQuery("nodes.list", {});
  const guests = useVmGuests();
  const guest = guests[0]?.guest;
  const helper = windowsVmHelper(nodes.data?.nodes);
  const snaps = useGatewayQuery(
    "vm.snapshots.list",
    {},
    { enabled: guest !== undefined && helper !== undefined },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clock = now ?? Date.now();
  const reloadSnapshots = snaps.reload;

  const invoke = useCallback(
    async (capability: string, params: object = {}) => {
      if (helper === undefined) return;
      setBusy(true);
      setError(null);
      try {
        const r = await call("nodes.invoke", { nodeId: helper.id, capability, params });
        if (!r.ok) setError(r.error?.message ?? capability);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
        reloadSnapshots();
      }
    },
    [call, helper, reloadSnapshots],
  );
  const gateway = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await run();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
        reloadSnapshots();
      }
    },
    [reloadSnapshots],
  );

  if (pc.slot === undefined || pc.state === null) return null;
  const name = guest?.name ?? "sandbox";
  const setUp = pc.state.phase === "ready";
  return (
    <div className="flex flex-col gap-3">
      <SandboxPcServiceUpdate state={pc.state} onUpdate={pc.updateService} />
      <SandboxPcSetup
        persona={persona.name}
        state={pc.state}
        onTurnOn={pc.turnOn}
        onCancel={pc.cancel}
      />
      {pc.state.phase !== "unsupported" && (setUp || guest !== undefined) ? (
        <SandboxPcControls
          guest={guest}
          helperReady={helper !== undefined}
          setUp={setUp}
          snapshots={snaps.data?.snapshots ?? []}
          baseSnapshot={snaps.data?.baseSnapshot ?? null}
          busy={busy}
          error={error}
          now={clock}
          onCreate={() =>
            void invoke("vm.create", { name, download: true }).then(() =>
              invoke("vm.start", { name }),
            )
          }
          onStart={() => void invoke("vm.start", { name })}
          onStop={() => void invoke("vm.stop", { name })}
          onResume={() => void invoke("vm.resume", { name })}
          onSnapshot={(base) =>
            void gateway(() => call("vm.snapshots.create", base ? { base: true } : {}))
          }
          onRestore={(snapshot) => void gateway(() => call("vm.snapshots.restore", { snapshot }))}
          onReset={() => void gateway(() => call("vm.snapshots.reset", {}))}
          onDeleteSnapshot={(snapshot) =>
            void gateway(() => call("vm.snapshots.delete", { snapshot }))
          }
        />
      ) : null}
    </div>
  );
}

/**
 * Onboarding's Safety step: the card alone, where the desktop can turn the sandbox PC on. Nothing
 * on a Mac or in the web.
 */
export function SandboxPcOnboarding(): ReactElement | null {
  const persona = usePersona();
  const pc = useSandboxPc();
  if (pc.slot === undefined || pc.state === null || pc.state.phase === "unsupported") return null;
  return (
    <div className="flex flex-col gap-2" data-testid="sandbox-pc-onboarding">
      <p className="text-callout text-label-secondary">{t("settings.sandboxPc.onboardingHint")}</p>
      <SandboxPcSetup
        persona={persona.name}
        state={pc.state}
        onTurnOn={pc.turnOn}
        onCancel={pc.cancel}
      />
    </div>
  );
}
