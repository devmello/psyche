import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { type DiscoveredGateway, type GatewayEntry, useSlots } from "../../slots.tsx";
import { gatewayProblemText } from "./GatewaysGroup.tsx";
import { StatusChip, SwitchField } from "./shared.tsx";

/**
 * "Set up a remote server" (remote-gateway design §3.6). A fresh psyche-server prints a one-time
 * setup code; here the owner finds the server on the network (or types its address), types the
 * code, and both sides prove they know it before this computer pins the server and becomes its
 * first admin. Onboarding then runs against the server after switching to it. The address is
 * confirmed in a native dialog, like every add; there is no presence step.
 */

type Target = { by: { id: string } | { address: string }; name: string };

type Step =
  | { kind: "find" }
  | { kind: "code"; target: Target }
  | { kind: "done"; entry: GatewayEntry };

type Looking =
  | { kind: "looking" }
  | { kind: "failed" }
  | { kind: "done"; found: DiscoveredGateway[] };

const CLAIM_PROBLEMS = [
  "bad_code",
  "code_expired",
  "not_claimable",
  "unreachable",
  "cert_mismatch",
  "server_unproven",
  "maybe_claimed",
  "saved",
  "not_lan",
] as const;

/** The sentence for why a claim was refused, from `details.problem` (`claim_<why>`). */
export function claimProblemText(err: unknown): string {
  const details = (err as { details?: Record<string, unknown> } | null)?.details ?? {};
  const problem = typeof details.problem === "string" ? details.problem : "";
  if (problem === "claim_wrong_code") {
    const left = typeof details.attemptsLeft === "number" ? details.attemptsLeft : null;
    return left === null || left <= 0
      ? t("settings.remoteSetup.problem.wrong_code_wait")
      : t("settings.remoteSetup.problem.wrong_code", { count: left });
  }
  if (problem === "claim_too_many_attempts") {
    const sec = typeof details.retryAfterSec === "number" ? Math.max(1, details.retryAfterSec) : 60;
    return t("settings.remoteSetup.problem.too_many_attempts", { seconds: sec });
  }
  const why = problem.startsWith("claim_") ? problem.slice("claim_".length) : "";
  if (CLAIM_PROBLEMS.includes(why as (typeof CLAIM_PROBLEMS)[number])) {
    return t(`settings.remoteSetup.problem.${why as (typeof CLAIM_PROBLEMS)[number]}`);
  }
  if (problem.startsWith("claim_")) return t("settings.remoteSetup.problem.failed");
  // An address the app can't use at all (no host, a path…), or the native dialog was cancelled.
  return gatewayProblemText(err);
}

