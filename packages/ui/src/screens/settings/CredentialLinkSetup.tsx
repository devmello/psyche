import type { LinkSetupReason, LinkSetupStatus } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useContext, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useSlots } from "../../slots.tsx";
import { approvalIdOf, messageOf, SettingsApprovalContext } from "./shared.tsx";

/**
 * Guided Stripe Link setup (Settings → Credentials → Payments): find the Link CLI, connect it,
 * sign in on Link's own page, disconnect. No environment variable. The owner types their Link
 * password only on Link's page; Psyche shows the page's address and the phrase to compare, never
 * a token or a card.
 */

export interface LinkSetupView {
  status: LinkSetupStatus;
  onConnect: (path: string) => Promise<void>;
  onSignIn: () => Promise<void>;
  /** `force` gives up payments still open (only after a plain disconnect was refused). */
  onDisconnect: (force?: boolean) => Promise<void>;
  /** Looks for the CLI again (after the owner installed it). */
  onRecheck: () => void;
}

/** The command the owner runs themselves; a product command, the same in every language. */
const INSTALL_COMMAND = "npm install -g @stripe/link-cli";

const REASONS: readonly LinkSetupReason[] = [
  "not_absolute",
  "missing",
  "not_a_file",
  "not_executable",
  "wrong_owner",
  "writable",
  "parent_wrong_owner",
  "parent_writable",
  "in_psyche_home",
  "not_link_cli",
  "volta_shim",
];

const isReason = (r: unknown): r is LinkSetupReason =>
  typeof r === "string" && (REASONS as readonly string[]).includes(r);

export function reasonText(reason: LinkSetupReason): string {
  return t(`settings.credentials.payments.setup.reason.${reason}`);
}

/** A refused path names its reason in `details.reason`; anything else is shown as the Gateway said. */
export function setupErrorText(err: unknown): string {
  const reason = (err as { details?: { reason?: unknown } } | null)?.details?.reason;
  if (reason === "payment_in_progress")
    return t("settings.credentials.payments.setup.paymentInProgress");
  return isReason(reason)
    ? t("settings.credentials.payments.setup.refused", { reason: reasonText(reason) })
    : t("settings.credentials.payments.setup.failed", { reason: messageOf(err) });
}

/**
 * The four calls behind the panel. Connecting runs a program, so the Gateway asks for a device
 * approval first: it comes back as `approval_required` and goes to the Settings approval banner,
 * which retries the connect once it is approved.
 */
export function useLinkSetupActions(reload: () => void): Omit<LinkSetupView, "status"> {
  const call = useCall();
  const requestApproval = useContext(SettingsApprovalContext);
  const connect = async (path: string, approvalId?: string): Promise<void> => {
    await call("payments.link.connect", approvalId === undefined ? { path } : { path, approvalId });
    reload();
  };
  return {
    onConnect: (path) =>
      connect(path).catch((err: unknown) => {
        const id = approvalIdOf(err);
        if (id === null || !requestApproval) throw err;
        requestApproval({
          key: "payments.linkCli",
          label: t("settings.credentials.payments.setup.approvalLabel"),
          approvalId: id,
          retry: (aid) => connect(path, aid),
        });
      }),
    onSignIn: async () => {
      await call("payments.link.signIn", {});
      reload();
    },
    onDisconnect: async (force) => {
      await call("payments.link.disconnect", force === true ? { force: true } : {});
      reload();
    },
    onRecheck: reload,
  };
}

type Busy = "connect" | "signIn" | "disconnect" | null;

function useAction() {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  /** `handled` may take an error over (returns true); otherwise it is shown. */
  const run = (
    what: Exclude<Busy, null>,
    fn: () => Promise<void>,
    handled?: (err: unknown) => boolean,
  ) => {
    setBusy(what);
    setError(null);
    fn().then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        if (handled?.(err) !== true) setError(setupErrorText(err));
      },
    );
  };
  return { busy, error, run };
}

function Panel({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-2 rounded-md border border-separator px-3 py-2.5"
    >
      <p className="text-callout font-medium text-label-primary">{title}</p>
      {children}
    </section>
  );
}

function Failure({ text }: { text: string | null }): ReactElement | null {
  return text ? (
    <p role="alert" className="text-footnote text-danger-text">
      {text}
    </p>
  ) : null;
}

