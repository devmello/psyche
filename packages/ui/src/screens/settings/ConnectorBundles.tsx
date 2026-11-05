import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { ConnectorBundleCard as Card, McpProposal, McpServerStatus } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useContext, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { ConnectorBundleCard } from "./ConnectorBundleCard.tsx";
import { McpSecretsGroup } from "./McpServerPanels.tsx";
import { presenceUnavailable } from "./SettingsApproval.tsx";
import { TrustApproval } from "./SkillsSection.tsx";
import {
  approvalIdOf,
  ErrorNotice,
  Group,
  hasCode,
  messageOf,
  SettingsApprovalContext,
} from "./shared.tsx";
import { type McpState, useMcpSecrets } from "./use-mcp.tsx";

/**
 * Importing and sharing a connector as a signed file (docs/design/shared-bundles-2026.md
 * section 8). Import: the card shows everything it asks for (and says plainly when this Gateway
 * has no sandbox), the existing device-only approval is under it, approving adds the server
 * through `mcp.add`, then the owner is asked for the secrets by name. Share: a Settings action
 * on a connector the owner set up; the Gateway asks for the owner's confirmation first.
 */

const show = (s: string, max = 64) => sanitizeDisplay(s, max);
const MAX_FILE = 8 * 1024 * 1024;

type Staged = { card: Card; proposal: McpProposal; approvalId: string };

export interface ConnectorBundlesState {
  /** The card (with its approval) under review, or the card of a connector that cannot be installed. */
  review: ReactNode;
  notice: string | null;
  error: string | null;
  checking: boolean;
  /** The connector just added, for the secrets form. */
  added: McpServerStatus | null;
  hasAuthorKey: boolean;
  importFile: (file: File | undefined) => void;
  importLink: (url: string) => void;
  share: (server: McpServerStatus, authorName?: string) => void;
  /** Sets a damaged record of shared connectors aside (`connectors.resetRecords`). */
  resetRecords: () => void;
}

/** Saves the file the browser is handed; the Gateway made it, nothing here reads it. */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useConnectorBundles(
  mcp: Pick<McpState, "reload">,
  now?: number,
): ConnectorBundlesState {
  const call = useCall();
  const authorsQ = useGatewayQuery("skills.authors.list", {});
  const requestApproval = useContext(SettingsApprovalContext);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [blocked, setBlocked] = useState<Card | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [added, setAdded] = useState<McpServerStatus | null>(null);

  const reset = () => {
    setError(null);
    setNotice(null);
    setAdded(null);
    setBlocked(null);
  };

  const review = (p: Promise<Awaited<ReturnType<typeof call<"connectors.proposeImport">>>>) => {
    reset();
    setChecking(true);
    p.then(
      (r) => {
        if (r.proposal === undefined || r.approval === undefined) setBlocked(r.card);
        else setStaged({ card: r.card, proposal: r.proposal, approvalId: r.approval.id });
      },
      (err: unknown) =>
        setError(t("settings.connectorBundle.import.failed", { reason: messageOf(err) })),
    ).finally(() => setChecking(false));
  };

  const decided = (status: "approved" | "denied" | "expired" | "invalidated") => {
    const current = staged;
    if (current === null) return;
    setStaged(null);
    const name = show(current.card.title);
    if (status !== "approved") {
      setNotice(
        status === "denied"
          ? t("settings.connectorBundle.import.denied", { name })
          : t("settings.connectorBundle.import.lapsed", { name, expired: status === "expired" }),
      );
      return;
    }
    call("mcp.add", { proposalId: current.proposal.id, approvalId: current.approvalId }).then(
      (r) => {
        mcp.reload();
        setAdded(r.server);
        setNotice(
          current.card.secrets.length + current.card.env.length > 0
            ? t("settings.connectorBundle.import.added", { name })
            : t("settings.connectorBundle.import.addedNoSecrets", { name }),
        );
      },
      (err: unknown) =>
        setError(t("settings.connectorBundle.import.addFailed", { name, reason: messageOf(err) })),
    );
  };

  const cardView = staged ? (
    <ConnectorBundleCard card={staged.card} onCancel={() => setStaged(null)}>
      <TrustApproval
        key={staged.approvalId}
        approvalId={staged.approvalId}
        onDecided={decided}
        {...(now === undefined ? {} : { now })}
      />
    </ConnectorBundleCard>
  ) : blocked ? (
    <ConnectorBundleCard card={blocked} onCancel={() => setBlocked(null)} />
  ) : null;

  return {
    review: cardView,
    notice,
    error,
    checking,
    added,
    hasAuthorKey: authorsQ.data?.own !== undefined,
    importFile: (file) => {
      if (file === undefined) return;
      if (file.size > MAX_FILE) {
        reset();
        setError(
          t("settings.connectorBundle.import.failed", {
            reason: t("settings.connectorBundle.import.tooBig"),
          }),
        );
        return;
      }
      file.text().then(
        (text) => review(call("connectors.proposeImport", { name: file.name, text })),
        (err: unknown) =>
          setError(t("settings.connectorBundle.import.failed", { reason: messageOf(err) })),
      );
    },
    importLink: (url) => review(call("connectors.proposeImport", { bundleUrl: url.trim() })),
    resetRecords: () => {
      reset();
      call("connectors.resetRecords", {}).then(
        (r) => {
          mcp.reload();
          setNotice(t("settings.connectorBundle.reset.done", { restored: r.restored }));
        },
        (err: unknown) =>
          setError(t("settings.connectorBundle.reset.failed", { reason: messageOf(err) })),
      );
    },
    share: (server, authorName) => {
      reset();
      const args = {
        serverId: server.id,
        ...(authorName === undefined || authorName === "" ? {} : { authorName }),
      };
      const finish = (r: { filename: string; bundle: string; signer: { name: string } }) => {
        download(r.filename, r.bundle);
        authorsQ.reload();
        setNotice(
          t("settings.connectorBundle.share.done", {
            file: show(r.filename, 120),
            author: show(r.signer.name),
          }),
        );
      };
      const fail = (err: unknown) =>
        setError(
          hasCode(err, "forbidden")
            ? t("settings.connectorBundle.share.unavailable")
            : t("settings.connectorBundle.share.failed", { reason: messageOf(err) }),
        );
      call("connectors.export", args).then(finish, (err: unknown) => {
        // Signing needs the owner's confirmation (Touch ID or a passkey once one is set up): the
        // settings approval banner shows it, and the export is made again with the approval.
        const approvalId = approvalIdOf(err);
        if (approvalId === null) return fail(err);
        if (requestApproval === null) return setError(presenceUnavailable());
        requestApproval({
          key: "connectors.export",
          label: t("settings.connectorBundle.share.label", { name: show(server.name) }),
          approvalId,
          retry: (approved) =>
            call("connectors.export", { ...args, approvalId: approved }).then(
              (r) => {
                finish(r);
                return r;
              },
              (retryErr: unknown) => {
                fail(retryErr);
                throw retryErr;
              },
            ),
        });
      });
    },
  };
}