function FindServer({ onPick }: { onPick: (target: Target) => void }): ReactElement | null {
  const { gateways } = useSlots();
  const id = useId();
  const [looking, setLooking] = useState<Looking | null>(null);
  const [address, setAddress] = useState("");
  const discover = gateways?.discover;
  const look = useRef<() => void>(() => undefined);
  look.current = () => {
    if (!discover) return;
    setLooking({ kind: "looking" });
    discover().then(
      (found) => setLooking({ kind: "done", found }),
      () => setLooking({ kind: "failed" }),
    );
  };
  // Opening the setup is the owner's click: look at once.
  useEffect(() => look.current(), []);
  const claimable =
    looking?.kind === "done" ? looking.found.filter((d) => d.claimable && !d.conflict) : [];
  const others =
    looking?.kind === "done" ? looking.found.filter((d) => !d.claimable || d.conflict) : [];
  return (
    <div className="flex flex-col gap-3">
      {discover ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{t("settings.gateways.discoverTitle")}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={looking?.kind === "looking"}
              onClick={() => look.current()}
            >
              {looking?.kind === "looking"
                ? t("settings.gateways.discovering")
                : t("settings.gateways.discover")}
            </Button>
          </div>
          {looking?.kind === "failed" ? (
            <p role="alert" className="text-callout text-danger-text">
              {t("settings.remoteSetup.lookFailed")}
            </p>
          ) : null}
          {looking?.kind === "done" && claimable.length === 0 ? (
            <p role="status" className="text-callout text-label-secondary">
              {t("settings.remoteSetup.noneWaiting")}
            </p>
          ) : null}
          {claimable.length + others.length > 0 ? (
            <ul className="flex flex-col divide-y divide-gray-6">
              {claimable.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 first:pt-0">
                  <span className="min-w-0 flex-1 font-medium">{d.name}</span>
                  <StatusChip tone="neutral">{t("settings.remoteSetup.waiting")}</StatusChip>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={t("settings.remoteSetup.pickNamed", { name: d.name })}
                    onClick={() => onPick({ by: { id: d.id }, name: d.name })}
                  >
                    {t("settings.remoteSetup.pick")}
                  </Button>
                </li>
              ))}
              {others.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 first:pt-0">
                  <span className="min-w-0 flex-1 font-medium">{d.name}</span>
                  <span className="text-callout text-label-secondary">
                    {d.conflict
                      ? t("settings.gateways.discoverConflict")
                      : d.saved
                        ? t("settings.gateways.discoverSaved")
                        : t("settings.remoteSetup.alreadySetUp")}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const typed = address.trim();
          if (typed !== "") onPick({ by: { address: typed }, name: typed });
        }}
      >
        <Label htmlFor={`${id}-address`}>{t("settings.remoteSetup.addressLabel")}</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${id}-address`}
            className="min-w-0 flex-1"
            value={address}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("settings.remoteSetup.addressPlaceholder")}
            onChange={(e) => setAddress(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={address.trim() === ""}>
            {t("settings.remoteSetup.next")}
          </Button>
        </div>
        <p className="text-callout text-label-secondary">{t("settings.remoteSetup.addressHint")}</p>
      </form>
    </div>
  );
}

function EnterCode({
  target,
  onBack,
  onClaimed,
}: {
  target: Target;
  onBack: () => void;
  onClaimed: (entry: GatewayEntry) => void;
}): ReactElement | null {
  const { gateways } = useSlots();
  const id = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = gateways?.claim;
  if (!claim) return null;
  const submit = () => {
    setBusy(true);
    setError(null);
    claim(target.by, code.trim()).then(
      (entry) => {
        setBusy(false);
        onClaimed(entry);
      },
      (err: unknown) => {
        setBusy(false);
        setError(claimProblemText(err));
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
      <p className="font-medium">{t("settings.remoteSetup.codeTitle", { name: target.name })}</p>
      <Label htmlFor={`${id}-code`}>{t("settings.remoteSetup.codeLabel")}</Label>
      <Input
        id={`${id}-code`}
        className="font-mono"
        value={code}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={32}
        placeholder={t("settings.remoteSetup.codePlaceholder")}
        onChange={(e) => setCode(e.target.value)}
      />
      <p className="text-callout text-label-secondary">{t("settings.remoteSetup.codeHint")}</p>
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || code.trim() === ""}>
          {busy ? t("settings.remoteSetup.checking") : t("settings.remoteSetup.submit")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onBack}>
          {t("settings.remoteSetup.back")}
        </Button>
      </div>
    </form>
  );
}

export function RemoteServerSetup({
  onClose,
  onClaimed,
}: {
  /** Leaves the setup (Cancel, or Not now once the server is set up). */
  onClose: () => void;
  /** The server is saved; the owner hasn't switched yet. */
  onClaimed?: (entry: GatewayEntry) => void;
}): ReactElement | null {
  const { gateways } = useSlots();
  const [step, setStep] = useState<Step>({ kind: "find" });
  const [error, setError] = useState<string | null>(null);
  if (!gateways?.claim) return null;
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t("settings.remoteSetup.title")}
      data-testid="remote-server-setup"
    >
      {step.kind === "find" ? (
        <>
          <p className="text-callout text-label-secondary">{t("settings.remoteSetup.intro")}</p>
          <FindServer onPick={(target) => setStep({ kind: "code", target })} />
          <div>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      ) : null}
      {step.kind === "code" ? (
        <EnterCode
          target={step.target}
          onBack={() => setStep({ kind: "find" })}
          onClaimed={(entry) => {
            setStep({ kind: "done", entry });
            onClaimed?.(entry);
          }}
        />
      ) : null}
      {step.kind === "done" ? (
        <div className="flex flex-col gap-2" role="status">
          <p className="font-medium">
            {t("settings.remoteSetup.doneTitle", { name: step.entry.name })}
          </p>
          <p className="text-callout text-label-secondary">{t("settings.remoteSetup.doneBody")}</p>
          {error ? (
            <p role="alert" className="text-callout text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setError(null);
                gateways.switchTo(step.entry.id).then(
                  () => undefined,
                  (err: unknown) => setError(gatewayProblemText(err)),
                );
              }}
            >
              {t("settings.remoteSetup.switch", { name: step.entry.name })}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              {t("settings.remoteSetup.notNow")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * First run on This Mac: "Connect to a Psyche server" opens the same setup in place, for an owner
 * who installed psyche-server and wants Psyche to run there instead.
 */
export function ConnectServerEntry(): ReactElement | null {
  const { gateways } = useSlots();
  const [open, setOpen] = useState(false);
  if (!gateways?.claim) return null;
  if (open) return <RemoteServerSetup onClose={() => setOpen(false)} />;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-callout text-label-secondary">{t("settings.remoteSetup.firstRunHint")}</p>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t("settings.remoteSetup.connect")}
      </Button>
    </div>
  );
}

/**
 * Onboarding on a server that was just claimed (design §3.6): the server kept its network
 * listener on so this computer could reach it; the owner says here whether it stays on.
 */
export function KeepOnNetworkChoice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (keep: boolean) => void;
}): ReactElement {
  return (
    <SwitchField
      label={t("settings.remoteSetup.keepLan")}
      description={
        checked ? t("settings.remoteSetup.keepLanHint") : t("settings.remoteSetup.keepLanOffHint")
      }
      checked={checked}
      onChange={onChange}
    />
  );
}
