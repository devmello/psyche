import type { CredentialBinding, OnePasswordRef } from "@psyche/protocol";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { KIND_LABEL } from "./credential-labels.ts";
import { hasCode, messageOf } from "./shared.tsx";

/**
 * Link an item held in 1Password (G10, `vault.linkExternal`). Psyche stores the vault and item
 * names, never a value; a fill reads one field from 1Password after the owner approves it, and
 * nothing is written back.
 */

export type LinkableKind = "login" | "api_key" | "ssh_key" | "note";

export interface OnePasswordLink {
  kind: LinkableKind;
  name: string;
  bindings: CredentialBinding[];
  ref: OnePasswordRef;
}

const LINKABLE: readonly LinkableKind[] = ["login", "api_key", "ssh_key", "note"];

/** Plain words for a failed `vault.linkExternal`. */
export function linkExternalError(err: unknown, name: string): string {
  const reason = (err as { details?: { reason?: unknown } }).details?.reason;
  if (hasCode(err, "unavailable") && reason === "locked") {
    return `The vault is locked. Unlock it with Touch ID, then link ${name} again.`;
  }
  if (hasCode(err, "unavailable")) {
    return "1Password is not set up on the Gateway. Give it a 1Password service account (the op CLI) or a Connect server, then link the item again.";
  }
  if (hasCode(err, "forbidden")) return "Only a device paired as admin can link vault items.";
  if (hasCode(err, "policy_denied")) {
    return "Psyche refused this item because its name looks like a card, bank or ID number.";
  }
  if (hasCode(err, "invalid_params")) {
    return "Psyche couldn't use that reference. Check the 1Password vault and item names.";
  }
  return `Psyche couldn't link ${name} (${messageOf(err)}).`;
}

export function LinkOnePasswordForm({
  onLink,
  onClose,
  parseSite,
}: {
  /** Rejects with an Error whose message is shown; the form stays open. */
  onLink: (item: OnePasswordLink) => Promise<void>;
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
  const ready = name.trim() !== "" && vault.trim() !== "" && item.trim() !== "" && !saving;

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
    onLink({
      kind,
      name: name.trim(),
      bindings,
      ref: { vault: vault.trim(), item: item.trim() },
    }).then(
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
      aria-label="Link a 1Password item"
      className="flex flex-col gap-3 rounded-md border border-gray-6 bg-background p-3"
    >
      <p className="text-xs text-muted-foreground">
        Psyche keeps only the vault and item names. It reads one field from 1Password when you
        approve a fill, and never writes back.
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
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-item`}>1Password item</Label>
          <Input
            id={`${id}-item`}
            placeholder="GitHub"
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
