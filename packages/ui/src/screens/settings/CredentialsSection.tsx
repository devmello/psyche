import type {
  CredentialBinding,
  CredentialKind,
  CredentialMeta,
  CredentialSecretInput,
} from "@psyche/protocol";
import { CreditCard, Ellipsis, KeyRound, Pencil, Search, X } from "lucide-react";
import { type FormEvent, Fragment, type ReactElement, useId, useState } from "react";
import { EmptyState } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { useCall, useGatewayQuery, usePayments } from "../../data/hooks.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { useSlots } from "../../slots.tsx";
import { CredentialDetailSheet } from "./CredentialDetail.tsx";
import {
  EXTERNAL_NAME,
  type ExternalLink,
  type ExternalSource,
  type LinkableKind,
  LinkExternalForm,
  linkExternalError,
} from "./CredentialExternal.tsx";
import {
  ImportCredentialsForm,
  type ImportFormat,
  type ImportOutcome,
} from "./CredentialImport.tsx";
import { PaymentsGroup, type PaymentsView } from "./CredentialPayments.tsx";
import { bindingLabel, cardRefusal, credentialKindLabel } from "./credential-labels.ts";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import {
  EmptyNotice,
  ErrorNotice,
  Group,
  hasCode,
  LoadGate,
  type LoadProps,
  messageOf,
  RadioField,
  SectionFrame,
  type SettingsFormProps,
  str,
  useSettingsForm,
} from "./shared.tsx";

/** Credentials (UI design §3.18; architecture §4.7). Values never reach this screen. */

export { bindingLabel, cardRefusal, credentialKindLabel } from "./credential-labels.ts";

/** True when the search text matches the item's name, slug, kind or a site it is bound to. */
export function matchesCredential(c: CredentialMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [c.name, c.slug, credentialKindLabel(c.kind), ...c.bindings.map(bindingLabel)].some(
    (text) => text.toLowerCase().includes(q),
  );
}

/**
 * "github.com" or "https://github.com/login" → `{ origin: "https://github.com" }`; SSH keys bind
 * to a host instead. `null` when the text is not a site.
 */
export function parseBinding(text: string, kind: CredentialKind): CredentialBinding | null {
  const raw = text.trim();
  if (raw === "" || /\s/.test(raw)) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (kind === "ssh_key") return url.hostname === "" ? null : { host: url.host };
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return { origin: url.origin };
  } catch {
    return null;
  }
}

const sameBinding = (a: CredentialBinding, b: CredentialBinding): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** What an edit changes; fields left out stay as they are (`vault.update`). */
export interface CredentialPatch {
  name?: string;
  bindings?: CredentialBinding[];
  secret?: CredentialSecretInput;
}

export interface NewCredential {
  kind: CredentialKind;
  name: string;
  bindings: CredentialBinding[];
  secret: CredentialSecretInput;
}

export interface CredentialsPanelProps extends SettingsFormProps, LoadProps {
  credentials: readonly CredentialMeta[];
  now?: number;
  onAdd?: (item: NewCredential) => void;
  onConnectManager?: (manager: "1password" | "bitwarden") => void;
  addError?: string | null;
  /** Opens with the Add item form showing (stories). */
  defaultAdding?: boolean;
  /** Saves an edit; a rejected promise keeps the form open. */
  onUpdate?: (credential: CredentialMeta, patch: CredentialPatch) => Promise<void> | void;
  /** Deletes an item after the owner confirms. */
  onDelete?: (credential: CredentialMeta) => Promise<void> | void;
  /** Opens the Settings section that manages a Gateway-owned item (#511). */
  onOpenSetting?: (setting: ManagedSetting) => void;
  /** A failed edit or delete. */
  itemError?: string | null;
  /** Stories: open with this search text, or with this item's edit form showing. */
  defaultQuery?: string;
  defaultEditingId?: string;
  /** Sends a CSV export to `vault.import`; rejects with an Error to show. */
  onImport?: (format: ImportFormat, csv: string) => Promise<ImportOutcome>;
  /** Stories: open with the import form showing. */
  defaultImporting?: boolean;
  /** Opens an item's detail and recent uses. */
  onOpen?: (credential: CredentialMeta) => void;
  /**
   * Links an item held in 1Password or Bitwarden by reference (`vault.linkExternal`); rejects to
   * show. Takes the place of `onConnectManager` for both.
   */
  onLinkExternal?: (item: ExternalLink) => Promise<void>;
  /** Stories: open with a link form showing (`true` = 1Password). */
  defaultLinking?: boolean | ExternalSource;
  /** Stripe Link payment methods and recent spends; the group is hidden without it. */
  payments?: PaymentsView;
  /** Opens the task behind a payment. */
  onOpenTask?: (taskId: string) => void;
}

