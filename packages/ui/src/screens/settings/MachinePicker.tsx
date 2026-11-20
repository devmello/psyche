import type { MachineInfo } from "@psyche/protocol";
import { type ReactElement, useId } from "react";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { SegmentedRadio } from "./SegmentedRadio.tsx";
import { EmptyNotice, Group } from "./shared.tsx";
import type { AppTier, ComputerUseApp } from "./types.ts";

/**
 * Settings → Computer use: which computer. With Linux computers paired, the owner picks the one
 * whose app access this page shows, and the default computer for background work (design §8.2 and
 * §8.3). "This computer" is the Host, and picking it changes nothing about the page the Host has
 * always had. The Gateway syncs a machine's tiers to that computer's own limits and clamps them
 * by its ceiling, so what shows here can only be as wide as the computer allows.
 */

/** `""` (the Host) or a machine id: where the agent works when nobody names a computer. */
export const DEFAULT_MACHINE_KEY = "computerUse.defaultMachine";
/** `{ [machineId]: [{ id, name, tier }] }`: app access per computer. */
export const MACHINE_APPS_KEY = "computerUse.machineApps";

/** The Host's value in the pickers. */
export const HOST_CHOICE = "";

function isApp(v: unknown): v is ComputerUseApp {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ComputerUseApp).id === "string" &&
    typeof (v as ComputerUseApp).name === "string" &&
    typeof (v as ComputerUseApp).tier === "string"
  );
}

/** The rows the Gateway keeps for one computer; anything malformed is dropped. */
export function machineAppsOf(
  values: Readonly<Record<string, unknown>>,
  machineId: string,
): ComputerUseApp[] {
  const all = values[MACHINE_APPS_KEY];
  if (typeof all !== "object" || all === null || Array.isArray(all)) return [];
  const rows = (all as Record<string, unknown>)[machineId];
  return Array.isArray(rows) ? rows.filter(isApp) : [];
}

/** The default computer, or the Host when it is unset or names a computer that is gone. */
export function defaultMachineOf(
  values: Readonly<Record<string, unknown>>,
  machines: readonly MachineInfo[],
): string {
  const v = values[DEFAULT_MACHINE_KEY];
  return typeof v === "string" && machines.some((m) => m.id === v) ? v : HOST_CHOICE;
}

export function MachinePicker({
  machines,
  values,
  selected,
  onSelect,
  onChange,
}: {
  machines: readonly MachineInfo[];
  values: Readonly<Record<string, unknown>>;
  /** The computer whose app access the page shows (`""` is the Host). */
  selected: string;
  onSelect: (machineId: string) => void;
  onChange: (key: string, value: unknown) => void;
}): ReactElement | null {
  const id = useId();
  if (machines.length === 0) return null;
  const options = (
    <>
      <option value={HOST_CHOICE}>{t("machines.thisComputer")}</option>
      {machines.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </>
  );
  return (
    <Group title={t("machines.picker.title")} description={t("machines.picker.description")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor={`${id}-show`}>{t("machines.picker.show")}</Label>
        <NativeSelect
          id={`${id}-show`}
          className="max-w-xs"
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
        >
          {options}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label htmlFor={`${id}-default`}>{t("machines.picker.default")}</Label>
          <NativeSelect
            id={`${id}-default`}
            className="max-w-xs"
            value={defaultMachineOf(values, machines)}
            onChange={(e) => onChange(DEFAULT_MACHINE_KEY, e.target.value)}
          >
            {options}
          </NativeSelect>
        </div>
        <p className="text-callout text-label-secondary">{t("machines.picker.defaultHint")}</p>
      </div>
    </Group>
  );
}

/** One computer's app access, in place of the Host's list while that computer is picked. */
export function MachineAppsGroup({
  machine,
  values,
  tiers,
  enabled,
  onChange,
}: {
  machine: MachineInfo;
  values: Readonly<Record<string, unknown>>;
  tiers: readonly { value: AppTier; readonly label: string }[];
  enabled: boolean;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  const apps = machineAppsOf(values, machine.id);
  const setTier = (app: ComputerUseApp, tier: AppTier) => {
    const all = values[MACHINE_APPS_KEY];
    const base =
      typeof all === "object" && all !== null && !Array.isArray(all)
        ? (all as Record<string, unknown>)
        : {};
    onChange(MACHINE_APPS_KEY, {
      ...base,
      [machine.id]: apps.map((a) => (a.id === app.id ? { ...a, tier } : a)),
    });
  };
  return (
    <Group
      title={t("machines.picker.appsOn", { name: machine.name })}
      description={t("machines.picker.appsHint", { name: machine.name })}
    >
      {machine.status !== "online" ? (
        <p role="status" className="text-callout text-approval-text">
          {t("machines.picker.offline", { name: machine.name })}
        </p>
      ) : null}
      {apps.length === 0 ? (
        <EmptyNotice text={t("machines.picker.noApps", { name: machine.name })} />
      ) : (
        apps.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 text-body text-label-primary">{a.name}</span>
            <SegmentedRadio
              label={a.name}
              options={tiers}
              value={a.tier}
              disabled={!enabled}
              onChange={(tier) => setTier(a, tier)}
              segmentLabel={(o) => t("settings.matrix.cell", { row: a.name, column: o.label })}
            />
          </div>
        ))
      )}
    </Group>
  );
}
