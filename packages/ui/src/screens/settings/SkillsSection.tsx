import { sanitizeBlock, sanitizeDisplay } from "@psyche/permissions/cards";
import type {
  SkillDetails,
  SkillInstallSource,
  SkillManifest,
  SkillProposal,
} from "@psyche/protocol";
import { FolderOpen, ShieldAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ApprovalCard } from "../../blocks/ApprovalCard.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { answerApproval, useApproval, useCall, useGatewayQuery } from "../../data/hooks.ts";
import { useStore } from "../../data/provider.tsx";
import { t } from "../../i18n/core.ts";
import { usePersona } from "../../slots.tsx";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import { SkillSuggestions } from "./SkillDraftCard.tsx";
import {
  EmptyNotice,
  ErrorNotice,
  Facts,
  Group,
  hasCode,
  LoadGate,
  type LoadProps,
  messageOf,
  SectionFrame,
  StatusChip,
  type Tone,
} from "./shared.tsx";

/**
 * Settings → Skills (features T1, T2; security §11; UI design §3.18). Installed and bundled
 * skills with their status; "Install a skill" reviews a folder or `.zip`: the Gateway fetches,
 * scans and checks the skill's manifest against the owner's policy, then the trust card shows
 * everything it contains and asks for, with the device-only `skill_install` approval under it.
 * Approving installs it; nothing is written before. Skill text is the publisher's, never the
 * owner's: every string from it is sanitized and shown as data.
 */

/** The approval kinds a skill may declare that have plain words. */
const PERMISSIONS = [
  "exec",
  "exec_host",
  "send_email",
  "calendar_write",
  "message_send",
  "browser_submit",
  "credential_fill",
  "purchase",
  "file_write",
  "connector_action",
  "computer_action",
  "new_origin",
  "mcp_tool",
  "apple_script",
  "shortcut_run",
] as const;

/** Plain words for an approval kind a skill declares; an unknown kind shows as written. */
function permissionLabel(p: string): string {
  const known = PERMISSIONS.find((k) => k === p);
  return known === undefined ? p : t(`settings.skills.permission.${known}`);
}

const STATUS_TONE: Record<SkillDetails["status"], Tone> = {
  active: "success",
  disabled: "neutral",
  draft: "approval",
  unlocked: "approval",
  hash_mismatch: "danger",
  invalid: "danger",
  blocked: "danger",
  ineligible: "neutral",
  shadowed: "neutral",
};

const trustLabel = (trust: SkillDetails["trust"]): string => t(`settings.skills.trust.${trust}`);

const show = (s: string, max = 300) => sanitizeDisplay(s, max);

function sourceText(source: SkillInstallSource): string {
  return source.kind === "git" ? `${source.url} @ ${source.ref}` : source.path;
}

/** Folder paths review as `path`; `.zip` and `.skill` archives as `zip`. */
export function skillSourceOf(input: string): SkillInstallSource {
  const path = input.trim();
  return /\.(zip|skill)$/i.test(path) ? { kind: "zip", path } : { kind: "path", path };
}

/** What a manifest asks for, in one line (the list row). */
export function asksFor(m: SkillManifest | undefined): string {
  if (m === undefined) return t("settings.skills.asks.unknown");
  const perms = m.permissions.map(permissionLabel);
  if (perms.length === 0 && m.tools.length === 0) return t("settings.skills.asks.nothing");
  return [
    perms.length > 0 ? perms.join(", ") : null,
    m.tools.length > 0 ? t("settings.skills.tools", { n: m.tools.length }) : null,
  ]
    .filter((x) => x !== null)
    .join(" · ");
}

// --- Trust card --------------------------------------------------------------------------------

export interface SkillTrustCardProps {
  proposal: SkillProposal;
  /** The `skill_install` approval card (connected) or a static stand-in in stories. */
  children?: ReactNode;
  onCancel?: () => void;
}

