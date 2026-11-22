import { ExternalLink } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { t } from "../../i18n/core.ts";

/** Google's page on creating an OAuth client for an installed (Desktop) app. */
export const GOOGLE_CLIENT_DOCS_URL =
  "https://developers.google.com/identity/protocols/oauth2/native-app";

/** A Google OAuth client id, the same shape the Gateway accepts. */
export const GOOGLE_CLIENT_ID_PATTERN = /^[\w.-]+\.apps\.googleusercontent\.com$/;

export function googleClientIdProblem(raw: string): "empty" | "shape" | null {
  const v = raw.trim();
  if (v === "") return "empty";
  return GOOGLE_CLIENT_ID_PATTERN.test(v) ? null : "shape";
}

/**
 * The owner's own Google OAuth client (there is no Psyche-owned one): the client id and, for a
 * Desktop client, its secret. The secret is write-only and goes to the vault; this component
 * never receives a saved one back. When a client is already set, it says which.
 */
export function GoogleClientFields({
  configured,
  clientId,
  fromConfig,
  id,
  secret,
  onId,
  onSecret,
  onChange,
  problem,
  error,
  onOpenDocs,
}: {
  /** The Gateway already has a client (the owner can still replace one saved here). */
  configured: boolean;
  clientId: string | undefined;
  /** The client comes from config.json or the environment: it can't be replaced here. */
  fromConfig: boolean;
  id: string;
  secret: string;
  onId: (v: string) => void;
  onSecret: (v: string) => void;
  /** Show the fields although a client is saved. */
  onChange: (() => void) | undefined;
  problem: "empty" | "shape" | null;
  error: string | null;
  onOpenDocs: (url: string) => void;
}): ReactElement {
  const uid = useId();
  if (configured && (fromConfig || onChange !== undefined)) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="google-client-set">
        <p className="text-muted-foreground">
          {t("settings.googleClient.using", { clientId: clientId ?? "" })}
          {fromConfig ? ` ${t("settings.googleClient.fromConfig")}` : ""}
        </p>
        {fromConfig ? null : (
          <Button type="button" size="sm" variant="ghost" onClick={onChange}>
            {t("settings.googleClient.change")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="google-client-fields">
      <p className="text-sm text-muted-foreground">{t("settings.googleClient.help")}</p>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onOpenDocs(GOOGLE_CLIENT_DOCS_URL)}
        >
          <ExternalLink aria-hidden="true" />
          {t("settings.googleClient.docs")}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-id`} className="text-body text-label-primary">
          {t("settings.googleClient.id")}
        </label>
        <Input
          id={`${uid}-id`}
          className="font-mono"
          // i18n-ignore: an example client id
          placeholder="1234567890-abc.apps.googleusercontent.com"
          spellCheck={false}
          autoComplete="off"
          value={id}
          aria-invalid={problem === "shape"}
          aria-describedby={`${uid}-id-hint`}
          onChange={(e) => onId(e.target.value)}
        />
        <p
          id={`${uid}-id-hint`}
          className={
            problem === "shape" ? "text-sm text-danger-text" : "text-sm text-muted-foreground"
          }
          role={problem === "shape" ? "alert" : undefined}
        >
          {problem === "shape"
            ? t("settings.googleClient.invalid")
            : t("settings.googleClient.idHint")}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-secret`} className="text-body text-label-primary">
          {t("settings.googleClient.secret")}
        </label>
        <Input
          id={`${uid}-secret`}
          type="password"
          // Not a login: password managers must not offer to fill or save it.
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          spellCheck={false}
          value={secret}
          aria-describedby={`${uid}-secret-hint`}
          onChange={(e) => onSecret(e.target.value)}
        />
        <p id={`${uid}-secret-hint`} className="text-sm text-muted-foreground">
          {t("settings.googleClient.secretHint")}
        </p>
      </div>
      {error !== null ? (
        <p className="text-sm text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
