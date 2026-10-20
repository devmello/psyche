import type { CredentialMeta, CredentialUse } from "@psyche/protocol";
import { type ReactElement, useId, useRef, useState } from "react";
import { SectionLabel } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { copyText } from "../../lib/clipboard.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { useSlots } from "../../slots.tsx";
import { bindingLabel, credentialKindLabel } from "./credential-labels.ts";
import { EmptyNotice, Facts, LoadGate, StatusChip, type Tone } from "./shared.tsx";

/**
 * A vault item's detail (features G3 and G14; security §4.10): its metadata and the fill audit,
 * the last 50 uses with where, which task, which approval and the outcome. Never values.
 */

export const USES_SHOWN = 50;

const executorLabel = (e: CredentialUse["executor"]): string =>
  t(`settings.credentials.detail.executor.${e}`);

const OUTCOME_TONE: Record<CredentialUse["outcome"], Tone> = {
  filled: "success",
  denied: "approval",
  failed: "danger",
};

/** "Approved", with the approval id (level 2) in a tooltip; clicking copies it. */
export function ApprovalRef({ id }: { id: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const { writeClipboard } = useSlots();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            aria-label={t("settings.credentials.detail.copyApproval", { id })}
            onClick={() => {
              void copyText(id, writeClipboard).then((ok) => setCopied(ok));
            }}
          />
        }
      >
        {copied
          ? t("settings.credentials.detail.approvedCopied")
          : t("settings.credentials.detail.approved")}
      </TooltipTrigger>
      <TooltipContent>
        <code className="font-mono">{id}</code>
      </TooltipContent>
    </Tooltip>
  );
}

export interface CredentialDetailProps {
  credential: CredentialMeta;
  uses: readonly CredentialUse[];
  now: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Opens the task in Activity; without it the task id is shown as text. */
  onOpenTask?: (taskId: string) => void;
}

export function CredentialDetail({
  credential: c,
  uses,
  now,
  loading = false,
  error = null,
  onRetry,
  onOpenTask,
}: CredentialDetailProps): ReactElement {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-5">
      <Facts
        items={[
          { term: t("settings.credentials.col.kind"), value: credentialKindLabel(c.kind) },
          {
            term: t("settings.credentials.col.boundTo"),
            value:
              c.bindings.map(bindingLabel).join(", ") ||
              t("settings.credentials.detail.anySiteApproved"),
          },
          { term: t("settings.credentials.detail.added"), value: formatRelative(c.createdAt, now) },
          {
            term: t("settings.credentials.detail.changed"),
            value: formatRelative(c.updatedAt, now),
          },
          {
            term: t("settings.credentials.col.lastUsed"),
            value: c.lastUsedAt
              ? formatRelative(c.lastUsedAt, now)
              : t("settings.credentials.never"),
          },
          {
            term: t("settings.credentials.col.uses"),
            value: <span className="tabular-nums">{activeI18n().number(c.useCount)}</span>,
          },
        ]}
      />
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <SectionLabel as="h3" id={headingId}>
          {t("settings.credentials.detail.recentUses")}
        </SectionLabel>
        <p className="text-xs text-muted-foreground">
          {t("settings.credentials.detail.recentUsesHint", { n: USES_SHOWN })}
        </p>
        <LoadGate
          label={t("settings.credentials.detail.recentUsesLoad")}
          loading={loading}
          error={error}
          {...(onRetry ? { onRetry } : {})}
        >
          {uses.length === 0 ? (
            <EmptyNotice text={t("settings.credentials.detail.notUsed")} />
          ) : (
            <Table aria-label={t("settings.credentials.detail.recentUses")} className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("settings.credentials.detail.when")}</TableHead>
                  <TableHead scope="col">{t("settings.credentials.detail.where")}</TableHead>
                  <TableHead scope="col">{t("settings.credentials.detail.task")}</TableHead>
                  <TableHead scope="col">{t("settings.credentials.detail.outcome")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {uses.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="align-top">
                      <time dateTime={u.createdAt}>{formatRelative(u.createdAt, now)}</time>
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <span className="break-all">{u.target}</span>
                      <span className="block text-muted-foreground">
                        {executorLabel(u.executor)}
                      </span>
                    </TableCell>
                    <TableCell className="align-top">
                      {u.taskId === null ? (
                        <span className="text-muted-foreground">
                          {t("settings.credentials.detail.noTask")}
                        </span>
                      ) : onOpenTask ? (
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          className="h-auto p-0"
                          onClick={() => onOpenTask(u.taskId as string)}
                        >
                          {t("settings.credentials.detail.openTask")}
                        </Button>
                      ) : (
                        <code className="font-mono">{u.taskId}</code>
                      )}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <StatusChip tone={OUTCOME_TONE[u.outcome]}>
                        {t(`settings.credentials.detail.outcome.${u.outcome}`)}
                      </StatusChip>
                      {u.reason ? (
                        <span className="mt-1 block text-muted-foreground">{u.reason}</span>
                      ) : null}
                      <span className="mt-1 block text-muted-foreground">
                        {u.approvalId == null ? (
                          t("settings.credentials.detail.noApproval")
                        ) : (
                          <ApprovalRef id={u.approvalId} />
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </LoadGate>
      </section>
    </div>
  );
}

export interface CredentialDetailSheetProps {
  /** The item to show; `null` closes the sheet. */
  credential: CredentialMeta | null;
  onOpenChange: (open: boolean) => void;
  onOpenTask?: (taskId: string) => void;
  now?: number;
}

/** The detail in a side sheet, loading `vault.uses` while it is open. */
export function CredentialDetailSheet({
  credential,
  onOpenChange,
  onOpenTask,
  now,
}: CredentialDetailSheetProps): ReactElement {
  const clock = useNow(30_000, now);
  // Keep the last item while the sheet animates closed.
  const last = useRef<CredentialMeta | null>(credential);
  if (credential !== null) last.current = credential;
  const c = credential ?? last.current;
  const q = useGatewayQuery(
    "vault.uses",
    { credentialId: c?.id ?? "", limit: USES_SHOWN },
    { enabled: credential !== null },
  );
  // The kit's Sheet takes physical sides; open it at the inline end in either direction.
  const side = activeI18n().dir === "rtl" ? "left" : "right";
  return (
    <Sheet open={credential !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className="gap-0 data-[side=left]:w-full data-[side=left]:sm:max-w-xl data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        {c ? (
          <>
            <SheetHeader className="px-6 pt-6 pb-4">
              <SheetTitle className="text-h2">{c.name}</SheetTitle>
              <SheetDescription>
                {credentialKindLabel(c.kind)} · <span className="font-mono">{c.slug}</span>
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
              <CredentialDetail
                credential={c}
                uses={q.data?.uses ?? []}
                now={clock}
                loading={q.loading && q.data === undefined}
                error={q.error}
                onRetry={q.reload}
                {...(onOpenTask
                  ? {
                      onOpenTask: (taskId: string) => {
                        onOpenChange(false);
                        onOpenTask(taskId);
                      },
                    }
                  : {})}
              />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
