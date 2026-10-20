import type {
  CredentialBinding,
  CredentialKind,
  CredentialMeta,
  CredentialSecretInput,
} from "@psyche/protocol";
import { CreditCard, KeyRound } from "lucide-react";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
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
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
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

export const KIND_LABEL: Record<CredentialKind, string> = {
  login: "login",
  api_key: "API key",
  oauth_token: "OAuth token",
  ssh_key: "SSH key",
  note: "secure note",
  payment_link: "payment",
  signing_key: "signing key",
};

export const CARD_REFUSAL =
  "Psyche refuses raw card numbers, CVVs, bank account numbers and government IDs. For payments, add a payment link such as a Link wallet; the card stays with the provider.";

export function bindingLabel(b: CredentialBinding): string {
  if ("origin" in b) return b.origin.replace(/^https?:\/\//, "");
  if ("host" in b) return b.host;
  return b.connector === "stripe_link" ? "Link wallet" : b.connector;
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
  loading,
  error,
  onRetry,
}: CredentialsPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const [adding, setAdding] = useState(defaultAdding);
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
          ></RadioField>
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
          ></RadioField>
        </Group>

        <Group
          title="Items"
          actions={
            <div className="flex flex-wrap gap-2">
              {onAdd ? (
                <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={adding}>
                  Add item
                </Button>
              ) : null}
              {onConnectManager ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onConnectManager("1password")}
                  >
                    Connect 1Password
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onConnectManager("bitwarden")}
                  >
                    Connect Bitwarden
                  </Button>
                </>
              ) : null}
            </div>
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
          {credentials.length === 0 ? (
            <EmptyNotice text="No credentials stored. When a site needs a login, you can type it yourself or add it here." />
          ) : (
            <Table aria-label="Stored credentials">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Kind</TableHead>
                  <TableHead scope="col">Bound to</TableHead>
                  <TableHead scope="col">Last used</TableHead>
                  <TableHead scope="col">Uses</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <span className="font-medium">{c.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {c.slug}
                      </span>
                    </TableCell>
                    <TableCell>{KIND_LABEL[c.kind]}</TableCell>
                    <TableCell>{c.bindings.map(bindingLabel).join(", ") || "anywhere"}</TableCell>
                    <TableCell>
                      {c.lastUsedAt ? formatRelative(c.lastUsedAt, clock) : "never"}
                    </TableCell>
                    <TableCell className="tabular-nums">{c.useCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
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
      className="flex flex-col gap-3 rounded-md border border-gray-6 bg-background p-3"
    >
      <p
        className={
          payment
            ? "flex items-start gap-1.5 rounded-md bg-approval-surface p-2 text-approval-text"
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

export interface CredentialsSectionProps {
  now?: number;
  onConnectManager?: (manager: "1password" | "bitwarden") => void;
}

export function CredentialsSection({
  now,
  onConnectManager,
}: CredentialsSectionProps): ReactElement {
  const form = useSettingsForm();
  const call = useCall();
  const q = useGatewayQuery("vault.list", {});
  const [addError, setAddError] = useState<string | null>(null);
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
      <CredentialsPanel
        credentials={q.data?.credentials ?? []}
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        onAdd={onAdd}
        addError={addError}
        loading={q.loading && q.data === undefined}
        error={q.error}
        onRetry={q.reload}
        {...(now === undefined ? {} : { now })}
        {...(onConnectManager ? { onConnectManager } : {})}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
