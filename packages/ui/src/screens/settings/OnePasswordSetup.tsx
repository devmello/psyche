import type { OnePasswordSetupState, OnePasswordSetupStatus } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useSlots } from "../../slots.tsx";
import { hasCode, messageOf } from "./shared.tsx";

/**
 * Settings → Credentials → 1Password: a guided setup for reading linked 1Password items through
 * the 1Password app's "Integrate with 1Password CLI" setting. One next step per state; the panel
 * never asks for a password or a token (1Password unlocks itself), and "Test connection" only
 * counts vaults. Admin devices only: the Gateway answers `forbidden` to the others.
 */

/** 1Password's own guide for installing `op` and turning the app integration on. */
export const ONEPASSWORD_GUIDE_URL =
  "https://developer.1password.com/docs/cli/get-started/#step-2-turn-on-the-1password-desktop-app-integration";

/** The command the owner runs themselves; a product command, the same in every language. */
const INSTALL_COMMAND = "brew install --cask 1password-cli";

type Busy = "check" | "connect" | "test" | "disconnect" | null;

const STEP_KEY = {
  found: "settings.credentials.onePassword.found.body",
  not_installed: "settings.credentials.onePassword.notInstalled.body",
  not_integrated: "settings.credentials.onePassword.notIntegrated.body",
  locked: "settings.credentials.onePassword.locked.body",
  error: "settings.credentials.onePassword.error.body",
} as const satisfies Partial<Record<OnePasswordSetupState, string>>;

export function OnePasswordSetupPanel(): ReactElement {
  const call = useCall();
  const { openExternal } = useSlots();
  const q = useGatewayQuery("vault.onePassword.status", {});
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<number | null>(null);

  // What Check again found; the loaded status (which runs no `op`) until then.
  const [probed, setProbed] = useState<OnePasswordSetupStatus | null>(null);
  const status: OnePasswordSetupStatus | undefined = probed ?? q.data;
  const forbidden = q.errorCode === "forbidden";

  const run = (what: Exclude<Busy, null>, fn: () => Promise<unknown>): void => {
    setBusy(what);
    setError(null);
    setTested(null);
    fn().then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        setError(
          hasCode(err, "forbidden")
            ? t("settings.credentials.vault.adminOnly")
            : what === "test"
              ? t("settings.credentials.onePassword.test.failed", { reason: messageOf(err) })
              : t("settings.credentials.onePassword.failed", { reason: messageOf(err) }),
        );
      },
    );
  };

  const openGuide = (): void => {
    if (openExternal) void openExternal(ONEPASSWORD_GUIDE_URL).catch(() => {});
    else globalThis.open?.(ONEPASSWORD_GUIDE_URL, "_blank", "noopener,noreferrer");
  };

  const recheck = (): void =>
    run("check", async () => setProbed(await call("vault.onePassword.status", { probe: true })));
  const connect = (): void =>
    run("connect", async () => {
      await call("vault.onePassword.connect", {});
      setProbed(null);
      q.reload();
    });
  const disconnect = (): void =>
    run("disconnect", async () => {
      await call("vault.onePassword.disconnect", {});
      setProbed(null);
      q.reload();
    });
  const test = (): void =>
    run("test", async () => {
      const res = await call("vault.onePassword.test", {});
      setBusy(null);
      setTested(res.vaultCount);
    });

  const disabled = busy !== null;
  const title = t("settings.credentials.onePassword.title");

  return (
    <section
      aria-label={title}
      data-testid="onepassword-setup"
      data-state={status?.state}
      className="flex flex-col gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 text-sm"
    >
      <p className="font-medium">{title}</p>
      <p className="text-callout text-muted-foreground">
        {t("settings.credentials.onePassword.intro")}
      </p>
      {forbidden ? (
        <p role="alert" className="text-callout text-danger-text">
          {t("settings.credentials.vault.adminOnly")}
        </p>
      ) : status === undefined ? (
        q.error ? (
          <p role="alert" className="text-callout text-danger-text">
            {t("settings.credentials.onePassword.failed", { reason: q.error })}
          </p>
        ) : null
      ) : (
        <Step
          status={status}
          disabled={disabled}
          tested={tested}
          onGuide={openGuide}
          onCheck={recheck}
          onConnect={connect}
          onTest={test}
          onDisconnect={disconnect}
        />
      )}
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Step({
  status,
  disabled,
  tested,
  onGuide,
  onCheck,
  onConnect,
  onTest,
  onDisconnect,
}: {
  status: OnePasswordSetupStatus;
  disabled: boolean;
  tested: number | null;
  onGuide: () => void;
  onCheck: () => void;
  onConnect: () => void;
  onTest: () => void;
  onDisconnect: () => void;
}): ReactElement {
  const { state, connected, account, problem } = status;
  if (status.managedBy === "config") {
    return <p className="text-callout">{t("settings.credentials.onePassword.config")}</p>;
  }
  const signedIn = state === "signed_in";
  return (
    <div className="flex flex-col gap-2">
      {state !== "signed_in" ? (
        <p className="text-callout" data-testid="onepassword-step">
          {problem === "op_changed"
            ? t("settings.credentials.onePassword.changed.body")
            : problem === "op_unsigned"
              ? t("settings.credentials.onePassword.unsigned.body")
              : problem === "op_unsafe_folder"
                ? t("settings.credentials.onePassword.unsafeFolder.body")
                : t(STEP_KEY[state])}
        </p>
      ) : null}
      {state === "not_installed" && status.os === "macos" ? (
        <code className="w-fit rounded bg-gray-4 px-2 py-1 text-footnote">{INSTALL_COMMAND}</code>
      ) : null}
      {signedIn && account ? (
        <p className="text-callout" data-testid="onepassword-step">
          {t("settings.credentials.onePassword.signedIn.body", {
            email: account.email,
            url: account.url,
          })}
        </p>
      ) : null}
      {connected && status.repinnedAt !== undefined ? (
        <p className="text-callout text-muted-foreground" data-testid="onepassword-repinned">
          {t("settings.credentials.onePassword.repinned.notice", {
            when: new Date(status.repinnedAt).toLocaleString(),
          })}
        </p>
      ) : null}
      {connected ? (
        <p className="text-callout text-muted-foreground">
          {t("settings.credentials.onePassword.connected.body")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!signedIn ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={onGuide}>
              {t("settings.credentials.onePassword.guide")}
            </Button>
            <Button type="button" size="sm" disabled={disabled} onClick={onCheck}>
              {state === "found"
                ? t("settings.credentials.onePassword.checkNow")
                : t("settings.credentials.onePassword.check")}
            </Button>
          </>
        ) : null}
        {signedIn && !connected ? (
          <Button type="button" size="sm" disabled={disabled} onClick={onConnect}>
            {t("settings.credentials.onePassword.signedIn.connect")}
          </Button>
        ) : null}
        {signedIn ? (
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onTest}>
            {t("settings.credentials.onePassword.test")}
          </Button>
        ) : null}
        {connected ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onDisconnect}
          >
            {t("settings.credentials.onePassword.disconnect")}
          </Button>
        ) : null}
      </div>
      {tested !== null ? (
        <p role="status" className="text-callout">
          {t("settings.credentials.onePassword.test.ok", { count: tested })}
        </p>
      ) : null}
    </div>
  );
}