/** Notices, errors and the secrets form that follow an import. */
export function ConnectorBundleStatus({ state }: { state: ConnectorBundlesState }): ReactElement {
  return (
    <>
      <div role="status" className="text-sm empty:hidden">
        {state.notice ? <p>{state.notice}</p> : null}
      </div>
      {state.error ? <ErrorNotice what={state.error} /> : null}
      {state.added ? <InstalledSecrets server={state.added} /> : null}
    </>
  );
}

/** The secrets of a connector that was just added, by name; the values go to the vault. */
function InstalledSecrets({ server }: { server: McpServerStatus }): ReactElement | null {
  const secrets = useMcpSecrets(server, true);
  if (secrets.secrets.length === 0) return null;
  return (
    <Group title={t("settings.connectorBundle.import.secretsTitle", { name: show(server.name) })}>
      <McpSecretsGroup state={secrets} />
    </Group>
  );
}

/** "Import a connector file" and "paste a link". */
export function ConnectorBundleImport({ state }: { state: ConnectorBundlesState }): ReactElement {
  const fileId = useId();
  const linkId = useId();
  const [link, setLink] = useState("");
  const [resetting, setResetting] = useState(false);
  return (
    <Group
      title={t("settings.connectorBundle.import.title")}
      description={t("settings.connectorBundle.import.hint")}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={fileId}
            type="file"
            accept=".psyche-connector,application/json"
            className="sr-only"
            aria-label={t("settings.connectorBundle.import.file")}
            onChange={(e) => {
              state.importFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={state.checking}
            onClick={() => document.getElementById(fileId)?.click()}
          >
            {t("settings.connectorBundle.import.file")}
          </Button>
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (link.trim() !== "") state.importLink(link);
          }}
        >
          <Label htmlFor={linkId}>{t("settings.connectorBundle.import.linkLabel")}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={linkId}
              value={link}
              placeholder={t("settings.connectorBundle.import.linkPlaceholder")}
              onChange={(e) => setLink(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" disabled={state.checking || link.trim() === ""}>
              {state.checking
                ? t("settings.connectorBundle.import.checking")
                : t("settings.connectorBundle.import.review")}
            </Button>
          </div>
        </form>
        <div className="flex flex-col gap-1">
          <h4 className="font-medium">{t("settings.connectorBundle.reset.title")}</h4>
          <p className="text-callout text-muted-foreground">
            {t("settings.connectorBundle.reset.hint")}
          </p>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (resetting) {
                  setResetting(false);
                  state.resetRecords();
                } else setResetting(true);
              }}
            >
              {resetting
                ? t("settings.connectorBundle.reset.confirm")
                : t("settings.connectorBundle.reset.go")}
            </Button>
          </div>
        </div>
      </div>
    </Group>
  );
}

/**
 * "Share this connector" in a command server's detail. Asks for the author name only when there
 * is no author key yet; the Gateway then asks for the owner's confirmation before signing.
 */
export function ConnectorShare({
  server,
  state,
}: {
  server: McpServerStatus;
  state: ConnectorBundlesState;
}): ReactElement | null {
  const nameId = useId();
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState("");
  // Only a command server the owner set up: not a URL server, not Psyche's own, not a built-in.
  if (server.transport !== "stdio" || server.madeBy === "psyche" || server.trust === "bundled")
    return null;
  return (
    <Group
      title={t("settings.connectorBundle.share.title")}
      description={t("settings.connectorBundle.share.hint")}
      actions={
        asking ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={server.enabled === false || !server.connected}
            onClick={() => (state.hasAuthorKey ? state.share(server) : setAsking(true))}
          >
            {t("settings.connectorBundle.share.go")}
          </Button>
        )
      }
    >
      {asking ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() === "") return;
            state.share(server, name.trim());
            setAsking(false);
          }}
        >
          <Label htmlFor={nameId}>{t("settings.connectorBundle.share.nameLabel")}</Label>
          <Input
            id={nameId}
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-callout text-muted-foreground">
            {t("settings.connectorBundle.share.nameHint")}
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={name.trim() === ""}>
              {t("settings.connectorBundle.share.make")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
    </Group>
  );
}
