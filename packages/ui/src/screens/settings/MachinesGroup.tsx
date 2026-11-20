import type { Device, MachineInfo, MethodResult } from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import {
  type FormEvent,
  type ReactElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { groupFingerprint } from "../../lib/fingerprint.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { useSlots } from "../../slots.tsx";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import {
  approvalIdOf,
  EmptyNotice,
  ErrorNotice,
  Group,
  hasCode,
  messageOf,
  RadioField,
  SettingsApprovalContext,
  StatusChip,
} from "./shared.tsx";

/**
 * Settings → Devices → "Computers Psyche can use" (docs/design/linux-helper-only-2026.md §6.5 and
 * §8.1). The Linux computers the owner paired so the agent can use their screen, apps, shell and
 * files: an add sheet (network, account, the two commands, a green "paired" when it connects),
 * one row per computer with its account, its limits and its warnings, and rename and remove.
 *
 * Everything a row says comes from `machines.list`, which the Gateway stored or the box reported
 * for display only. The panel never writes a limit: the box's own `policy.json` decides, and
 * Settings only shows it.
 */

/** Dotted numeric versions: whether `a` is older than `b`. Anything else compares as not older. */
export function versionBefore(a: string, b: string): boolean {
  const part = (v: string) => v.replace(/^v/, "").split(/[.+-]/);
  const xs = part(a);
  const ys = part(b);
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = Number(xs[i] ?? 0);
    const y = Number(ys[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x < y;
  }
  return false;
}

/** The newest helper version among the paired computers: what the older ones are behind. */
export function newestHelperVersion(machines: readonly MachineInfo[]): string | null {
  let newest: string | null = null;
  for (const m of machines) {
    if (m.helperVersion == null) continue;
    if (newest === null || versionBefore(newest, m.helperVersion)) newest = m.helperVersion;
  }
  return newest;
}

/** The warnings the design (§6.5) names for a computer, in the order a row lists them. */
export type MachineWarning = "fullShell" | "userLimits" | "sudo";

export function machineWarnings(m: MachineInfo): MachineWarning[] {
  const out: MachineWarning[] = [];
  // The contained shell is only meaningful while commands are allowed at all.
  if (m.exec.enabled && !m.exec.contained) out.push("fullShell");
  if (m.policyOwner === "user") out.push("userLimits");
  if (m.passwordlessSudo) out.push("sudo");
  return out;
}

/** Where the install script puts the helper: the flag picks the account (design §6.5). */
export function installCommand(account: "own" | "dedicated"): string {
  return account === "dedicated" ? "sh install.sh --dedicated-user" : "sh install.sh";
}

/** What the owner runs on the new computer. The link carries a one-time secret. */
export function pairCommand(link: string): string {
  return `psyche-helper pair '${link}'`;
}

const DISPLAY_WORD = {
  headless: "machines.display.headless",
  desktop_session: "machines.display.desktopSession",
  container: "machines.display.container",
} as const;

const WARNING_KEY = {
  fullShell: "machines.warn.fullShell",
  userLimits: "machines.warn.userLimits",
  sudo: "machines.warn.sudo",
} as const;

/** The name a failed rename gives back. */
function renameError(err: unknown): string {
  if (hasCode(err, "conflict")) return t("machines.err.nameTaken");
  if (hasCode(err, "invalid_params")) return t("machines.err.nameInvalid");
  if (hasCode(err, "forbidden")) return t("machines.err.forbidden");
  return t("machines.err.failed", { reason: messageOf(err) });
}

export interface MachineIdentity {
  publicKey: string;
  pairedAt: string | null;
}

export interface MachinesPanelProps {
  machines: readonly MachineInfo[];
  /** By device id: the key and pairing date shown on a row. */
  identities?: Readonly<Record<string, MachineIdentity>>;
  now?: number;
  /** The helper version the Gateway expects; a computer behind it shows how to update. */
  latestHelperVersion?: string | null;
  error?: string | null;
  /** Renames a computer; rejects with the Gateway's error (`conflict` when the name is taken). */
  onRename?: (machine: MachineInfo, name: string) => Promise<unknown>;
  onRemove?: (machine: MachineInfo) => void;
  onWatch?: (machine: MachineInfo) => void;
  onOpenApps?: (machine: MachineInfo) => void;
  onOpenFolders?: (machine: MachineInfo) => void;
  onAdd?: () => void;
}

export function MachinesPanel({
  machines,
  identities = {},
  now,
  latestHelperVersion = null,
  error = null,
  onRename,
  onRemove,
  onWatch,
  onOpenApps,
  onOpenFolders,
  onAdd,
}: MachinesPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const addButton = onAdd ? (
    <Button type="button" size="sm" onClick={onAdd}>
      {t("machines.add")}
    </Button>
  ) : null;
  return (
    <Group
      title={t("machines.title")}
      description={machines.length > 0 ? t("machines.description") : undefined}
      actions={machines.length > 0 ? addButton : undefined}
    >
      {error ? <ErrorNotice what={error} did={t("settings.shared.nothingChanged")} /> : null}
      {machines.length === 0 ? (
        <EmptyNotice text={t("machines.empty")} action={addButton} />
      ) : (
        <ul className="flex flex-col divide-y divide-gray-6" data-testid="machines-list">
          {machines.map((m) => (
            <MachineRow
              key={m.id}
              machine={m}
              identity={identities[m.deviceId]}
              now={clock}
              latestHelperVersion={latestHelperVersion}
              {...(onRename ? { onRename } : {})}
              {...(onRemove ? { onRemove } : {})}
              {...(onWatch ? { onWatch } : {})}
              {...(onOpenApps ? { onOpenApps } : {})}
              {...(onOpenFolders ? { onOpenFolders } : {})}
            />
          ))}
        </ul>
      )}
    </Group>
  );
}

function MachineRow({
  machine: m,
  identity,
  now,
  latestHelperVersion,
  onRename,
  onRemove,
  onWatch,
  onOpenApps,
  onOpenFolders,
}: {
  machine: MachineInfo;
  identity: MachineIdentity | undefined;
  now: number;
  latestHelperVersion: string | null;
  onRename?: (machine: MachineInfo, name: string) => Promise<unknown>;
  onRemove?: (machine: MachineInfo) => void;
  onWatch?: (machine: MachineInfo) => void;
  onOpenApps?: (machine: MachineInfo) => void;
  onOpenFolders?: (machine: MachineInfo) => void;
}): ReactElement {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(m.name);
  const [renameFailed, setRenameFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const renameButton = useRef<HTMLButtonElement>(null);
  const online = m.status === "online";
  const warnings = machineWarnings(m);
  const behind =
    latestHelperVersion !== null &&
    m.helperVersion != null &&
    versionBefore(m.helperVersion, latestHelperVersion);
  const folders = m.files.roots.length;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (name === "" || name === m.name) {
      setRenaming(false);
      setRenameFailed(null);
      return;
    }
    setBusy(true);
    setRenameFailed(null);
    onRename?.(m, name).then(
      () => {
        setBusy(false);
        setRenaming(false);
        setTimeout(() => renameButton.current?.focus(), 0);
      },
      (err: unknown) => {
        setBusy(false);
        setRenameFailed(renameError(err));
      },
    );
  };

  return (
    <li
      className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0"
      data-testid="machine-row"
      data-status={m.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <form onSubmit={submit} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Label htmlFor={inputId} className="sr-only">
              {t("machines.rename.label", { name: m.name })}
            </Label>
            <Input
              id={inputId}
              value={draft}
              maxLength={64}
              autoFocus
              onChange={(e) => setDraft(e.currentTarget.value)}
              aria-invalid={renameFailed !== null}
              className="h-8 w-56"
            />
            <Button type="submit" size="xs" disabled={busy}>
              {t("machines.rename.save")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
                setRenameFailed(null);
                setDraft(m.name);
              }}
            >
              {t("machines.rename.cancel")}
            </Button>
          </form>
        ) : (
          <>
            <span className="font-medium">{m.name}</span>
            <StatusChip
              tone={online ? "success" : m.status === "degraded" ? "approval" : "neutral"}
            >
              {t(`machines.status.${m.status}`)}
            </StatusChip>
            {m.display != null ? (
              <span className="text-callout text-muted-foreground">
                {t(DISPLAY_WORD[m.display])}
              </span>
            ) : null}
            <span className="ms-auto flex items-center gap-1">
              {onWatch ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!online || !m.surfaces.includes("virtual_screen")}
                  aria-label={t("machines.watchNamed", { name: m.name })}
                  onClick={() => onWatch(m)}
                >
                  {t("machines.watch")}
                </Button>
              ) : null}
              {onOpenApps ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-label={t("machines.appsNamed", { name: m.name })}
                  onClick={() => onOpenApps(m)}
                >
                  {t("machines.apps")}
                </Button>
              ) : null}
              {onOpenFolders ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-label={t("machines.foldersNamed", { name: m.name })}
                  onClick={() => onOpenFolders(m)}
                >
                  {t("machines.folders")}
                </Button>
              ) : null}
              {onRename ? (
                <Button
                  ref={renameButton}
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={t("machines.rename.named", { name: m.name })}
                  onClick={() => {
                    setDraft(m.name);
                    setRenaming(true);
                  }}
                >
                  {t("machines.rename.action")}
                </Button>
              ) : null}
              {onRemove ? (
                <RowMoreMenu
                  name={m.name}
                  destructive={[
                    {
                      label: t("machines.remove"),
                      title: t("machines.removeTitle", { name: m.name }),
                      description: t("machines.removeDescription", { name: m.name }),
                      confirm: t("machines.remove"),
                      onConfirm: () => onRemove(m),
                    },
                  ]}
                />
              ) : null}
            </span>
          </>
        )}
      </div>
      {renameFailed ? (
        <p role="alert" className="text-callout text-danger-text">
          {renameFailed}
        </p>
      ) : null}

      {m.account === "own" ? (
        <div className="flex flex-col gap-1">
          <p className="text-callout text-label-secondary">
            {t("machines.account.own", { name: m.name })}
          </p>
          <details className="text-callout text-label-secondary">
            <summary className="cursor-pointer">{t("machines.account.useSeparate")}</summary>
            <p className="mt-1">{t("machines.account.useSeparateHint", { name: m.name })}</p>
            <code className="mt-1 inline-block rounded bg-gray-4 px-1 font-mono">
              {installCommand("dedicated")}
            </code>
          </details>
        </div>
      ) : (
        <p className="text-callout text-label-secondary">
          {t("machines.account.dedicated", { name: m.name })}
        </p>
      )}

      <p className="text-callout text-muted-foreground">
        {m.exec.enabled
          ? t(m.exec.contained ? "machines.shell.contained" : "machines.shell.full")
          : t("machines.shell.off")}
        {" · "}
        {t("machines.limits.folders", { count: folders })}
        {" · "}
        {m.helperVersion != null
          ? t("machines.helperVersion", { version: m.helperVersion })
          : t("machines.helperVersionUnknown")}
      </p>

      {behind ? (
        <p className="text-callout text-label-secondary" data-testid="machine-update">
          {t("machines.update", { name: m.name })}{" "}
          <code className="rounded bg-gray-4 px-1 font-mono">psyche-helper update</code>
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label={t("machines.warnings", { name: m.name })}>
          {warnings.map((w) => (
            <li key={w} className="flex gap-2 text-callout text-approval-text">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{t(WARNING_KEY[w], { name: m.name })}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-callout text-muted-foreground">
        {identity ? (
          <>
            {t("settings.devices.key")}{" "}
            <code className="font-mono">
              {(identity.publicKey.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ")}
            </code>
            {" · "}
            {identity.pairedAt !== null
              ? t("machines.paired", { when: formatRelative(identity.pairedAt, now) })
              : null}
            {identity.pairedAt !== null ? " · " : null}
          </>
        ) : null}
        {m.lastSeenAt
          ? t("settings.devices.lastSeen", { when: formatRelative(m.lastSeenAt, now) })
          : t("settings.devices.lastSeenNever")}
      </p>
    </li>
  );
}

// --- The add sheet -----------------------------------------------------------------------------

type Via = "address" | "lan";
type Account = "own" | "dedicated";
type Made = MethodResult<"devices.setupToken.create">;

function createError(err: unknown, via: Via): string {
  if (hasCode(err, "unavailable")) {
    return via === "lan" ? t("settings.pair.err.noLan") : t("settings.pair.err.noAddress");
  }
  if (hasCode(err, "rate_limited")) return t("settings.pair.err.tooMany");
  if (hasCode(err, "forbidden")) return t("settings.pair.err.forbidden");
  return t("settings.pair.err.failed", { reason: messageOf(err) });
}

function CopyRow({
  label,
  text,
  secret = false,
}: {
  label: string;
  text: string;
  /** Holds a one-time secret: cleared from the clipboard after a minute. */
  secret?: boolean;
}): ReactElement {
  const { writeClipboard } = useSlots();
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-callout text-label-secondary">
        {label}
      </Label>
      <div className="flex items-start gap-2">
        <textarea
          id={id}
          readOnly
          rows={secret ? 3 : 1}
          value={text}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 resize-none rounded-md border border-gray-6 bg-gray-2 px-2 py-1 font-mono text-callout"
        />
        {writeClipboard ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void writeClipboard(text, secret ? { clearAfterMs: 60_000 } : undefined).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? t("settings.remote.copied") : t("machines.copy")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export interface AddMachineSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now?: number;
}

/**
 * The sheet that adds a Linux computer (design §8.1): pick the network, pick the account, then
 * the install command and `psyche-helper pair '…'`, and wait until the computer pairs. The setup
 * token is made only when the owner asks for the commands (it lasts ten minutes and works once),
 * and making it asks for presence like any pairing link does.
 */
export function AddMachineSheet({
  open,
  onOpenChange,
  now: fixedNow,
}: AddMachineSheetProps): ReactElement {
  const call = useCall();
  const requestApproval = useContext(SettingsApprovalContext);
  const info = useGatewayQuery("gateway.info", {}, { enabled: open });
  const tokens = useGatewayQuery("devices.setupToken.list", {}, { enabled: open });
  const machinesQ = useGatewayQuery("machines.list", {}, { enabled: open });
  const clock = useNow(5_000, fixedNow);
  const [chosenVia, setChosenVia] = useState<Via | null>(null);
  const [account, setAccount] = useState<Account>("own");
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = useRef<ReadonlySet<string> | null>(null);
  const reloadTokens = tokens.reload;
  const reloadMachines = machinesQ.reload;
  const madeId = made?.setupToken.id;

  const address = info.data?.publicOrigin ?? null;
  const lan = info.data?.lan;
  const lanReady =
    lan?.enabled === true &&
    lan.listening.length > 0 &&
    lan.certSpki !== null &&
    lan.origin !== null;
  const settled = info.data !== undefined;
  const reachable = address !== null || lanReady;
  const via: Via = chosenVia ?? (address === null && lanReady ? "lan" : "address");

  // While the commands are on screen, look for the computer arriving.
  useEffect(() => {
    if (madeId === undefined) return;
    const timer = setInterval(() => {
      reloadTokens();
      reloadMachines();
    }, 3_000);
    return () => clearInterval(timer);
  }, [madeId, reloadTokens, reloadMachines]);

  const machines = machinesQ.data?.machines ?? [];
  if (madeId !== undefined && known.current === null) {
    known.current = new Set(machines.map((m) => m.id));
  }
  const used = tokens.data?.setupTokens.find((s) => s.id === madeId);
  const arrived =
    madeId === undefined
      ? undefined
      : machines.find(
          (m) =>
            (used?.usedByDeviceId != null && m.deviceId === used.usedByDeviceId) ||
            known.current?.has(m.id) === false,
        );
  const lapsed =
    made !== undefined && made !== null && Date.parse(made.setupToken.expiresAt) <= clock;

  const reset = () => {
    setMade(null);
    setError(null);
    setBusy(false);
    setChosenVia(null);
    setAccount("own");
    known.current = null;
  };

  const finish = (result: Made) => {
    known.current = new Set(machines.map((m) => m.id));
    setMade(result);
    tokens.reload();
  };

  const make = () => {
    setBusy(true);
    setError(null);
    const extra = via === "lan" ? ({ via: "lan" } as const) : {};
    const params = { purpose: "machine", ...extra } as const;
    call("devices.setupToken.create", params).then(
      (result) => {
        setBusy(false);
        finish(result);
      },
      (err: unknown) => {
        setBusy(false);
        const approvalId = approvalIdOf(err);
        if (approvalId === null) {
          setError(createError(err, via));
          return;
        }
        if (requestApproval === null) {
          setError(t("settings.pair.err.forbidden"));
          return;
        }
        requestApproval({
          key: "devices.setupToken",
          label: t("machines.add"),
          approvalId,
          retry: (approved) =>
            call("devices.setupToken.create", { ...params, approvalId: approved }).then(
              (result) => {
                finish(result);
                return result;
              },
              (retryErr: unknown) => {
                setError(createError(retryErr, via));
                throw retryErr;
              },
            ),
        });
      },
    );
  };

  const close = (o: boolean) => {
    if (!o) {
      if (arrived) toast(t("machines.add.pairedToast", { name: arrived.name }));
      reset();
    }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="add-machine">
        <DialogHeader>
          <DialogTitle>{t("machines.add")}</DialogTitle>
          <DialogDescription>{t("machines.add.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error ? <ErrorNotice what={error} did={t("settings.shared.nothingChanged")} /> : null}

          {settled && !reachable ? (
            <p role="status" className="text-callout text-approval-text">
              {t("machines.add.needsNetwork")}
            </p>
          ) : null}

          {made === null ? (
            <>
              {lanReady && address !== null ? (
                <RadioField
                  label={t("settings.pair.via")}
                  value={via}
                  options={[
                    { value: "address" as Via, label: t("settings.pair.viaAddress") },
                    {
                      value: "lan" as Via,
                      label: t("settings.pair.viaLan"),
                      hint: t("settings.pair.viaLanHint"),
                    },
                  ]}
                  onChange={(v) => setChosenVia(v)}
                />
              ) : null}
              <RadioField
                label={t("machines.add.account")}
                value={account}
                options={[
                  {
                    value: "own" as Account,
                    label: t("machines.add.account.own"),
                    hint: t("machines.add.account.ownHint"),
                  },
                  {
                    value: "dedicated" as Account,
                    label: t("machines.add.account.dedicated"),
                    hint: t("machines.add.account.dedicatedHint"),
                  },
                ]}
                onChange={(v) => setAccount(v)}
              />
            </>
          ) : (
            <section
              aria-label={t("machines.add.commands")}
              className="flex flex-col gap-3"
              data-testid="machine-commands"
            >
              <CopyRow label={t("machines.add.installStep")} text={installCommand(account)} />
              <CopyRow label={t("machines.add.pairStep")} text={pairCommand(made.link)} secret />
              <p className="text-callout text-label-secondary">
                {t("machines.add.expires", {
                  when: formatRelative(made.setupToken.expiresAt, clock),
                })}{" "}
                <span className="text-approval-text">{t("settings.pair.secret")}</span>
              </p>
              <p className="text-callout text-label-secondary">
                {t("settings.pair.compare", {
                  fingerprint: groupFingerprint(made.gatewayFingerprint),
                })}
              </p>
              {arrived ? (
                <p
                  role="status"
                  className="rounded-md border border-success-border bg-success-fill px-3 py-2 text-callout text-success-text"
                  data-testid="machine-paired"
                >
                  {t("machines.add.paired", { name: arrived.name })}
                </p>
              ) : lapsed ? (
                <p role="status" className="text-callout text-label-secondary">
                  {t("settings.pair.gone")}
                </p>
              ) : (
                <p role="status" className="text-callout text-label-secondary">
                  {t("machines.add.waiting")}
                </p>
              )}
            </section>
          )}
        </div>
        <DialogFooter>
          {made === null || lapsed ? (
            <Button type="button" disabled={busy || !reachable} onClick={make}>
              {t(lapsed ? "machines.add.again" : "machines.add.make")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={arrived ? "default" : "outline"}
            onClick={() => close(false)}
          >
            {t("machines.add.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- The connected group -----------------------------------------------------------------------

/** `machines.list` for Settings: the same data the group and the Computer use picker read. */
export function useMachines(): { machines: MachineInfo[]; loading: boolean; error: string | null } {
  const q = useGatewayQuery("machines.list", {});
  return { machines: q.data?.machines ?? [], loading: q.loading, error: q.error };
}

export function MachinesGroup({
  now,
  onOpenApps,
  onOpenFolders,
}: {
  now?: number;
  /** Opens Settings → Computer use on that computer. */
  onOpenApps?: (machine: MachineInfo) => void;
  /** Opens Settings → File access on that computer. */
  onOpenFolders?: (machine: MachineInfo) => void;
}): ReactElement {
  const call = useCall();
  const machinesQ = useGatewayQuery("machines.list", {});
  const devicesQ = useGatewayQuery("devices.list", {});
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const machines = machinesQ.data?.machines ?? [];
  const identities: Record<string, MachineIdentity> = {};
  for (const d of (devicesQ.data?.devices ?? []) as Device[]) {
    identities[d.id] = { publicKey: d.publicKey, pairedAt: d.pairedAt ?? null };
  }
  return (
    <>
      <MachinesPanel
        machines={machines}
        identities={identities}
        latestHelperVersion={newestHelperVersion(machines)}
        error={actionError ?? (machinesQ.error && machines.length === 0 ? machinesQ.error : null)}
        {...(now === undefined ? {} : { now })}
        onAdd={() => setAdding(true)}
        onRename={(m, name) => call("machines.rename", { id: m.id, name }).then(machinesQ.reload)}
        onRemove={(m) => {
          setActionError(null);
          call("devices.revoke", { deviceId: m.deviceId }).then(
            () => {
              machinesQ.reload();
              devicesQ.reload();
            },
            (err: unknown) => setActionError(t("machines.err.failed", { reason: messageOf(err) })),
          );
        }}
        onWatch={(m) => {
          setActionError(null);
          call("view.open", { pane: "computer-watch", target: m.id }).catch((err: unknown) =>
            setActionError(t("machines.err.failed", { reason: messageOf(err) })),
          );
        }}
        {...(onOpenApps ? { onOpenApps } : {})}
        {...(onOpenFolders ? { onOpenFolders } : {})}
      />
      <AddMachineSheet
        open={adding}
        onOpenChange={(o) => {
          setAdding(o);
          if (!o) machinesQ.reload();
        }}
        {...(now === undefined ? {} : { now })}
      />
    </>
  );
}