function Problem({ status }: { status: LinkSetupStatus }): ReactElement | null {
  const p = status.problem;
  if (!p) return null;
  return (
    <p role="status" className="text-footnote text-danger-text">
      {t("settings.credentials.payments.setup.problem", {
        path: p.path,
        reason: reasonText(p.reason),
      })}
    </p>
  );
}

function EnvNote({ status }: { status: LinkSetupStatus }): ReactElement | null {
  return status.cli?.source === "env" ? (
    <p className="text-footnote text-label-tertiary">
      {t("settings.credentials.payments.setup.envOverride")}
    </p>
  ) : null;
}

/** The merchants of payments still open, when the Gateway refused a disconnect for them. */
export function openPaymentsOf(err: unknown): string[] | null {
  const d = (err as { details?: { reason?: unknown; payments?: unknown } } | null)?.details;
  if (d?.reason !== "payment_in_progress") return null;
  return Array.isArray(d.payments)
    ? d.payments
        .map((p) => (p as { merchantName?: unknown } | null)?.merchantName)
        .filter((n): n is string => typeof n === "string" && n !== "")
    : [];
}

/**
 * Disconnect with a confirmation: it deletes the saved sign-in and the CLI path. If a payment is
 * still open the Gateway refuses, and only then is "Disconnect anyway" offered, naming the payment.
 */
export function DisconnectLink({
  onDisconnect,
  label,
}: {
  onDisconnect: (force?: boolean) => Promise<void>;
  label?: string;
}): ReactElement {
  const { busy, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState<string[] | null>(null);
  if (!confirming) {
    return (
      <span className="flex flex-col gap-1.5">
        <span>
          <Button type="button" size="sm" variant="plain" onClick={() => setConfirming(true)}>
            {label ?? t("settings.credentials.payments.setup.disconnect")}
          </Button>
        </span>
        <Failure text={error} />
      </span>
    );
  }
  if (open !== null && open.length > 0) {
    return (
      <section
        aria-label={t("settings.credentials.payments.setup.force.title")}
        className="flex flex-col gap-2 rounded-md border border-separator px-3 py-2"
      >
        <p className="text-callout font-medium text-label-primary">
          {t("settings.credentials.payments.setup.force.title")}
        </p>
        <p role="alert" className="text-callout text-label-secondary">
          {t("settings.credentials.payments.setup.force.body", { payments: open.join(", ") })}
        </p>
        <Failure text={error} />
        <span className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => run("disconnect", () => onDisconnect(true))}
          >
            {busy === "disconnect"
              ? t("settings.credentials.payments.setup.disconnecting")
              : t("settings.credentials.payments.setup.force.go")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="plain"
            disabled={busy !== null}
            onClick={() => {
              setOpen(null);
              setConfirming(false);
            }}
          >
            {t("settings.credentials.payments.setup.disconnectConfirm.cancel")}
          </Button>
        </span>
      </section>
    );
  }
  return (
    <section
      aria-label={t("settings.credentials.payments.setup.disconnectConfirm.title")}
      className="flex flex-col gap-2 rounded-md border border-separator px-3 py-2"
    >
      <p className="text-callout font-medium text-label-primary">
        {t("settings.credentials.payments.setup.disconnectConfirm.title")}
      </p>
      <p className="text-callout text-label-secondary">
        {t("settings.credentials.payments.setup.disconnectConfirm.body")}
      </p>
      <Failure text={error} />
      <span className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            run(
              "disconnect",
              () => onDisconnect(),
              (err) => {
                const names = openPaymentsOf(err);
                if (names === null) return false;
                // A record without a merchant name still blocks: say "a payment".
                setOpen(
                  names.length > 0
                    ? names
                    : [t("settings.credentials.payments.setup.force.aPayment")],
                );
                return true;
              },
            )
          }
        >
          {busy === "disconnect"
            ? t("settings.credentials.payments.setup.disconnecting")
            : t("settings.credentials.payments.setup.disconnectConfirm.go")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="plain"
          disabled={busy !== null}
          onClick={() => setConfirming(false)}
        >
          {t("settings.credentials.payments.setup.disconnectConfirm.cancel")}
        </Button>
      </span>
    </section>
  );
}

/** Link's own sign-in page: https on link.com only, whatever the Gateway sent. */
export function isLinkPage(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.username === "" &&
      (u.hostname === "link.com" || u.hostname.endsWith(".link.com"))
    );
  } catch {
    return false;
  }
}

/**
 * The sign-in page always opens in the system browser, whatever "Open links in" says: Psyche's own
 * browser is one the agent can drive, and the owner types their Link password on this page.
 */
function SignInLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  const { openExternal } = useSlots();
  // A page off Link's own host (the Gateway checks too) is shown but never offered to open.
  if (!isLinkPage(href)) return <span className="text-label-tertiary">{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent-11 underline underline-offset-2"
      onClick={(e) => {
        e.preventDefault();
        if (openExternal) void openExternal(href).catch(() => {});
        else globalThis.open?.(href, "_blank", "noopener,noreferrer");
      }}
    >
      {children}
    </a>
  );
}

/** Shown while Link is not connected: whichever step the owner is on. */
export function LinkSetupPanel({ view }: { view: LinkSetupView }): ReactElement {
  const { status } = view;
  const { busy, error, run } = useAction();

  if (status.state === "cli_missing") {
    return (
      <Panel title={t("settings.credentials.payments.setup.missing.title")}>
        <p className="text-callout text-label-secondary">
          {t("settings.credentials.payments.setup.missing.body")}
        </p>
        <code className="block break-all rounded-md bg-surface-raised px-2.5 py-1.5 font-mono text-footnote text-label-primary">
          {INSTALL_COMMAND}
        </code>
        <p className="text-footnote text-label-tertiary">
          {t("settings.credentials.payments.setup.missing.region")}
        </p>
        <Problem status={status} />
        <span>
          <Button type="button" size="sm" variant="plain" onClick={view.onRecheck}>
            {t("settings.credentials.payments.setup.recheck")}
          </Button>
        </span>
      </Panel>
    );
  }

  if (status.state === "cli_found") {
    return (
      <Panel title={t("settings.credentials.payments.setup.found.title")}>
        <p className="text-callout text-label-secondary">
          {t("settings.credentials.payments.setup.found.body")}
        </p>
        <Problem status={status} />
        <ul className="flex flex-col gap-2">
          {status.candidates.map((c) => (
            <li key={c.path} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-all font-mono text-footnote text-label-primary">
                {c.path}
              </span>
              <Button
                type="button"
                size="sm"
                disabled={busy !== null}
                aria-label={t("settings.credentials.payments.setup.found.connectPath", {
                  path: c.path,
                })}
                onClick={() => run("connect", () => view.onConnect(c.path))}
              >
                {busy === "connect"
                  ? t("settings.credentials.payments.setup.found.connecting")
                  : t("settings.credentials.payments.setup.found.connect")}
              </Button>
            </li>
          ))}
        </ul>
        <Failure text={error} />
        {status.candidates.length === 0 ? (
          <span>
            <Button type="button" size="sm" variant="plain" onClick={view.onRecheck}>
              {t("settings.credentials.payments.setup.recheck")}
            </Button>
          </span>
        ) : null}
      </Panel>
    );
  }

  if (status.state === "signing_in" && status.signIn) {
    const { verificationUrl, phrase } = status.signIn;
    return (
      <Panel title={t("settings.credentials.payments.setup.signingIn.title")}>
        <p className="text-callout text-label-secondary">
          {t("settings.credentials.payments.setup.signingIn.body")}
        </p>
        <p className="text-callout text-label-primary">
          {t("settings.credentials.payments.setup.signingIn.phrase")}{" "}
          <strong className="font-mono">{phrase}</strong>
        </p>
        <p>
          <SignInLink href={verificationUrl}>
            {t("settings.credentials.payments.setup.signingIn.open")}
          </SignInLink>
        </p>
        <p role="status" className="text-footnote text-label-tertiary">
          {t("settings.credentials.payments.setup.signingIn.waiting")}
        </p>
        <EnvNote status={status} />
        <DisconnectLink onDisconnect={view.onDisconnect} />
      </Panel>
    );
  }

  // signed_out (and a signing_in the Gateway reports without its page: ask again).
  return (
    <Panel title={t("settings.credentials.payments.setup.signedOut.title")}>
      <p className="text-callout text-label-secondary">
        {t("settings.credentials.payments.setup.signedOut.body")}
      </p>
      {status.cli ? (
        <p className="break-all font-mono text-footnote text-label-secondary">{status.cli.path}</p>
      ) : null}
      <Failure text={error} />
      <span className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() => run("signIn", view.onSignIn)}
        >
          {busy === "signIn"
            ? t("settings.credentials.payments.setup.signedOut.starting")
            : t("settings.credentials.payments.setup.signedOut.go")}
        </Button>
      </span>
      <EnvNote status={status} />
      <DisconnectLink onDisconnect={view.onDisconnect} />
    </Panel>
  );
}