export function CredentialsPanel({
  credentials,
  values,
  onChange,
  needsApproval,
  now,
  onAdd,
  onConnectManager,
  addError = null,
  defaultAdding = false,
  onUpdate,
  onDelete,
  onOpenSetting,
  itemError = null,
  defaultQuery = "",
  defaultEditingId,
  onImport,
  defaultImporting = false,
  onOpen,
  onLinkExternal,
  defaultLinking = false,
  payments,
  onOpenTask,
  loading,
  error,
  onRetry,
}: CredentialsPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const [adding, setAdding] = useState(defaultAdding);
  const [query, setQuery] = useState(defaultQuery);
  const [editingId, setEditingId] = useState<string | null>(defaultEditingId ?? null);
  const [importing, setImporting] = useState(defaultImporting);
  const [linking, setLinking] = useState<ExternalSource | null>(
    defaultLinking === true ? "1password" : defaultLinking === false ? null : defaultLinking,
  );
  const shown = credentials.filter((c) => matchesCredential(c, query));
  const actions = onUpdate !== undefined || onDelete !== undefined;
  const columns = actions ? 6 : 5;
  const backend = str(values, "vault.backend", "psyche");
  const fill = str(values, "vault.fillDefault", "once");
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.credentials.title")}
      description={t("settings.credentials.description")}
    >
      <LoadGate
        label={t("settings.credentials.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.credentials.storage")}>
          <RadioField
            label={t("settings.key.vault.backend")}
            inline
            value={backend}
            settingKey="vault.backend"
            onChange={(v) => onChange("vault.backend", v)}
            options={[
              { value: "psyche", label: t("settings.credentials.backend.psyche") },
              { value: "keychain", label: t("settings.credentials.backend.keychain") },
              { value: "external", label: t("settings.credentials.backend.external") },
            ]}
          />
          <RadioField
            label={t("settings.key.vault.fillDefault")}
            inline
            value={fill}
            settingKey="vault.fillDefault"
            onChange={(v) => onChange("vault.fillDefault", v)}
            options={[
              { value: "once", label: t("settings.credentials.fill.once") },
              { value: "site", label: t("settings.credentials.fill.site") },
            ]}
          />
        </Group>

        <Group
          title={t("settings.credentials.items")}
          actions={
            credentials.length === 0 && !adding && linking === null ? undefined : (
              <div className="flex items-center gap-1">
                {onAdd ? (
                  <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={adding}>
                    {t("settings.credentials.addItem")}
                  </Button>
                ) : null}
                <MoreWaysToAdd
                  {...(onImport ? { onImport: () => setImporting(true) } : {})}
                  {...(onLinkExternal ? { onLinkExternal: setLinking } : {})}
                  {...(onConnectManager ? { onConnectManager } : {})}
                />
              </div>
            )
          }
        >
          {addError ? (
            <ErrorNotice what={addError} did={t("settings.credentials.nothingStored")} />
          ) : null}
          {adding && onAdd ? (
            <AddCredentialForm
              onCancel={() => setAdding(false)}
              onAdd={(item) => {
                onAdd(item);
                setAdding(false);
              }}
            />
          ) : null}
          {itemError ? (
            <ErrorNotice what={itemError} did={t("settings.shared.nothingChanged")} />
          ) : null}
          {importing && onImport ? (
            <ImportCredentialsForm onImport={onImport} onClose={() => setImporting(false)} />
          ) : null}
          {linking !== null && onLinkExternal ? (
            <LinkExternalForm
              key={linking}
              source={linking}
              onLink={onLinkExternal}
              onClose={() => setLinking(null)}
              parseSite={(text, kind: LinkableKind) => parseBinding(text, kind)}
            />
          ) : null}
          {credentials.length > 0 ? (
            <div className="relative max-w-sm">
              <Search
                className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label={t("settings.credentials.search")}
                placeholder={t("settings.credentials.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="ps-8"
              />
            </div>
          ) : null}
          {credentials.length === 0 ? (
            adding || importing || linking !== null ? null : (
              <EmptyState
                icon={KeyRound}
                {...(onAdd
                  ? {
                      action: {
                        label: t("settings.credentials.addItem"),
                        onClick: () => setAdding(true),
                      },
                    }
                  : {})}
              >
                {t("settings.credentials.empty")}
                {onImport || onLinkExternal || onConnectManager ? (
                  <span className="mt-2 flex justify-center">
                    <MoreWaysToAdd
                      {...(onImport ? { onImport: () => setImporting(true) } : {})}
                      {...(onLinkExternal ? { onLinkExternal: setLinking } : {})}
                      {...(onConnectManager ? { onConnectManager } : {})}
                    />
                  </span>
                ) : null}
              </EmptyState>
            )
          ) : shown.length === 0 ? (
            <EmptyNotice
              text={t("settings.credentials.noMatch", { query: query.trim() })}
              action={
                <Button type="button" variant="ghost" size="sm" onClick={() => setQuery("")}>
                  {t("settings.credentials.clearSearch")}
                </Button>
              }
            />
          ) : (
            <Table aria-label={t("settings.credentials.table")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("settings.credentials.col.name")}</TableHead>
                  <TableHead scope="col">{t("settings.credentials.col.kind")}</TableHead>
                  <TableHead scope="col">{t("settings.credentials.col.boundTo")}</TableHead>
                  <TableHead scope="col">{t("settings.credentials.col.lastUsed")}</TableHead>
                  <TableHead scope="col">{t("settings.credentials.col.uses")}</TableHead>
                  {actions ? (
                    <TableHead scope="col">
                      <span className="sr-only">{t("settings.credentials.col.actions")}</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((c) => (
                  <Fragment key={c.id}>
                    <TableRow>
                      <TableCell>
                        {onOpen ? (
                          <button
                            type="button"
                            className="text-start font-medium underline-offset-2 hover:underline focus-visible:underline"
                            onClick={() => onOpen(c)}
                          >
                            {c.name}
                          </button>
                        ) : (
                          <span className="font-medium">{c.name}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {credentialKindLabel(c.kind)}
                        {c.backend !== undefined && c.backend !== "vault" ? (
                          <span className="block text-xs text-muted-foreground">
                            {t(`settings.credentials.backendIn.${c.backend}`)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {c.bindings.map(bindingLabel).join(", ") ||
                          t("settings.credentials.anySite")}
                      </TableCell>
                      <TableCell>
                        {c.lastUsedAt
                          ? formatRelative(c.lastUsedAt, clock)
                          : t("settings.credentials.never")}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {activeI18n().number(c.useCount)}
                      </TableCell>
                      {actions ? (
                        <TableCell className="text-end">
                          {managedOf(c) ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="text-xs text-muted-foreground">
                                {managedLabel(managedOf(c)?.kind ?? "connector")}
                              </span>
                              {onOpenSetting ? (
                                <RowMoreMenu
                                  name={c.name}
                                  items={[
                                    {
                                      label: t("settings.credentials.removeIn", {
                                        setting: settingLabel(
                                          managedOf(c)?.setting ?? "connectors",
                                        ),
                                      }),
                                      onClick: () =>
                                        onOpenSetting(managedOf(c)?.setting ?? "connectors"),
                                    },
                                  ]}
                                />
                              ) : null}
                            </span>
                          ) : (
                            <span className="inline-flex gap-1">
                              {onUpdate ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t("settings.credentials.editItem", { name: c.name })}
                                  aria-expanded={editingId === c.id}
                                  onClick={() => setEditingId(editingId === c.id ? null : c.id)}
                                >
                                  <Pencil aria-hidden="true" />
                                </Button>
                              ) : null}
                              {onDelete ? (
                                <RowMoreMenu
                                  name={c.name}
                                  destructive={[
                                    {
                                      label: t("common.remove"),
                                      title: t("settings.credentials.removeTitle", {
                                        name: c.name,
                                      }),
                                      description: isExternalLink(c)
                                        ? t("settings.credentials.removeLinkDescription", {
                                            manager: managerName(c),
                                          })
                                        : deleteDescription(c),
                                      confirm: t("common.remove"),
                                      onConfirm: () => {
                                        if (editingId === c.id) setEditingId(null);
                                        void Promise.resolve(onDelete(c)).catch(() => undefined);
                                      },
                                    },
                                  ]}
                                />
                              ) : null}
                            </span>
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                    {editingId === c.id && onUpdate && managedOf(c) === null ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={columns} className="whitespace-normal">
                          <EditCredentialForm
                            credential={c}
                            onCancel={() => setEditingId(null)}
                            onSave={(patch) =>
                              Promise.resolve(onUpdate(c, patch)).then(
                                () => setEditingId(null),
                                () => undefined,
                              )
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </Group>
        {payments ? (
          <PaymentsGroup view={payments} now={clock} {...(onOpenTask ? { onOpenTask } : {})} />
        ) : null}
      </LoadGate>
    </SectionFrame>
  );
}

/** Import and password-manager connections, under one menu beside the primary Add item. */
function MoreWaysToAdd({
  onImport,
  onLinkExternal,
  onConnectManager,
}: {
  onImport?: () => void;
  /** Opens the link-by-reference form for a manager; takes the place of `onConnectManager`. */
  onLinkExternal?: (source: ExternalSource) => void;
  onConnectManager?: (manager: "1password" | "bitwarden") => void;
}): ReactElement | null {
  const connect = onLinkExternal ?? onConnectManager;
  if (onImport === undefined && connect === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("settings.credentials.moreWays")}
          />
        }
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onImport ? (
          <DropdownMenuItem onClick={onImport}>
            {t("settings.credentials.importCsv")}
          </DropdownMenuItem>
        ) : null}
        {connect
          ? (["1password", "bitwarden"] as const).map((m) => (
              <DropdownMenuItem key={m} onClick={() => connect(m)}>
                {t("settings.credentials.connectManager", { name: EXTERNAL_NAME[m] })}
              </DropdownMenuItem>
            ))
          : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The secret fields an edit can replace, per kind; blank keeps the stored value. */
const SECRET_FIELDS: Partial<
  Record<CredentialKind, readonly { key: keyof CredentialSecretInput; label: () => string }[]>
> = {
  login: [
    { key: "username", label: () => t("settings.credentials.new.username") },
    { key: "password", label: () => t("settings.credentials.new.password") },
  ],
  api_key: [{ key: "token", label: () => t("settings.credentials.new.key") }],
  payment_link: [{ key: "token", label: () => t("settings.credentials.new.paymentToken") }],
  ssh_key: [{ key: "privateKey", label: () => t("settings.credentials.new.privateKey") }],
  note: [{ key: "text", label: () => t("settings.credentials.new.noteText") }],
};

function EditCredentialForm({
  credential,
  onSave,
  onCancel,
}: {
  credential: CredentialMeta;
  onSave: (patch: CredentialPatch) => Promise<void>;
  onCancel: () => void;
}): ReactElement {
  const id = useId();
  const [name, setName] = useState(credential.name);
  const [bindings, setBindings] = useState<CredentialBinding[]>(credential.bindings);
  const [site, setSite] = useState("");
  const [siteError, setSiteError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Partial<Record<keyof CredentialSecretInput, string>>>({});
  const [saving, setSaving] = useState(false);
  // An external manager's values stay there: only the item's name and sites change here.
  const external =
    credential.backend === "1password" || credential.backend === "bitwarden"
      ? EXTERNAL_NAME[credential.backend]
      : null;
  const fields = external !== null ? [] : (SECRET_FIELDS[credential.kind] ?? []);

  const addSite = () => {
    const b = parseBinding(site, credential.kind);
    if (b === null) {
      setSiteError(t("settings.credentials.siteError"));
      return;
    }
    setSiteError(null);
    setSite("");
    if (!bindings.some((x) => sameBinding(x, b))) setBindings([...bindings, b]);
  };

  const patch: CredentialPatch = {};
  if (name.trim() !== "" && name.trim() !== credential.name) patch.name = name.trim();
  if (
    bindings.length !== credential.bindings.length ||
    bindings.some((b, i) => !sameBinding(b, credential.bindings[i] as CredentialBinding))
  ) {
    patch.bindings = bindings;
  }
  const changedSecret = Object.fromEntries(
    Object.entries(secret).filter(([, v]) => v !== undefined && v !== ""),
  ) as CredentialSecretInput;
  if (Object.keys(changedSecret).length > 0) patch.secret = changedSecret;
  const changed = Object.keys(patch).length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!changed || name.trim() === "" || saving) return;
    setSaving(true);
    void onSave(patch).finally(() => setSaving(false));
  };

  return (
    <form
      onSubmit={submit}
      aria-label={t("settings.credentials.editItem", { name: credential.name })}
      className="flex flex-col gap-4 rounded-lg border border-gray-6 bg-background p-4"
    >
      <p className="text-xs text-muted-foreground">
        {external
          ? t("settings.credentials.editExternal", { manager: external })
          : t("settings.credentials.editBlankKeeps")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t("settings.credentials.col.name")}</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {fields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            <Label htmlFor={`${id}-${f.key}`} className="gap-1.5">
              {f.key === "username" ? null : <KeyRound className="size-3.5" aria-hidden="true" />}
              {f.label()}
            </Label>
            <Input
              id={`${id}-${f.key}`}
              type={f.key === "username" ? "text" : "password"}
              autoComplete={f.key === "username" ? "off" : "new-password"}
              value={secret[f.key] ?? ""}
              onChange={(e) => setSecret({ ...secret, [f.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">
          {credential.kind === "ssh_key"
            ? t("settings.credentials.hosts")
            : t("settings.credentials.sites")}
        </legend>
        {bindings.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.credentials.notBound")}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("settings.credentials.col.boundTo")}>
            {bindings.map((b) => (
              <li
                key={JSON.stringify(b)}
                className="inline-flex items-center gap-1 rounded-md border border-gray-6 bg-gray-2 py-0.5 pe-0.5 ps-2 text-xs"
              >
                {bindingLabel(b)}
                {"connector" in b ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("settings.credentials.removeSite", { site: bindingLabel(b) })}
                    onClick={() => setBindings(bindings.filter((x) => !sameBinding(x, b)))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex max-w-sm gap-2">
          <Input
            aria-label={
              credential.kind === "ssh_key"
                ? t("settings.credentials.addHost")
                : t("settings.credentials.addSite")
            }
            placeholder={
              credential.kind === "ssh_key"
                ? t("settings.credentials.hostPlaceholder")
                : t("settings.credentials.sitePlaceholder")
            }
            value={site}
            aria-invalid={siteError !== null}
            onChange={(e) => setSite(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSite();
              }
            }}
          />
          <Button type="button" size="sm" variant="outline" onClick={addSite}>
            {t("settings.credentials.add")}
          </Button>
        </div>
        {siteError ? (
          <p role="alert" className="text-xs text-danger-text">
            {siteError}
          </p>
        ) : null}
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!changed || name.trim() === "" || saving}>
          {t("settings.credentials.saveChanges")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** What deleting a credential loses, for the confirm dialog. */
export type ManagedSetting = NonNullable<CredentialMeta["managedBy"]>["setting"];
type ManagedKind = NonNullable<CredentialMeta["managedBy"]>["kind"];

/**
 * A Gateway-owned item the vault can't remove (#511): a connector's token, a model provider's
 * key, a channel's token. `managedBy` says so; older Gateways only set `ownerConnectorId`.
 */
export function managedOf(
  c: CredentialMeta,
): { kind: ManagedKind; setting: ManagedSetting } | null {
  if (c.managedBy && !c.managedBy.removable) return c.managedBy;
  if (!c.managedBy && c.ownerConnectorId !== null)
    return { kind: "connector", setting: "connectors" };
  return null;
}

/** A link to an item in 1Password or Bitwarden: removing it forgets the link only. */
function isExternalLink(c: CredentialMeta): boolean {
  return (
    c.managedBy?.kind === "external_manager" ||
    c.backend === "1password" ||
    c.backend === "bitwarden"
  );
}

function managerName(c: CredentialMeta): string {
  return c.backend === "bitwarden" ? "Bitwarden" : "1Password"; // i18n-ignore: product names
}

const managedLabel = (kind: ManagedKind): string => t(`settings.credentials.managed.${kind}`);
const settingLabel = (setting: ManagedSetting): string =>
  t(`settings.credentials.setting.${setting}`);

function deleteDescription(c: CredentialMeta): string {
  const sites = c.bindings.map(bindingLabel).join(", ");
  return t("settings.credentials.deleteDescription", { bound: sites !== "", sites });
}

const ADDABLE: readonly CredentialKind[] = ["login", "api_key", "payment_link", "ssh_key", "note"];

function AddCredentialForm({
  onAdd,
  onCancel,
}: {
  onAdd: (item: NewCredential) => void;
  onCancel: () => void;
}): ReactElement {
  const id = useId();
  const [kind, setKind] = useState<CredentialKind>("login");
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === "" || secret === "") return;
    const bindings: CredentialBinding[] =
      origin.trim() === ""
        ? []
        : [{ origin: origin.includes("://") ? origin.trim() : `https://${origin.trim()}` }];
    const s: CredentialSecretInput =
      kind === "login"
        ? { username, password: secret }
        : kind === "ssh_key"
          ? { privateKey: secret }
          : kind === "note"
            ? { text: secret }
            : { token: secret };
    onAdd({ kind, name: name.trim(), bindings, secret: s });
    setSecret("");
  };

  const payment = kind === "payment_link";
  return (
    <form
      onSubmit={submit}
      aria-label={t("settings.credentials.addForm")}
      className="flex flex-col gap-4 rounded-lg border border-gray-6 bg-background p-4"
    >
      <p
        className={
          payment
            ? "flex items-start gap-1.5 rounded-md bg-approval-surface p-2 text-xs text-approval-text"
            : "flex items-start gap-1.5 text-xs text-muted-foreground"
        }
      >
        <CreditCard className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {cardRefusal()}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-kind`}>{t("settings.credentials.col.kind")}</Label>
          <NativeSelect
            id={`${id}-kind`}
            className="min-w-48"
            value={kind}
            onChange={(e) => setKind(e.target.value as CredentialKind)}
          >
            {ADDABLE.map((k) => (
              <option key={k} value={k}>
                {credentialKindLabel(k)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t("settings.credentials.col.name")}</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-origin`}>{t("settings.credentials.onlyForSite")}</Label>
          <Input
            id={`${id}-origin`}
            placeholder={t("settings.credentials.sitePlaceholder")}
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          />
        </div>
        {kind === "login" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-user`}>{t("settings.credentials.username")}</Label>
            <Input
              id={`${id}-user`}
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-secret`} className="gap-1.5">
            <KeyRound className="size-3.5" aria-hidden="true" />
            {kind === "login"
              ? t("settings.credentials.password")
              : payment
                ? t("settings.credentials.paymentToken")
                : t("settings.credentials.secret")}
          </Label>
          <Input
            id={`${id}-secret`}
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={name.trim() === "" || secret === ""}>
          {t("settings.credentials.store")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Plain words for a failed `vault.update` / `vault.delete`. */
export function vaultChangeError(
  err: unknown,
  c: CredentialMeta,
  verb: "change" | "delete",
): string {
  if (
    hasCode(err, "unavailable") &&
    (err as { details?: { reason?: unknown } }).details?.reason === "locked"
  ) {
    return t("settings.credentials.err.lockedChange", { verb, name: c.name });
  }
  const details = (err as { details?: { reason?: unknown; setting?: unknown } }).details;
  if (hasCode(err, "forbidden") && details?.reason === "gateway_owned") {
    const setting = (["connectors", "models", "channels", "credentials"] as const).find(
      (s) => s === details.setting,
    );
    return t("settings.credentials.err.gatewayOwned", {
      name: c.name,
      setting: settingLabel(setting ?? "connectors"),
    });
  }
  if (hasCode(err, "forbidden")) {
    // The Gateway's own (English) wording tells a scope refusal from a managed item.
    return /requires scope/.test(err instanceof Error ? err.message : String(err))
      ? t("settings.credentials.err.adminOnlyChange", { verb })
      : t("settings.credentials.err.managed", { verb, name: c.name });
  }
  if (hasCode(err, "policy_denied")) {
    return t("settings.credentials.err.policyValue");
  }
  if (hasCode(err, "not_found")) return t("settings.credentials.err.gone", { name: c.name });
  return t("settings.credentials.err.change", { verb, name: c.name, reason: messageOf(err) });
}

/** Plain words for a failed `vault.import`. */
export function vaultImportError(err: unknown): string {
  if (
    hasCode(err, "unavailable") &&
    (err as { details?: { reason?: unknown } }).details?.reason === "locked"
  ) {
    return t("settings.credentials.err.lockedImport");
  }
  if (hasCode(err, "forbidden")) return t("settings.credentials.err.adminOnlyImport");
  if (hasCode(err, "invalid_params")) {
    return t("settings.credentials.err.unreadable");
  }
  return t("settings.credentials.err.import", { reason: messageOf(err) });
}

export interface CredentialsSectionProps {
  now?: number;
  onConnectManager?: (manager: "1password" | "bitwarden") => void;
  /** Opens a task from an item's recent uses; defaults to the Activity route. */
  onOpenTask?: (taskId: string) => void;
}

/** The vault's key slot as the owner reads it (`recovery` always exists beside it). */
export function vaultSlotLabel(slots: readonly string[]): string {
  if (slots.includes("keychain")) return t("settings.credentials.slot.keychain");
  if (slots.includes("safe_storage")) return t("settings.credentials.slot.safeStorage");
  if (slots.includes("key_file")) return t("settings.credentials.slot.keyFile");
  return t("settings.credentials.slot.recovery");
}

/**
 * "Vault protected by: …" (docs/05 "Key storage on unsigned builds"). A build without a signed
 * helper keeps the vault key in a 0600 file; moving it to the Keychain needs a Psyche Helper
 * signed with a Developer ID and a provisioning profile.
 */
export function VaultProtectionPanel({ slots }: { slots: readonly string[] }): ReactElement {
  const keyFile = slots.includes("key_file") && !slots.includes("keychain");
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 text-sm"
      data-testid="vault-protection"
    >
      <span>
        {t("settings.credentials.protectedBy")}{" "}
        <span className="font-medium">{vaultSlotLabel(slots)}</span>
      </span>
      {keyFile ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="ms-auto"
            disabled
            title={t("settings.credentials.moveToKeychainNeeds")}
          >
            {t("settings.credentials.moveToKeychain")}
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            {t("settings.credentials.keyFileExplainer")}
          </p>
        </>
      ) : null}
    </div>
  );
}

function VaultProtection(): ReactElement | null {
  const q = useGatewayQuery("vault.status", {});
  const status = q.data?.status;
  if (!status || status.state === "uninitialized") return null;
  return <VaultProtectionPanel slots={status.slots} />;
}

export function CredentialsSection({
  now,
  onConnectManager,
  onOpenTask,
}: CredentialsSectionProps): ReactElement {
  const { navigate } = useSlots();
  const openTask =
    onOpenTask ??
    (navigate ? (taskId: string) => navigate(`/agent/activity/${taskId}`) : undefined);
  const [detail, setDetail] = useState<CredentialMeta | null>(null);
  const form = useSettingsForm();
  const call = useCall();
  const q = useGatewayQuery("vault.list", {});
  const pay = usePayments();
  const [addError, setAddError] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const onUpdate = (c: CredentialMeta, patch: CredentialPatch): Promise<void> => {
    setItemError(null);
    return call("vault.update", { credentialId: c.id, ...patch }).then(
      () => q.reload(),
      (err: unknown) => {
        setItemError(vaultChangeError(err, c, "change"));
        throw err;
      },
    );
  };
  const onDelete = (c: CredentialMeta): Promise<void> => {
    setItemError(null);
    return call("vault.delete", { credentialId: c.id }).then(
      () => q.reload(),
      (err: unknown) => {
        setItemError(vaultChangeError(err, c, "delete"));
        throw err;
      },
    );
  };
  const onImport = (format: ImportFormat, csv: string): Promise<ImportOutcome> =>
    call("vault.import", { format, csv }).then(
      (result) => {
        q.reload();
        return result;
      },
      (err: unknown) => {
        throw new Error(vaultImportError(err));
      },
    );
  const onLinkExternal = (item: ExternalLink): Promise<void> =>
    call("vault.linkExternal", item).then(
      () => q.reload(),
      (err: unknown) => {
        throw new Error(linkExternalError(err, item.name, item.source));
      },
    );
  const onAdd = (item: NewCredential) => {
    setAddError(null);
    call("vault.add", item).then(
      () => q.reload(),
      (err: unknown) =>
        setAddError(
          hasCode(err, "policy_denied")
            ? t("settings.credentials.err.policyItem")
            : hasCode(err, "forbidden")
              ? t("settings.credentials.err.addNeedsAdmin")
              : t("settings.credentials.err.store", { name: item.name, reason: messageOf(err) }),
        ),
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <VaultProtection />
      <CredentialsPanel
        credentials={q.data?.credentials ?? []}
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        onAdd={onAdd}
        addError={addError}
        onUpdate={onUpdate}
        onDelete={onDelete}
        {...(navigate
          ? {
              onOpenSetting: (setting: ManagedSetting) =>
                navigate(`/settings/${setting === "models" ? "model" : setting}`),
            }
          : {})}
        itemError={itemError}
        onImport={onImport}
        onOpen={setDetail}
        onLinkExternal={onLinkExternal}
        payments={{
          configured: pay.data?.configured ?? true,
          methods: pay.data?.methods ?? [],
          payments: pay.data?.payments ?? [],
          loading: pay.loading && pay.data === undefined,
          error: pay.error,
          onRetry: pay.reload,
        }}
        {...(openTask ? { onOpenTask: openTask } : {})}
        loading={q.loading && q.data === undefined}
        error={q.error}
        onRetry={q.reload}
        {...(now === undefined ? {} : { now })}
        {...(onConnectManager ? { onConnectManager } : {})}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
      <CredentialDetailSheet
        // The row's latest metadata, so the sheet follows edits and new uses.
        credential={
          detail === null ? null : (q.data?.credentials.find((c) => c.id === detail.id) ?? null)
        }
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        {...(openTask ? { onOpenTask: openTask } : {})}
        {...(now === undefined ? {} : { now })}
      />
    </div>
  );
}
