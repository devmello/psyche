import { type ReactElement, useCallback, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { type GatewayEntry, useSlots } from "../../slots.tsx";
import { ErrorNotice, Group, StatusChip } from "./shared.tsx";

/**
 * Settings → Server & remote access → Gateways on this computer (remote-gateway design §1.3).
 * The saved Gateways, which one is active, and adding, switching, pairing again and forgetting.
 * One Gateway is active at a time; switching restarts Psyche on the other one. Every change that
 * adds, forgets or re-pairs a Gateway is confirmed in a native dialog, not here.
 */

const PROBLEMS = [
  "empty",
  "invalid",
  "needs_full_name",
  "needs_https",
  "has_path",
  "has_credentials",
] as const;

/** The sentence for why an address, or any change, was refused. */
export function gatewayProblemText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const problem = (err as { details?: { problem?: unknown } } | null)?.details?.problem;
  if (code === "invalid_params" && PROBLEMS.includes(problem as (typeof PROBLEMS)[number])) {
    return t(`settings.gateways.problem.${problem as (typeof PROBLEMS)[number]}`);
  }
  if (code === "forbidden") return t("settings.gateways.problem.declined");
  return t("settings.gateways.problem.failed");
}

export function useSavedGateways(): {
  entries: GatewayEntry[] | null;
  reload: () => void;
} {
  const { gateways } = useSlots();
  const [entries, setEntries] = useState<GatewayEntry[] | null>(null);
  const reload = useCallback(() => {
    if (!gateways) return;
    void gateways.list().then(setEntries, () => setEntries([]));
  }, [gateways]);
  useEffect(reload, [reload]);
  return { entries, reload };
}

export function AddGatewayForm({
  onAdded,
}: {
  onAdded: (entry: GatewayEntry) => void;
}): ReactElement | null {
  const { gateways } = useSlots();
  const id = useId();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!gateways) return null;
  const submit = () => {
    setBusy(true);
    setError(null);
    gateways.add(address, name.trim() === "" ? undefined : name.trim()).then(
      (entry) => {
        setBusy(false);
        setAddress("");
        setName("");
        onAdded(entry);
      },
      (err: unknown) => {
        setBusy(false);
        setError(gatewayProblemText(err));
      },
    );
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-callout text-label-secondary">{t("settings.gateways.addHint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor={`${id}-address`}>{t("settings.gateways.addressLabel")}</Label>
          <Input
            id={`${id}-address`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t("settings.gateways.addressPlaceholder")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
        </div>
        <div className="flex min-w-40 flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t("settings.gateways.nameLabel")}</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" size="sm" disabled={busy || address.trim() === ""}>
          {t("settings.gateways.adding")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Switching from This Mac keeps its Gateway running by default, so its automations continue, and
 * offers to stop it as a separate step (owner decision G2).
 */
function SwitchChoice({
  target,
  fromThisMac,
  onSwitch,
  onCancel,
}: {
  target: GatewayEntry;
  fromThisMac: boolean;
  onSwitch: (stopLocal: boolean) => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 pt-1">
      <legend className="sr-only">
        {t("settings.gateways.switchTitle", { name: target.name })}
      </legend>
      <p className="text-callout text-label-secondary">
        {fromThisMac
          ? t("settings.gateways.switchKeep", { name: target.name })
          : t("settings.gateways.switchTitle", { name: target.name })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => onSwitch(false)}>
          {t("settings.gateways.switchOnly")}
        </Button>
        {fromThisMac ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onSwitch(true)}>
            {t("settings.gateways.switchAndStop")}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </fieldset>
  );
}

export function GatewaysList({
  entries,
  onChanged,
  onError,
}: {
  entries: readonly GatewayEntry[];
  onChanged: () => void;
  onError: (message: string | null) => void;
}): ReactElement {
  const { gateways } = useSlots();
  const [switching, setSwitching] = useState<string | null>(null);
  const current = entries.find((e) => e.active);
  const run = (p: Promise<unknown> | undefined) => {
    onError(null);
    p?.then(onChanged, (err: unknown) => onError(gatewayProblemText(err)));
  };
  return (
    <ul className="flex flex-col divide-y divide-gray-6">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {e.remote ? e.name : t("settings.gateways.thisMac")}
            </span>
            {e.active ? (
              <StatusChip tone="success">{t("settings.gateways.active")}</StatusChip>
            ) : null}
            {e.remote ? (
              <StatusChip tone="neutral">
                {e.pinned ? t("settings.gateways.pinned") : t("settings.gateways.notPinned")}
              </StatusChip>
            ) : null}
            <span className="flex-1" />
            {!e.active ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t("settings.gateways.switchTo", {
                  name: e.remote ? e.name : t("settings.gateways.thisMac"),
                })}
                onClick={() => setSwitching(e.id)}
              >
                {t("settings.gateways.switch")}
              </Button>
            ) : null}
            {e.remote ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("settings.gateways.pairAgainNamed", { name: e.name })}
                  onClick={() => run(gateways?.repair(e.id))}
                >
                  {t("settings.gateways.pairAgain")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("settings.gateways.forgetNamed", { name: e.name })}
                  onClick={() => run(gateways?.remove(e.id))}
                >
                  {t("settings.gateways.forget")}
                </Button>
              </>
            ) : null}
          </div>
          {e.origin ? (
            <code className="font-mono text-callout text-label-secondary">{e.origin}</code>
          ) : null}
          {switching === e.id ? (
            <SwitchChoice
              target={{ ...e, name: e.remote ? e.name : t("settings.gateways.thisMac") }}
              fromThisMac={current !== undefined && !current.remote && e.remote}
              onCancel={() => setSwitching(null)}
              onSwitch={(stopLocal) =>
                run(gateways?.switchTo(e.id, stopLocal ? { stopLocal: true } : undefined))
              }
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function GatewaysGroup(): ReactElement | null {
  const { gateways } = useSlots();
  const { entries, reload } = useSavedGateways();
  const [error, setError] = useState<string | null>(null);
  if (!gateways) return null;
  return (
    <Group title={t("settings.gateways.title")} description={t("settings.gateways.description")}>
      {error ? <ErrorNotice what={error} did={t("settings.shared.nothingChanged")} /> : null}
      {entries ? <GatewaysList entries={entries} onChanged={reload} onError={setError} /> : null}
      <AddGatewayForm onAdded={reload} />
    </Group>
  );
}
