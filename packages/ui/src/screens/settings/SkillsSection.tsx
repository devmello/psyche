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
import { plural } from "../../lib/format.ts";
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

/** Plain words for the approval kinds a skill may declare. */
const PERMISSION_LABEL: Record<string, string> = {
  exec: "Run commands in the sandbox",
  exec_host: "Run commands on this Mac",
  send_email: "Send email",
  calendar_write: "Change your calendar",
  message_send: "Send messages",
  browser_submit: "Submit web forms",
  credential_fill: "Fill saved passwords",
  purchase: "Pay for things",
  file_write: "Write files",
  connector_action: "Act in connected apps",
  computer_action: "Use apps on this Mac",
  new_origin: "Open new sites",
  mcp_tool: "Use MCP tools",
  apple_script: "Run AppleScript",
  shortcut_run: "Run Shortcuts",
};

const STATUS: Record<SkillDetails["status"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  disabled: { label: "Off", tone: "neutral" },
  draft: { label: "Not approved", tone: "approval" },
  unlocked: { label: "Not installed by Psyche", tone: "approval" },
  hash_mismatch: { label: "Changed since approval", tone: "danger" },
  invalid: { label: "Invalid", tone: "danger" },
  blocked: { label: "Blocked", tone: "danger" },
  ineligible: { label: "Unavailable here", tone: "neutral" },
  shadowed: { label: "Overridden", tone: "neutral" },
};

