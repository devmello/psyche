import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { groupFingerprint } from "../../lib/fingerprint.ts";
import { type DiscoveredGateway, type GatewayEntry, useSlots } from "../../slots.tsx";
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
  "link_not_a_pairing_link",
  "link_unsupported_version",
  "link_malformed",
  "link_extra_fields",
  "link_bad_field",
  "link_pin_mismatch",
  "link_lan",
  "link_not_lan",
] as const;

/** What the field holds is a pairing link, not an address. */
export const isPairingLinkText = (text: string): boolean => /^psyche-pair:/i.test(text.trim());

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
  onAdded: (entry: GatewayEntry, viaLink: boolean) => void;
}): ReactElement | null {
  const { gateways } = useSlots();
  const id = useId();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  // A link that arrived while the owner had already typed something: offered, never swapped in.
  const [incoming, setIncoming] = useState<string | null>(null);
  const addressNow = useRef(address);
  addressNow.current = address;
  const takePending = gateways?.takePendingLink;
  const onPending = gateways?.onPendingLink;
  // A pairing link the OS opened in the app waits in main; showing it here is all that happens.
  // The owner still presses Add, and main confirms the address in a native dialog.
  useEffect(() => {
    if (!takePending) return;
    const take = () =>
      void takePending().then(
        (link) => {
          if (link === null) return;
          if (addressNow.current.trim() !== "") {
            setIncoming(link);
            return;
          }
          setAddress(link);
          setOpened(true);
          setError(null);
        },
        () => undefined,
      );
    take();
    return onPending?.(take);
  }, [takePending, onPending]);
  if (!gateways) return null;
  const viaLink = isPairingLinkText(address);
  const submit = () => {
    setBusy(true);
    setError(null);
    const adding =
      viaLink && gateways.addLink
        ? gateways.addLink(address.trim())
        : gateways.add(address, name.trim() === "" ? undefined : name.trim());
    adding.then(
      (entry) => {
        setBusy(false);
        setAddress("");
        setName("");
        setOpened(false);
        onAdded(entry, viaLink);
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
            aria-describedby={opened ? `${id}-opened` : undefined}
          />
        </div>
        <div className="flex min-w-40 flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t("settings.gateways.nameLabel")}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            disabled={viaLink}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={busy || address.trim() === ""}>
          {t("settings.gateways.adding")}
        </Button>
      </div>
      {incoming !== null ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-callout">
          <span>{t("settings.gateways.newLink")}</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              setAddress(incoming);
              setIncoming(null);
              setOpened(true);
              setError(null);
            }}
          >
            {t("settings.gateways.useNewLink")}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setIncoming(null)}>
            {t("settings.gateways.ignoreNewLink")}
          </Button>
        </div>
      ) : null}
      {opened ? (
        <p id={`${id}-opened`} role="status" className="text-callout text-label-secondary">
          {t("settings.gateways.fromLink")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </form>
  );
}

type Looking =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "failed" }
  | { kind: "done"; found: DiscoveredGateway[] };

/**
 * Add a Gateway → On this network (remote-gateway design §3.2). Looks for Psyche that announced
 * itself with Bonjour, on the owner's click. What a computer announces is a claim: picking one
 * only adds it to the saved list (after the same native confirmation) and it still goes through
 * pairing and the key pin. The window adds a listing by its id, never by an address.
 */
export function DiscoverGateways({
  onAdded,
}: {
  onAdded: (entry: GatewayEntry) => void;
}): ReactElement | null {
  const { gateways } = useSlots();
  const [state, setState] = useState<Looking>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  if (!gateways?.discover) return null;
  const look = () => {
    setState({ kind: "looking" });
    setError(null);
    gateways.discover?.().then(
      (found) => setState({ kind: "done", found }),
      () => setState({ kind: "failed" }),
    );
  };
  const add = (d: DiscoveredGateway) => {
    setError(null);
    gateways.addDiscovered?.(d.id).then(
      (entry) => {
        setState((s) =>
          s.kind === "done"
            ? {
                kind: "done",
                found: s.found.map((f) => (f.id === d.id ? { ...f, saved: true } : f)),
              }
            : s,
        );
        onAdded(entry);
      },
      (err: unknown) => setError(gatewayProblemText(err)),
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{t("settings.gateways.discoverTitle")}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={state.kind === "looking"}
          onClick={look}
        >
          {state.kind === "looking"
            ? t("settings.gateways.discovering")
            : t("settings.gateways.discover")}
        </Button>
      </div>
      {state.kind === "failed" ? (
        <p role="alert" className="text-callout text-danger-text">
          {t("settings.gateways.discoverFailed")}
        </p>
      ) : null}
      {state.kind === "done" && state.found.length === 0 ? (
        <p role="status" className="text-callout text-label-secondary">
          {t("settings.gateways.discoverNone")}
        </p>
      ) : null}
      {state.kind === "done" && state.found.length > 0 ? (
        <>
          <ul className="flex flex-col divide-y divide-gray-6">
            {state.found.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 first:pt-0">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{d.name}</span>
                  {d.fingerprint ? (
                    <code className="font-mono text-callout text-label-secondary">
                      {t("settings.gateways.discoverKey", {
                        fingerprint: groupFingerprint(d.fingerprint),
                      })}
                    </code>
                  ) : null}
                </span>
                {d.conflict ? (
                  <span className="text-callout text-danger-text">
                    {t("settings.gateways.discoverConflict")}
                  </span>
                ) : d.saved ? (
                  <span className="text-callout text-label-secondary">
                    {t("settings.gateways.discoverSaved")}
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    aria-label={t("settings.gateways.discoverAdd", { name: d.name })}
                    onClick={() => add(d)}
                  >
                    {t("settings.gateways.adding")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-callout text-label-secondary">{t("settings.gateways.discoverHint")}</p>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
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
      <DiscoverGateways onAdded={reload} />
      <AddGatewayForm onAdded={reload} />
    </Group>
  );
}
