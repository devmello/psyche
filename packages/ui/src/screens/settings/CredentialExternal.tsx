import type { BitwardenRef, CredentialBinding, OnePasswordRef } from "@psyche/protocol";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { KIND_LABEL } from "./credential-labels.ts";
import { hasCode, messageOf } from "./shared.tsx";

/**
 * Link an item held in 1Password (G10) or Bitwarden (G11) by reference (`vault.linkExternal`).
 * Psyche stores the item's names or id, never a value; a fill reads one field from the manager
 * after the owner approves it, and nothing is written back.
 */

export type LinkableKind = "login" | "api_key" | "ssh_key" | "note";
export type ExternalSource = "1password" | "bitwarden";

export const EXTERNAL_NAME: Record<ExternalSource, string> = {
  "1password": "1Password",
  bitwarden: "Bitwarden",
};

export type ExternalLink = {
  kind: LinkableKind;
  name: string;
  bindings: CredentialBinding[];
} & ({ source: "1password"; ref: OnePasswordRef } | { source: "bitwarden"; ref: BitwardenRef });

/** What the Gateway needs before it can read the manager (`unavailable`), in plain words. */
const SET_UP: Record<ExternalSource, string> = {
  "1password":
    "1Password is not set up on the Gateway. Give it a 1Password service account (the op CLI) or a Connect server, then link the item again.",
  bitwarden:
    "Bitwarden is not set up on the Gateway. Install the bw CLI there, set credentials.bitwarden, and store a session key from bw unlock in the vault, then link the item again.",
};

const LINKABLE: readonly LinkableKind[] = ["login", "api_key", "ssh_key", "note"];

/** Plain words for a failed `vault.linkExternal`. */
export function linkExternalError(
  err: unknown,
  name: string,
  source: ExternalSource = "1password",
): string {
  const reason = (err as { details?: { reason?: unknown } }).details?.reason;
  if (hasCode(err, "unavailable") && reason === "locked") {
    return `The vault is locked. Unlock it with Touch ID, then link ${name} again.`;
  }
  if (hasCode(err, "unavailable")) return SET_UP[source];
  if (hasCode(err, "forbidden")) return "Only a device paired as admin can link vault items.";
  if (hasCode(err, "policy_denied")) {
    return "Psyche refused this item because its name looks like a card, bank or ID number.";
  }
  if (hasCode(err, "invalid_params")) {
    return source === "1password"
      ? "Psyche couldn't use that reference. Check the 1Password vault and item names."
      : "Psyche couldn't use that reference. Use the Bitwarden item's id, or a name no other item has.";
  }
  return `Psyche couldn't link ${name} (${messageOf(err)}).`;
}

export function LinkExternalForm({
  source,
  onLink,
  onClose,
  parseSite,
}: {
  source: ExternalSource;
  /** Rejects with an Error whose message is shown; the form stays open. */
  onLink: (item: ExternalLink) => Promise<void>;
  onClose: () => void;
  parseSite: (text: string, kind: LinkableKind) => CredentialBinding | null;
}): ReactElement {
  const id = useId();
  const [kind, setKind] = useState<LinkableKind>("login");
  const [name, setName] = useState("");
  const [site, setSite] = useState("");
  const [vault, setVault] = useState("");
  const [item, setItem] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const op = source === "1password";
  const manager = EXTERNAL_NAME[source];
  const ready = name.trim() !== "" && (!op || vault.trim() !== "") && item.trim() !== "" && !saving;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    let bindings: CredentialBinding[] = [];
    if (site.trim() !== "") {
      const b = parseSite(site, kind);
      if (b === null) {
        setError(
          kind === "ssh_key"
            ? "Enter a host such as build.example.com."
            : "Enter a site such as github.com.",
        );
        return;
      }
      bindings = [b];
    }
    setError(null);
    setSaving(true);
    const base = { kind, name: name.trim(), bindings };
    onLink(
      op
        ? { ...base, source, ref: { vault: vault.trim(), item: item.trim() } }
        : { ...base, source, ref: { item: item.trim() } },
    ).then(
      () => {
        setSaving(false);
        onClose();
      },
      (err: unknown) => {
        setSaving(false);
        setError(messageOf(err));
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`Link a ${manager} item`}
      className="flex flex-col gap-3 rounded-md border border-gray-6 bg-background p-3"
    >
      <p className="text-xs text-muted-foreground">
        {op
          ? "Psyche keeps only the vault and item names."
          : "Psyche keeps only the item's id or name. Cards and identities are never read."}{" "}
        It reads one field from {manager} when you approve a fill, and never writes back.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-kind`}>Kind</Label>
          <NativeSelect
            id={`${id}-kind`}
            className="min-w-48"
            value={kind}
            onChange={(e) => setKind(e.target.value as LinkableKind)}
          >
            {LINKABLE.map((k) => (
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
        {op ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-vault`}>1Password vault</Label>
            <Input
              id={`${id}-vault`}
              placeholder="Private"
              autoComplete="off"
              value={vault}
              onChange={(e) => setVault(e.target.value)}
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-item`}>
            {op ? "1Password item" : "Bitwarden item id or name"}
          </Label>
          <Input
            id={`${id}-item`}
            placeholder={op ? "GitHub" : "GitHub, or the item's id"}
            autoComplete="off"
            value={item}
            onChange={(e) => setItem(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-site`}>
            {kind === "ssh_key" ? "Only for this host" : "Only for this site"}
          </Label>
          <Input
            id={`${id}-site`}
            placeholder={kind === "ssh_key" ? "build.example.com" : "github.com"}
            value={site}
            onChange={(e) => setSite(e.target.value)}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!ready}>
          Link item
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