/** Everything a skill contains and asks for, shown before the owner approves (security §11). */
/** Finding severities in words, not the analyzer's enum. */
function severityLabel(severity: string): string {
  if (severity === "high" || severity === "warn" || severity === "info")
    return t(`settings.skills.severity.${severity}`);
  return severity;
}

export function SkillTrustCard({
  proposal,
  children,
  onCancel,
}: SkillTrustCardProps): ReactElement {
  const id = useId();
  const persona = usePersona().name;
  const m = proposal.manifest ?? { tools: [], permissions: [], prompts: [] };
  const high = proposal.findings.filter((f) => f.severity === "high");
  const updating = proposal.update !== undefined;
  return (
    <section
      aria-labelledby={id}
      data-testid="skill-trust-card"
      className="flex flex-col gap-4 rounded-lg border border-approval-border bg-gray-2 p-4 text-sm"
    >
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 id={id} className="text-h3 text-foreground">
            {t("settings.skills.trust.title", { name: show(proposal.name, 64), updating })}
          </h3>
          <p className="mt-0.5 text-small text-muted-foreground">
            {t("settings.skills.trust.intro", { persona })}
          </p>
        </div>
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </header>

      <Facts
        items={[
          {
            term: t("settings.skills.trust.source"),
            value: <code>{show(sourceText(proposal.source), 2048)}</code>,
          },
          { term: t("settings.skills.trust.publisher"), value: trustLabel(proposal.trust) },
        ]}
      />

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("settings.browser.details")}</summary>
        <Facts
          className="mt-2"
          items={[
            ...(proposal.commit === undefined
              ? []
              : [
                  {
                    term: t("settings.skills.trust.commit"),
                    value: <code>{show(proposal.commit, 80)}</code>,
                  },
                ]),
            {
              term: t("settings.skills.trust.hash"),
              value: <code className="break-all">{proposal.hash}</code>,
            },
            ...(m.tools.length === 0
              ? []
              : [
                  {
                    term: t("settings.skills.trust.toolNames"),
                    value: <code>{m.tools.map((x) => show(x, 80)).join(", ")}</code>,
                  },
                ]),
          ]}
        />
      </details>

      <section className="flex flex-col gap-2" aria-labelledby={`${id}-asks`}>
        <h4 id={`${id}-asks`} className="font-medium">
          {t("settings.skills.trust.asks")}
        </h4>
        <Facts
          items={[
            {
              term: t("settings.skills.trust.permissions"),
              value:
                m.permissions.length === 0 ? (
                  t("settings.skills.none")
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {m.permissions.map((p) => (
                      <li key={p}>
                        <StatusChip tone={p === "exec" || p === "purchase" ? "danger" : "approval"}>
                          {permissionLabel(p)}
                        </StatusChip>
                      </li>
                    ))}
                  </ul>
                ),
            },
            {
              term: t("settings.skills.trust.tools"),
              value:
                m.tools.length === 0
                  ? t("settings.skills.none")
                  : t("settings.skills.tools", { n: m.tools.length }),
            },
            {
              term: t("settings.skills.trust.prompts"),
              value:
                m.prompts.length === 0 ? (
                  t("settings.skills.none")
                ) : (
                  <code>{m.prompts.map((x) => show(x, 200)).join(", ")}</code>
                ),
            },
          ]}
        />
      </section>

      {proposal.findings.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium">{t("settings.skills.trust.findings")}</h4>
          {high.length > 0 ? (
            <p role="alert" className="flex items-start gap-2 text-danger-text">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t("settings.skills.trust.high", { n: high.length })}
            </p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {proposal.findings.map((f) => (
              <li key={`${f.rule}:${f.file ?? ""}:${f.line ?? 0}`} className="flex flex-wrap gap-2">
                <StatusChip
                  tone={
                    f.severity === "high" ? "danger" : f.severity === "warn" ? "approval" : "info"
                  }
                >
                  {severityLabel(f.severity)}
                </StatusChip>
                <span className="min-w-0 flex-1">
                  {show(f.message)}
                  {f.file === undefined
                    ? ""
                    : ` (${show(f.file, 200)}${f.line === undefined ? "" : `:${f.line}`})`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground">{t("settings.skills.trust.clean")}</p>
      )}

      {proposal.update !== undefined ? (
        <details>
          <summary className="cursor-pointer font-medium">
            {t("settings.skills.trust.changes")}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-gray-3 p-3 text-xs whitespace-pre-wrap">
            {proposal.update.diff === ""
              ? t("settings.skills.trust.noChanges")
              : sanitizeBlock(proposal.update.diff)}
          </pre>
        </details>
      ) : null}

      <details open>
        <summary className="cursor-pointer font-medium">
          {t("settings.skills.trust.fullText")}
        </summary>
        <pre
          className="mt-2 max-h-72 overflow-auto rounded-md bg-gray-3 p-3 text-xs whitespace-pre-wrap"
          data-testid="skill-text"
        >
          {sanitizeBlock(proposal.text)}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer font-medium">
          {t("settings.skills.trust.files", { n: proposal.files.length })}
        </summary>
        <ul className="mt-2 flex flex-col gap-2">
          {proposal.files.map((f) => (
            <li key={f.path}>
              <p>
                <code>{show(f.path, 300)}</code>{" "}
                <span className="text-xs text-muted-foreground">
                  {t("settings.skills.trust.fileMeta", {
                    bytes: f.bytes,
                    executable: f.executable === true,
                    binary: f.text === undefined,
                  })}
                </span>
              </p>
              {f.text !== undefined && f.path !== "SKILL.md" ? (
                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-gray-3 p-2 text-xs whitespace-pre-wrap">
                  {sanitizeBlock(f.text)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
      {children}
    </section>
  );
}

// --- Panel -------------------------------------------------------------------------------------

export interface SkillsPanelProps extends LoadProps {
  skills: readonly SkillDetails[];
  /** The trust card of the skill under review (the connected section renders it). */
  review?: ReactNode;
  /** A review is being fetched and scanned. */
  reviewing?: boolean;
  checking?: boolean;
  actionError?: string | null;
  notice?: string | null;
  onReview?: (source: SkillInstallSource) => void;
  /** Desktop: a native folder chooser. */
  onPickFolder?: () => Promise<string | null>;
  onToggle?: (skill: SkillDetails, enabled: boolean) => void;
  onRemove?: (skill: SkillDetails) => void;
  onCheckUpdates?: () => void;
  onReviewUpdate?: (skill: SkillDetails) => void;
  /** Agent-proposed drafts (T3), shown above the installed skills. */
  suggestions?: ReactNode;
}

function SkillRow({
  skill,
  onToggle,
  onRemove,
  onReviewUpdate,
}: {
  skill: SkillDetails;
  onToggle?: SkillsPanelProps["onToggle"];
  onRemove?: SkillsPanelProps["onRemove"];
  onReviewUpdate?: SkillsPanelProps["onReviewUpdate"];
}): ReactElement {
  const id = useId();

  const toggleable = skill.status === "active" || skill.status === "disabled";
  const name = show(skill.name, 64);
  return (
    <li
      className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
      data-testid={`skill-${skill.name}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span id={id} className="font-medium">
          {name}
        </span>
        <StatusChip tone={STATUS_TONE[skill.status]}>
          {t(`settings.skills.status.${skill.status}`)}
        </StatusChip>
        {skill.update?.updateAvailable ? (
          <StatusChip tone={skill.update.manifestChanged ? "approval" : "info"}>
            {t("settings.skills.updateAvailable", {
              changed: skill.update.manifestChanged === true,
            })}
          </StatusChip>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {trustLabel(skill.trust)}
          {skill.version === undefined
            ? ""
            : t("settings.skills.version", { version: show(skill.version, 32) })}
        </span>
        <div className="ms-auto flex items-center gap-2">
          {skill.update?.updateAvailable && onReviewUpdate ? (
            <Button type="button" variant="outline" size="xs" onClick={() => onReviewUpdate(skill)}>
              {t("settings.skills.reviewUpdate")}
            </Button>
          ) : null}
          {onRemove && skill.source !== "bundled" ? (
            <RowMoreMenu
              name={name}
              destructive={[
                {
                  label: t("common.remove"),
                  title: t("settings.connectors.removeTitle", { name }),
                  description: t("settings.skills.removeDescription"),
                  confirm: t("common.remove"),
                  onConfirm: () => onRemove(skill),
                },
              ]}
            />
          ) : null}
          {onToggle && toggleable ? (
            <Switch
              aria-label={t("settings.skills.switchOn", { name })}
              checked={skill.userEnabled}
              onCheckedChange={(v) => onToggle(skill, v)}
            />
          ) : null}
        </div>
      </div>
      <p className="text-muted-foreground">{show(skill.description, 400)}</p>
      <p className="text-xs">
        <span className="text-muted-foreground">{t("settings.skills.asksFor")} </span>
        {asksFor(skill.manifest)}
      </p>
      {skill.manifest && skill.manifest.tools.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("settings.browser.details")}</summary>
          <p className="mt-1">
            {t("settings.skills.toolsLabel")}{" "}
            <code>{skill.manifest.tools.map((x) => show(x, 80)).join(", ")}</code>
          </p>
        </details>
      ) : null}
      {skill.status !== "active" && skill.reasons.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {skill.reasons.map((r) => show(r)).join("; ")}
        </p>
      ) : null}
      {skill.findings.some((f) => f.severity === "high") ? (
        <p className="text-xs text-danger-text">
          {skill.findings
            .filter((f) => f.severity === "high")
            .map((f) => show(f.message))
            .join("; ")}
        </p>
      ) : null}
    </li>
  );
}

export function SkillsPanel({
  skills,
  review,
  reviewing = false,
  checking = false,
  actionError = null,
  notice = null,
  onReview,
  onPickFolder,
  onToggle,
  onRemove,
  onCheckUpdates,
  onReviewUpdate,
  suggestions,
  loading,
  error,
  onRetry,
}: SkillsPanelProps): ReactElement {
  const inputId = useId();
  const persona = usePersona().name;
  const [path, setPath] = useState("");
  const [pickError, setPickError] = useState<string | null>(null);
  const installed = skills.filter((s) => s.source !== "bundled");
  const bundled = skills.filter((s) => s.source === "bundled");
  const submit = () => {
    if (path.trim() !== "") onReview?.(skillSourceOf(path));
  };
  const rowProps = {
    ...(onToggle ? { onToggle } : {}),
    ...(onRemove ? { onRemove } : {}),
    ...(onReviewUpdate ? { onReviewUpdate } : {}),
  };
  return (
    <SectionFrame
      title={t("settings.skills.title")}
      description={t("settings.skills.description", { persona })}
      actions={
        onCheckUpdates ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={onCheckUpdates}
          >
            {checking ? t("settings.shortcut.checking") : t("settings.skills.checkUpdates")}
          </Button>
        ) : null
      }
    >
      <LoadGate
        label={t("settings.skills.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {actionError ? (
          <ErrorNotice what={actionError} did={t("settings.skills.nothingChanged")} />
        ) : null}
        {notice ? (
          <p role="status" className="rounded-md bg-gray-3 px-3 py-2 text-sm">
            {notice}
          </p>
        ) : null}
        {review ?? null}
        {onReview && review === undefined ? (
          <Group
            title={t("settings.skills.install")}
            description={t("settings.skills.installHint")}
          >
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Label htmlFor={inputId}>{t("settings.skills.pathLabel")}</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={inputId}
                  value={path}
                  placeholder={t("settings.skills.pathPlaceholder")}
                  onChange={(e) => setPath(e.target.value)}
                  className="min-w-0 flex-1"
                />
                {onPickFolder ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPickError(null);
                      onPickFolder().then(
                        (p) => {
                          if (p === null) return;
                          setPath(p);
                          onReview(skillSourceOf(p));
                        },
                        (err: unknown) =>
                          setPickError(t("settings.skills.pickFailed", { reason: messageOf(err) })),
                      );
                    }}
                  >
                    <FolderOpen aria-hidden="true" />
                    {t("settings.skills.chooseFolder")}
                  </Button>
                ) : null}
                <Button type="submit" disabled={reviewing || path.trim() === ""}>
                  {reviewing ? t("settings.shortcut.checking") : t("settings.skills.review")}
                </Button>
              </div>
              {pickError ? <ErrorNotice what={pickError} /> : null}
            </form>
          </Group>
        ) : null}
        {review === undefined ? (suggestions ?? null) : null}
        <Group title={t("settings.skills.installed")}>
          {installed.length === 0 ? (
            <EmptyNotice text={t("settings.skills.noInstalled")} />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {installed.map((s) => (
                <SkillRow key={`${s.source}:${s.name}`} skill={s} {...rowProps} />
              ))}
            </ul>
          )}
        </Group>
        <Group title={t("settings.skills.trust.bundled")}>
          {bundled.length === 0 ? (
            <EmptyNotice text={t("settings.skills.noBundled")} />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {bundled.map((s) => (
                <SkillRow key={`${s.source}:${s.name}`} skill={s} {...rowProps} />
              ))}
            </ul>
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

// --- Connected -------------------------------------------------------------------------------

/** The `skill_install` card under the trust card; installs once it is approved. */
export function TrustApproval({
  approvalId,
  onDecided,
  now,
}: {
  approvalId: string;
  onDecided: (status: "approved" | "denied" | "expired" | "invalidated") => void;
  now?: number;
}): ReactElement {
  const store = useStore();
  const persona = usePersona();
  const { approval, canAnswer } = useApproval(approvalId);
  const reported = useRef(false);
  const status = approval?.status;
  useEffect(() => {
    if (status === undefined || status === "pending" || reported.current) return;
    reported.current = true;
    onDecided(status);
  }, [status, onDecided]);
  if (approval === null) {
    return (
      <p role="status" className="text-muted-foreground">
        {t("settings.approval.loading")}
      </p>
    );
  }
  return (
    <ApprovalCard
      approval={approval}
      canAnswer={canAnswer}
      persona={persona.name}
      otherSurfaces={approval.surfaces.filter((s) => s !== "desktop" && s !== "web")}
      onAnswer={(decision, scope) => answerApproval(store, approval.id, decision, scope)}
      {...(now === undefined ? {} : { now })}
    />
  );
}

type SkillAction =
  | "review"
  | "reviewProposed"
  | "install"
  | "dismiss"
  | "on"
  | "off"
  | "remove"
  | "reviewUpdate"
  | "checkUpdates";

function refusal(action: SkillAction, err: unknown): string {
  if (hasCode(err, "policy_denied")) {
    const details = (err as { details?: { violations?: unknown; problems?: unknown } }).details;
    const strings = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string").map((x) => show(x))
        : [];
    const problems = strings(details?.problems);
    if (problems.length > 0)
      return t("settings.skills.err.noReplay", { problems: problems.join("; ") });
    const list = strings(details?.violations);
    return list.length > 0
      ? t("settings.skills.err.violations", {
          violations: list.join(t("settings.skills.err.violationJoin")),
        })
      : t("settings.skills.err.wont", { action, reason: messageOf(err) });
  }
  if (hasCode(err, "forbidden")) return t("settings.skills.err.forbidden", { action });
  return t("settings.skills.err.failed", { action, reason: messageOf(err) });
}

export function SkillsSection({
  onPickFolder,
  now,
}: {
  onPickFolder?: () => Promise<string | null>;
  /** Fixed clock (stories, tests). */
  now?: number;
}): ReactElement {
  const call = useCall();
  const q = useGatewayQuery("skills.list", {});
  const draftsQ = useGatewayQuery("skills.drafts.list", { status: "open" });
  const persona = usePersona().name;
  const [review, setReview] = useState<{ proposal: SkillProposal; approvalId: string } | null>(
    null,
  );
  const [reviewing, setReviewing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const stage = (
    action: SkillAction,
    p: Promise<{ proposal: SkillProposal; approval: { id: string } }>,
  ) => {
    setActionError(null);
    setNotice(null);
    setReviewing(true);
    p.then(
      (r) => setReview({ proposal: r.proposal, approvalId: r.approval.id }),
      (err: unknown) => setActionError(refusal(action, err)),
    ).finally(() => setReviewing(false));
  };
  const run = (action: SkillAction, p: Promise<unknown>, done?: string) => {
    setActionError(null);
    setNotice(null);
    p.then(
      () => {
        q.reload();
        draftsQ.reload();
        if (done) setNotice(done);
      },
      (err: unknown) => setActionError(refusal(action, err)),
    );
  };

  const decided = (status: "approved" | "denied" | "expired" | "invalidated") => {
    const current = review;
    if (current === null) return;
    if (status !== "approved") {
      setReview(null);
      setNotice(
        status === "denied"
          ? t("settings.skills.denied", { name: show(current.proposal.name, 64) })
          : t("settings.skills.lapsed", { expired: status === "expired" }),
      );
      return;
    }
    setReview(null);
    run(
      "install",
      call("skills.install", { proposalId: current.proposal.id, approvalId: current.approvalId }),
      t("settings.skills.installedNamed", { name: show(current.proposal.name, 64) }),
    );
  };

  return (
    <SkillsPanel
      skills={q.data?.skills ?? []}
      loading={q.loading && q.data === undefined}
      error={q.error}
      onRetry={q.reload}
      reviewing={reviewing}
      checking={checking}
      actionError={actionError}
      notice={notice}
      {...(review === null
        ? {}
        : {
            review: (
              <SkillTrustCard proposal={review.proposal} onCancel={() => setReview(null)}>
                <TrustApproval
                  key={review.approvalId}
                  approvalId={review.approvalId}
                  onDecided={decided}
                  {...(now === undefined ? {} : { now })}
                />
              </SkillTrustCard>
            ),
          })}
      onReview={(source) => stage("review", call("skills.proposeInstall", { source }))}
      suggestions={
        <SkillSuggestions
          drafts={draftsQ.data?.drafts ?? []}
          persona={persona}
          busy={reviewing}
          onSave={(d, text) =>
            call("skills.drafts.update", { draftId: d.id, text }).then(() => draftsQ.reload())
          }
          onAccept={(d) =>
            stage(
              "reviewProposed",
              call("skills.drafts.accept", { draftId: d.id }).finally(() => draftsQ.reload()),
            )
          }
          onDismiss={(d) =>
            run(
              "dismiss",
              call("skills.drafts.dismiss", { draftId: d.id }),
              t("settings.skills.dismissed", { name: show(d.name, 64), persona }),
            )
          }
        />
      }
      {...(onPickFolder ? { onPickFolder } : {})}
      onToggle={(s, enabled) =>
        run(
          enabled ? "on" : "off",
          call("skills.setEnabled", { name: s.name, enabled, source: s.source }),
        )
      }
      onRemove={(s) =>
        run(
          "remove",
          call("skills.remove", { name: s.name }),
          t("settings.skills.removed", { name: show(s.name, 64) }),
        )
      }
      onReviewUpdate={(s) => stage("reviewUpdate", call("skills.proposeUpdate", { name: s.name }))}
      onCheckUpdates={() => {
        setChecking(true);
        setActionError(null);
        call("skills.checkUpdates", {})
          .then(
            (r) => {
              q.reload();
              const n = r.updates.filter((u) => u.updateAvailable).length;
              setNotice(t("settings.skills.updates", { n }));
            },
            (err: unknown) => setActionError(refusal("checkUpdates", err)),
          )
          .finally(() => setChecking(false));
      }}
    />
  );
}