const TRUST_LABEL: Record<SkillDetails["trust"], string> = {
  bundled: "Bundled with Psyche",
  verified: "Verified publisher",
  local: "Your own",
  unknown: "Unknown publisher",
};

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
  if (m === undefined) return "Unknown: the skill could not be read.";
  const perms = m.permissions.map((p) => PERMISSION_LABEL[p] ?? p);
  if (perms.length === 0 && m.tools.length === 0) return "Nothing beyond its instructions.";
  return [
    perms.length > 0 ? perms.join(", ") : null,
    m.tools.length > 0 ? plural(m.tools.length, "tool") : null,
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
const SEVERITY_LABEL: Record<string, string> = { high: "High", warn: "Warning", info: "Note" };

export function SkillTrustCard({
  proposal,
  children,
  onCancel,
}: SkillTrustCardProps): ReactElement {
  const id = useId();
  const persona = usePersona().name;
  const m = proposal.manifest ?? { tools: [], permissions: [], prompts: [] };
  const high = proposal.findings.filter((f) => f.severity === "high");
  const verb = proposal.update === undefined ? "installing" : "updating";
  return (
    <section
      aria-labelledby={id}
      data-testid="skill-trust-card"
      className="flex flex-col gap-4 rounded-lg border border-approval-border bg-gray-2 p-4 text-sm"
    >
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 id={id} className="text-h3 text-foreground">
            Review “{show(proposal.name, 64)}” before {verb}
          </h3>
          <p className="mt-0.5 text-small text-muted-foreground">
            A skill is instructions {persona} will follow. It never gets permissions by itself: each
            action it leads to still asks you.
          </p>
        </div>
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </header>

      <Facts
        items={[
          { term: "Source", value: <code>{show(sourceText(proposal.source), 2048)}</code> },
          { term: "Publisher", value: TRUST_LABEL[proposal.trust] },
        ]}
      />

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Details</summary>
        <Facts
          className="mt-2"
          items={[
            ...(proposal.commit === undefined
              ? []
              : [{ term: "Commit", value: <code>{show(proposal.commit, 80)}</code> }]),
            { term: "Content hash", value: <code className="break-all">{proposal.hash}</code> },
            ...(m.tools.length === 0
              ? []
              : [
                  {
                    term: "Tool names",
                    value: <code>{m.tools.map((t) => show(t, 80)).join(", ")}</code>,
                  },
                ]),
          ]}
        />
      </details>

      <section className="flex flex-col gap-2" aria-labelledby={`${id}-asks`}>
        <h4 id={`${id}-asks`} className="font-medium">
          What it asks for
        </h4>
        <Facts
          items={[
            {
              term: "Permissions",
              value:
                m.permissions.length === 0 ? (
                  "None"
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {m.permissions.map((p) => (
                      <li key={p}>
                        <StatusChip tone={p === "exec" || p === "purchase" ? "danger" : "approval"}>
                          {PERMISSION_LABEL[p] ?? p}
                        </StatusChip>
                      </li>
                    ))}
                  </ul>
                ),
            },
            {
              term: "Tools",
              value: m.tools.length === 0 ? "None" : plural(m.tools.length, "tool"),
            },
            {
              term: "Prompt files",
              value:
                m.prompts.length === 0 ? (
                  "None"
                ) : (
                  <code>{m.prompts.map((t) => show(t, 200)).join(", ")}</code>
                ),
            },
          ]}
        />
      </section>

      {proposal.findings.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium">Scan findings</h4>
          {high.length > 0 ? (
            <p role="alert" className="flex items-start gap-2 text-danger-text">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {high.length === 1
                ? "A high-severity finding"
                : `${high.length} high-severity findings`}
              : if you install it anyway, it stays off and cannot be turned on.
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
                  {SEVERITY_LABEL[f.severity] ?? f.severity}
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
        <p className="text-muted-foreground">The static scan found nothing to flag.</p>
      )}

      {proposal.update !== undefined ? (
        <details>
          <summary className="cursor-pointer font-medium">
            Changes since the approved version
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-gray-3 p-3 text-xs whitespace-pre-wrap">
            {proposal.update.diff === "" ? "No changes." : sanitizeBlock(proposal.update.diff)}
          </pre>
        </details>
      ) : null}

      <details open>
        <summary className="cursor-pointer font-medium">SKILL.md (full text)</summary>
        <pre
          className="mt-2 max-h-72 overflow-auto rounded-md bg-gray-3 p-3 text-xs whitespace-pre-wrap"
          data-testid="skill-text"
        >
          {sanitizeBlock(proposal.text)}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer font-medium">
          Every file ({proposal.files.length})
        </summary>
        <ul className="mt-2 flex flex-col gap-2">
          {proposal.files.map((f) => (
            <li key={f.path}>
              <p>
                <code>{show(f.path, 300)}</code>{" "}
                <span className="text-xs text-muted-foreground">
                  {f.bytes} bytes{f.executable ? " · executable" : ""}
                  {f.text === undefined ? " · binary" : ""}
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
  const status = STATUS[skill.status];
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
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
        {skill.update?.updateAvailable ? (
          <StatusChip tone={skill.update.manifestChanged ? "approval" : "info"}>
            Update available{skill.update.manifestChanged ? " · asks for different things" : ""}
          </StatusChip>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {TRUST_LABEL[skill.trust]}
          {skill.version === undefined ? "" : ` · v${show(skill.version, 32)}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {skill.update?.updateAvailable && onReviewUpdate ? (
            <Button type="button" variant="outline" size="xs" onClick={() => onReviewUpdate(skill)}>
              Review update
            </Button>
          ) : null}
          {onRemove && skill.source !== "bundled" ? (
            <RowMoreMenu
              name={name}
              destructive={[
                {
                  label: "Remove",
                  title: `Remove ${name}?`,
                  description:
                    "Its files are deleted from this Gateway. Installing it again goes through the trust card.",
                  confirm: "Remove",
                  onConfirm: () => onRemove(skill),
                },
              ]}
            />
          ) : null}
          {onToggle && toggleable ? (
            <Switch
              aria-label={`${name} on`}
              checked={skill.userEnabled}
              onCheckedChange={(v) => onToggle(skill, v)}
            />
          ) : null}
        </div>
      </div>
      <p className="text-muted-foreground">{show(skill.description, 400)}</p>
      <p className="text-xs">
        <span className="text-muted-foreground">Asks for: </span>
        {asksFor(skill.manifest)}
      </p>
      {skill.manifest && skill.manifest.tools.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1">
            Tools: <code>{skill.manifest.tools.map((t) => show(t, 80)).join(", ")}</code>
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
      title="Skills"
      description={`Instructions ${persona} can follow for a kind of task. Skills never grant permissions.`}
      actions={
        onCheckUpdates ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={onCheckUpdates}
          >
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        ) : null
      }
    >
      <LoadGate
        label="skills"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {actionError ? (
          <ErrorNotice what={actionError} did="Nothing was installed or changed." />
        ) : null}
        {notice ? (
          <p role="status" className="rounded-md bg-gray-3 px-3 py-2 text-sm">
            {notice}
          </p>
        ) : null}
        {review ?? null}
        {onReview && review === undefined ? (
          <Group
            title="Install a skill"
            description="Psyche shows everything in the skill and what it asks for, then asks you before installing."
          >
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Label htmlFor={inputId}>Skill folder or .zip on the Gateway</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={inputId}
                  value={path}
                  placeholder="/Users/you/Downloads/pdf-merge"
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
                          setPickError(
                            `Psyche couldn't open the folder chooser (${messageOf(err)}).`,
                          ),
                      );
                    }}
                  >
                    <FolderOpen aria-hidden="true" />
                    Choose folder…
                  </Button>
                ) : null}
                <Button type="submit" disabled={reviewing || path.trim() === ""}>
                  {reviewing ? "Checking…" : "Review"}
                </Button>
              </div>
              {pickError ? <ErrorNotice what={pickError} /> : null}
            </form>
          </Group>
        ) : null}
        {review === undefined ? (suggestions ?? null) : null}
        <Group title="Installed">
          {installed.length === 0 ? (
            <EmptyNotice text="No skills installed yet. Bundled skills are below." />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {installed.map((s) => (
                <SkillRow key={`${s.source}:${s.name}`} skill={s} {...rowProps} />
              ))}
            </ul>
          )}
        </Group>
        <Group title="Bundled with Psyche">
          {bundled.length === 0 ? (
            <EmptyNotice text="No bundled skills on this Gateway." />
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
function TrustApproval({
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
        Loading the approval…
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

function refusal(what: string, err: unknown): string {
  if (hasCode(err, "policy_denied")) {
    const details = (err as { details?: { violations?: unknown; problems?: unknown } }).details;
    const strings = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string").map((x) => show(x))
        : [];
    const problems = strings(details?.problems);
    if (problems.length > 0)
      return `Psyche won't install this suggestion; it does not replay: ${problems.join("; ")}.`;
    const list = strings(details?.violations);
    return list.length > 0
      ? `Psyche won't install this skill: it ${list.join("; it ")}.`
      : `Psyche won't ${what.toLowerCase()} (${messageOf(err)}).`;
  }
  if (hasCode(err, "forbidden")) return `${what} needs a device paired as admin.`;
  return `Psyche couldn't ${what.toLowerCase()} (${messageOf(err)}).`;
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
    what: string,
    p: Promise<{ proposal: SkillProposal; approval: { id: string } }>,
  ) => {
    setActionError(null);
    setNotice(null);
    setReviewing(true);
    p.then(
      (r) => setReview({ proposal: r.proposal, approvalId: r.approval.id }),
      (err: unknown) => setActionError(refusal(what, err)),
    ).finally(() => setReviewing(false));
  };
  const run = (what: string, p: Promise<unknown>, done?: string) => {
    setActionError(null);
    setNotice(null);
    p.then(
      () => {
        q.reload();
        draftsQ.reload();
        if (done) setNotice(done);
      },
      (err: unknown) => setActionError(refusal(what, err)),
    );
  };

  const decided = (status: "approved" | "denied" | "expired" | "invalidated") => {
    const current = review;
    if (current === null) return;
    if (status !== "approved") {
      setReview(null);
      setNotice(
        status === "denied"
          ? `Not installed: you denied “${show(current.proposal.name, 64)}”.`
          : `Not installed: the approval ${status === "expired" ? "expired" : "was withdrawn"}. Review it again to ask for a new one.`,
      );
      return;
    }
    setReview(null);
    run(
      "Install the skill",
      call("skills.install", { proposalId: current.proposal.id, approvalId: current.approvalId }),
      `Installed “${show(current.proposal.name, 64)}”.`,
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
      onReview={(source) => stage("Review the skill", call("skills.proposeInstall", { source }))}
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
              "Review the proposed skill",
              call("skills.drafts.accept", { draftId: d.id }).finally(() => draftsQ.reload()),
            )
          }
          onDismiss={(d) =>
            run(
              "Dismiss the suggestion",
              call("skills.drafts.dismiss", { draftId: d.id }),
              `Dismissed “${show(d.name, 64)}”. ${persona} won't suggest that routine again.`,
            )
          }
        />
      }
      {...(onPickFolder ? { onPickFolder } : {})}
      onToggle={(s, enabled) =>
        run(
          enabled ? "Turn the skill on" : "Turn the skill off",
          call("skills.setEnabled", { name: s.name, enabled, source: s.source }),
        )
      }
      onRemove={(s) =>
        run(
          "Remove the skill",
          call("skills.remove", { name: s.name }),
          `Removed “${show(s.name, 64)}”.`,
        )
      }
      onReviewUpdate={(s) =>
        stage("Review the update", call("skills.proposeUpdate", { name: s.name }))
      }
      onCheckUpdates={() => {
        setChecking(true);
        setActionError(null);
        call("skills.checkUpdates", {})
          .then(
            (r) => {
              q.reload();
              const n = r.updates.filter((u) => u.updateAvailable).length;
              setNotice(
                n === 0
                  ? "Every installed skill is up to date."
                  : `${n} update${n === 1 ? "" : "s"} available.`,
              );
            },
            (err: unknown) => setActionError(refusal("Check for updates", err)),
          )
          .finally(() => setChecking(false));
      }}
    />
  );
}
