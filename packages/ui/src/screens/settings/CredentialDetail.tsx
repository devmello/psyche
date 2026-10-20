import type { CredentialMeta, CredentialUse } from "@psyche/protocol";
import { type ReactElement, useId, useRef } from "react";
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
import { useGatewayQuery } from "../../data/hooks.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { bindingLabel, KIND_LABEL } from "./credential-labels.ts";
import { EmptyNotice, Facts, LoadGate, StatusChip, type Tone } from "./shared.tsx";

/**
 * A vault item's detail (features G3 and G14; security §4.10): its metadata and the fill audit,
 * the last 50 uses with where, which task, which approval and the outcome. Never values.
 */

export const USES_SHOWN = 50;

const EXECUTOR: Record<CredentialUse["executor"], string> = {
  browser: "Browser",
  connector: "Connector",
  sandbox: "Sandbox",
  ssh: "SSH",
};

const OUTCOME: Record<CredentialUse["outcome"], { label: string; tone: Tone }> = {
  filled: { label: "Filled", tone: "success" },
  denied: { label: "Denied", tone: "approval" },
  failed: { label: "Failed", tone: "danger" },
};

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
          { term: "Kind", value: KIND_LABEL[c.kind] },
          {
            term: "Bound to",
            value: c.bindings.map(bindingLabel).join(", ") || "Any site, after you approve",
          },
          { term: "Added", value: formatRelative(c.createdAt, now) },
          { term: "Changed", value: formatRelative(c.updatedAt, now) },
          { term: "Last used", value: c.lastUsedAt ? formatRelative(c.lastUsedAt, now) : "Never" },
          { term: "Uses", value: <span className="tabular-nums">{c.useCount}</span> },
        ]}
      />
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <SectionLabel as="h3" id={headingId}>
          Recent uses
        </SectionLabel>
        <p className="text-xs text-muted-foreground">
          The last {USES_SHOWN} fills, newest first. Psyche records where and why, never the value.
        </p>
        <LoadGate
          label="recent uses"
          loading={loading}
          error={error}
          {...(onRetry ? { onRetry } : {})}
        >
          {uses.length === 0 ? (
            <EmptyNotice text="Not used yet." />
          ) : (
            <Table aria-label="Recent uses" className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">When</TableHead>
                  <TableHead scope="col">Where</TableHead>
                  <TableHead scope="col">Task</TableHead>
                  <TableHead scope="col">Outcome</TableHead>
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
                      <span className="block text-muted-foreground">{EXECUTOR[u.executor]}</span>
                    </TableCell>
                    <TableCell className="align-top">
                      {u.taskId === null ? (
                        <span className="text-muted-foreground">None</span>
                      ) : onOpenTask ? (
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          className="h-auto p-0"
                          onClick={() => onOpenTask(u.taskId as string)}
                        >
                          Open task
                        </Button>
                      ) : (
                        <code className="font-mono">{u.taskId}</code>
                      )}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <StatusChip tone={OUTCOME[u.outcome].tone}>
                        {OUTCOME[u.outcome].label}
                      </StatusChip>
                      {u.reason ? (
                        <span className="mt-1 block text-muted-foreground">{u.reason}</span>
                      ) : null}
                      <span className="mt-1 block text-muted-foreground">
                        {u.approvalId === null ? (
                          "No approval card"
                        ) : (
                          <>
                            Approval <code className="font-mono">{u.approvalId}</code>
                          </>
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
  return (
    <Sheet open={credential !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        {c ? (
          <>
            <SheetHeader className="px-6 pt-6 pb-4">
              <SheetTitle className="text-h2">{c.name}</SheetTitle>
              <SheetDescription>
                {KIND_LABEL[c.kind]} · <span className="font-mono">{c.slug}</span>
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
