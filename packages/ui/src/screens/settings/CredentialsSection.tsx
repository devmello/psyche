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
import { bindingLabel, CARD_REFUSAL, KIND_LABEL } from "./credential-labels.ts";
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

export { bindingLabel, CARD_REFUSAL, KIND_LABEL } from "./credential-labels.ts";

/** True when the search text matches the item's name, slug, kind or a site it is bound to. */
export function matchesCredential(c: CredentialMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [c.name, c.slug, KIND_LABEL[c.kind], ...c.bindings.map(bindingLabel)].some((t) =>
    t.toLowerCase().includes(q),
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
      title="Credentials"
      description="Values are never shown, not even here. Psyche fills them for you after you approve."
    >
      <LoadGate
        label="credentials"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title="Storage">
          <RadioField
            label="Where credentials are kept"
            inline
            value={backend}
            settingKey="vault.backend"
            onChange={(v) => onChange("vault.backend", v)}
            options={[
              { value: "psyche", label: "Psyche vault (Touch ID)" },
              { value: "keychain", label: "System keychain" },
              { value: "external", label: "External manager" },
            ]}
          />
          <RadioField
            label="Fill default"
            inline
            value={fill}
            settingKey="vault.fillDefault"
            onChange={(v) => onChange("vault.fillDefault", v)}
            options={[
              { value: "once", label: "Ask every fill" },
              { value: "site", label: "Ask once per site" },
            ]}
          />
        </Group>

        <Group
          title="Items"
          actions={
            credentials.length === 0 && !adding && linking === null ? undefined : (
              <div className="flex items-center gap-1">
                {onAdd ? (
                  <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={adding}>
                    Add item
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
          {addError ? <ErrorNotice what={addError} did="Nothing was stored." /> : null}
          {adding && onAdd ? (
            <AddCredentialForm
              onCancel={() => setAdding(false)}
              onAdd={(item) => {
                onAdd(item);
                setAdding(false);
              }}
            />
          ) : null}
          {itemError ? <ErrorNotice what={itemError} did="Nothing was changed." /> : null}
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
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label="Search credentials"
                placeholder="Search by name, site or kind"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
          ) : null}
          {credentials.length === 0 ? (
            adding || importing || linking !== null ? null : (
              <EmptyState
                icon={KeyRound}
                {...(onAdd
                  ? { action: { label: "Add item", onClick: () => setAdding(true) } }
                  : {})}
              >
                No credentials stored yet. When a site needs a login, type it yourself or add it
                here.
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
              text={`No credentials match "${query.trim()}".`}
              action={
                <Button type="button" variant="ghost" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <Table aria-label="Stored credentials">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Kind</TableHead>
                  <TableHead scope="col">Bound to</TableHead>
                  <TableHead scope="col">Last used</TableHead>
                  <TableHead scope="col">Uses</TableHead>
                  {actions ? (
                    <TableHead scope="col">
                      <span className="sr-only">Actions</span>
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
                            className="text-left font-medium underline-offset-2 hover:underline focus-visible:underline"
                            onClick={() => onOpen(c)}
                          >
                            {c.name}
                          </button>
                        ) : (
                          <span className="font-medium">{c.name}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {KIND_LABEL[c.kind]}
                        {c.backend !== undefined && c.backend !== "vault" ? (
                          <span className="block text-xs text-muted-foreground">
                            {BACKEND_LABEL[c.backend]}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>{c.bindings.map(bindingLabel).join(", ") || "Any site"}</TableCell>
                      <TableCell>
                        {c.lastUsedAt ? formatRelative(c.lastUsedAt, clock) : "Never"}
                      </TableCell>
                      <TableCell className="tabular-nums">{c.useCount}</TableCell>
                      {actions ? (
                        <TableCell className="text-right">
                          {c.ownerConnectorId !== null ? (
                            <span className="text-xs text-muted-foreground">
                              Managed by its connector
                            </span>
                          ) : (
                            <span className="inline-flex gap-1">
                              {onUpdate ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Edit ${c.name}`}
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
                                      label: "Delete",
                                      title: `Delete ${c.name}?`,
                                      description: deleteDescription(c),
                                      confirm: "Delete",
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
                    {editingId === c.id && onUpdate && c.ownerConnectorId === null ? (
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

/** Where an item's value lives, when it is not the Psyche vault itself. */
const BACKEND_LABEL = {
  "1password": "in 1Password",
  bitwarden: "in Bitwarden",
  keychain: "in the system keychain",
} as const;

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
        render={<Button type="button" variant="ghost" size="sm" aria-label="More ways to add" />}
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onImport ? (
          <DropdownMenuItem onClick={onImport}>Import a CSV export</DropdownMenuItem>
        ) : null}
        {connect
          ? (["1password", "bitwarden"] as const).map((m) => (
              <DropdownMenuItem key={m} onClick={() => connect(m)}>
                Connect {EXTERNAL_NAME[m]}
              </DropdownMenuItem>
            ))
          : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The secret fields an edit can replace, per kind; blank keeps the stored value. */
const SECRET_FIELDS: Partial<
  Record<CredentialKind, readonly { key: keyof CredentialSecretInput; label: string }[]>
> = {
  login: [
    { key: "username", label: "New username" },
    { key: "password", label: "New password" },
  ],
  api_key: [{ key: "token", label: "New key" }],
  payment_link: [{ key: "token", label: "New payment link token" }],
  ssh_key: [{ key: "privateKey", label: "New private key" }],
  note: [{ key: "text", label: "New note text" }],
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
      setSiteError(`Enter a site such as github.com.`);
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
      aria-label={`Edit ${credential.name}`}
      className="flex flex-col gap-4 rounded-lg border border-gray-6 bg-background p-4"
    >
      <p className="text-xs text-muted-foreground">
        {external
          ? `The values stay in ${external}; change them there. Psyche never shows stored values.`
          : "Leave a value blank to keep it. Psyche never shows stored values."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {fields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            <Label htmlFor={`${id}-${f.key}`} className="gap-1.5">
              {f.key === "username" ? null : <KeyRound className="size-3.5" aria-hidden="true" />}
              {f.label}
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
          {credential.kind === "ssh_key" ? "Hosts" : "Sites"}
        </legend>
        {bindings.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Not bound to a site: Psyche asks before filling it anywhere.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Bound to">
            {bindings.map((b) => (
              <li
                key={JSON.stringify(b)}
                className="inline-flex items-center gap-1 rounded-md border border-gray-6 bg-gray-2 py-0.5 pr-0.5 pl-2 text-xs"
              >
                {bindingLabel(b)}
                {"connector" in b ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${bindingLabel(b)}`}
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
            aria-label={credential.kind === "ssh_key" ? "Add a host" : "Add a site"}
            placeholder={credential.kind === "ssh_key" ? "build.example.com" : "github.com"}
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
            Add
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
          Save changes
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** What deleting a credential loses, for the confirm dialog. */
function deleteDescription(c: CredentialMeta): string {
  const sites = c.bindings.map(bindingLabel).join(", ");
  return `Psyche erases the stored value and stops filling it${sites ? ` on ${sites}` : ""}. Tasks that need it will ask you to sign in yourself. This can't be undone.`;
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
      aria-label="Add a credential"
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
        {CARD_REFUSAL}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-kind`}>Kind</Label>
          <NativeSelect
            id={`${id}-kind`}
            className="min-w-48"
            value={kind}
            onChange={(e) => setKind(e.target.value as CredentialKind)}
          >
            {ADDABLE.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-origin`}>Only for this site</Label>
          <Input
            id={`${id}-origin`}
            placeholder="github.com"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          />
        </div>
        {kind === "login" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-user`}>Username</Label>
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
            {kind === "login" ? "Password" : payment ? "Payment link token" : "Secret"}
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
          Store in vault
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
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
    return `The vault is locked. Unlock it with Touch ID, then ${verb} ${c.name} again.`;
  }
  if (hasCode(err, "forbidden")) {
    return /requires scope/.test(messageOf(err))
      ? `Only a device paired as admin can ${verb} vault items.`
      : `${c.name} is managed by its connector or password manager; ${verb} it there.`;
  }
  if (hasCode(err, "policy_denied")) {
    return "Psyche refused the new value because it looks like a card, bank or ID number.";
  }
  if (hasCode(err, "not_found")) return `${c.name} is no longer in the vault.`;
  return `Psyche couldn't ${verb} ${c.name} (${messageOf(err)}).`;
}

/** Plain words for a failed `vault.import`. */
export function vaultImportError(err: unknown): string {
  if (
    hasCode(err, "unavailable") &&
    (err as { details?: { reason?: unknown } }).details?.reason === "locked"
  ) {
    return "The vault is locked. Unlock it with Touch ID, then import again.";
  }
  if (hasCode(err, "forbidden")) return "Only a device paired as admin can import vault items.";
  if (hasCode(err, "invalid_params")) {
    return "Psyche couldn't read that file as a 1Password, Bitwarden or Chrome export. Pick the app it came from, or export it again as CSV.";
  }
  return `Psyche couldn't import the file (${messageOf(err)}).`;
}

export interface CredentialsSectionProps {
  now?: number;
  onConnectManager?: (manager: "1password" | "bitwarden") => void;
  /** Opens a task from an item's recent uses; defaults to the Activity route. */
  onOpenTask?: (taskId: string) => void;
}

/** The vault's key slot as the owner reads it (`recovery` always exists beside it). */
export function vaultSlotLabel(slots: readonly string[]): string {
  if (slots.includes("keychain")) return "the Keychain (Touch ID)";
  if (slots.includes("safe_storage")) return "this Mac's app storage";
  if (slots.includes("key_file")) return "a key file on this Mac";
  return "its recovery key only";
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
        Vault protected by: <span className="font-medium">{vaultSlotLabel(slots)}</span>
      </span>
      {keyFile ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="ml-auto"
            disabled
            title="Needs a Psyche Helper signed with a Developer ID and a provisioning profile"
          >
            Move to Keychain
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            The key that opens your vault is a file only your account can read. Moving it to the
            Keychain (Touch ID) needs a signed Psyche Helper; this build's helper is not signed.
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
            ? "Psyche refused this item because it looks like a card, bank or ID number."
            : hasCode(err, "forbidden")
              ? "Adding items needs approval on this device. Use a device paired as admin."
              : `Psyche couldn't store ${item.name} (${messageOf(err)}).`,
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
