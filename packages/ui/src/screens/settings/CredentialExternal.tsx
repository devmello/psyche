import type { BitwardenRef, CredentialBinding, OnePasswordRef } from "@psyche/protocol";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { credentialKindLabel } from "./credential-labels.ts";
import { hasCode, messageOf } from "./shared.tsx";

/**
 * Link an item held in 1Password (G10) or Bitwarden (G11) by reference (`vault.linkExternal`).
 * Psyche stores the item's names or id, never a value; a fill reads one field from the manager
 * after the owner approves it, and nothing is written back.
 */

export type LinkableKind = "login" | "api_key" | "ssh_key" | "note";
export type ExternalSource = "1password" | "bitwarden";

/** Product names: the same in every language. */
export const EXTERNAL_NAME: Record<ExternalSource, string> = {
  "1password": "1Password",
  bitwarden: "Bitwarden",
};

export type ExternalLink = {
  kind: LinkableKind;
  name: string;
  bindings: CredentialBinding[];
} & ({ source: "1password"; ref: OnePasswordRef } | { source: "bitwarden"; ref: BitwardenRef });

const LINKABLE: readonly LinkableKind[] = ["login", "api_key", "ssh_key", "note"];

/** Plain words for a failed `vault.linkExternal`. */
export function linkExternalError(
  err: unknown,
  name: string,
  source: ExternalSource = "1password",
): string {
  const reason = (err as { details?: { reason?: unknown } }).details?.reason;
  if (hasCode(err, "unavailable") && reason === "locked") {
    return t("settings.credentials.link.err.locked", { name });
  }
  // What the Gateway needs before it can read the manager (`unavailable`), in plain words.
  if (hasCode(err, "unavailable")) return t(`settings.credentials.link.err.setUp.${source}`);
  if (hasCode(err, "forbidden")) return t("settings.credentials.link.err.adminOnly");
  if (hasCode(err, "policy_denied")) {
    return t("settings.credentials.link.err.policy");
  }
  if (hasCode(err, "invalid_params")) {
    return t(`settings.credentials.link.err.badRef.${source}`);
  }
  return t("settings.credentials.link.err.other", { name, reason: messageOf(err) });
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
            ? t("settings.credentials.link.hostError")
            : t("settings.credentials.siteError"),
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
      aria-label={t("settings.credentials.link.form", { manager })}
      className="flex flex-col gap-3 rounded-md border border-gray-6 bg-background p-3"
    >
      <p className="text-xs text-muted-foreground">
        {t("settings.credentials.link.explainer", { op, manager })}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-kind`}>{t("settings.credentials.col.kind")}</Label>
          <NativeSelect
            id={`${id}-kind`}
            className="min-w-48"
            value={kind}
            onChange={(e) => setKind(e.target.value as LinkableKind)}
          >
            {LINKABLE.map((k) => (
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
        {op ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-vault`}>{t("settings.credentials.link.opVault")}</Label>
            <Input
              id={`${id}-vault`}
              placeholder={t("settings.credentials.link.opVaultPlaceholder")}
              autoComplete="off"
              value={vault}
              onChange={(e) => setVault(e.target.value)}
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-item`}>
            {op ? t("settings.credentials.link.opItem") : t("settings.credentials.link.bwItem")}
          </Label>
          <Input
            id={`${id}-item`}
            placeholder={
              op
                ? t("settings.credentials.link.opItemPlaceholder")
                : t("settings.credentials.link.bwItemPlaceholder")
            }
            autoComplete="off"
            value={item}
            onChange={(e) => setItem(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-site`}>
            {kind === "ssh_key"
              ? t("settings.credentials.link.onlyForHost")
              : t("settings.credentials.onlyForSite")}
          </Label>
          <Input
            id={`${id}-site`}
            placeholder={
              kind === "ssh_key"
                ? t("settings.credentials.hostPlaceholder")
                : t("settings.credentials.sitePlaceholder")
            }
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
          {t("settings.credentials.link.submit")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
