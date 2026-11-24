import {
  bindingFor,
  type Requester,
  type SkillInstallBindingArgs,
  type TaintSource,
} from "@psyche/permissions";
import {
  type ApprovalRequest,
  type Clock,
  type CustomConnectorAuth,
  type CustomConnectorManifest,
  type CustomConnectorProposal,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
import type { ConnectorRegistry } from "../framework/registry.ts";
import type { ActionRule, ConnectorRecord, ScopeMode } from "../framework/types.ts";
import { customActions } from "./connector.ts";
import {
  checkManifest,
  lineDiff,
  type ManifestFinding,
  manifestHash,
  manifestText,
} from "./manifest.ts";
import { manifestFromOpenApi } from "./openapi.ts";

/**
 * Proposing and installing custom connectors (feature M9; security §11). A manifest (written by
 * the owner, drafted by the agent, or derived from OpenAPI) is validated and scanned, staged, and
 * shown on the device-only `skill_install` trust card with `details.kind: "connector"`; only an
 * approved card installs it, bound to the exact manifest hash. Nothing is ever auto-enabled.
 */

export const CUSTOM_PROPOSAL_TTL_MS = 30 * 60_000;

export interface ProposeCustomInput {
  manifest?: unknown;
  openapi?: { document: string; id: string; operations?: string[]; auth?: CustomConnectorAuth };
  scopeMode?: ScopeMode;
  /** Who drafted it; the agent's drafts say so on the card. Default `owner`. */
  drafted?: "owner" | "agent";
}

/**
 * Who asked for a proposal, from the tool run that drafted it. Absent for an owner's own proposal:
 * that card is untainted, with no requester, and is not marked as drafted.
 */
export interface ProposeRun {
  requestedBy: {
    runId: string | null;
    taskId: string | null;
    threadId: string | null;
    toolCallId?: string;
  };
  /** The run has read untrusted content: the card is tainted and offers only "once". */
  taint: boolean;
  taintSources?: TaintSource[];
  requester?: Requester;
}

export interface CustomConnectorServiceOptions {
  registry: ConnectorRegistry;
  broker: PermissionBroker;
  clock: Clock;
  /** Approval card surfaces; chat surfaces are dropped (device-only). */
  surfaces?: string[];
  newId?: () => string;
}

interface Staged {
  proposal: CustomConnectorProposal;
  existingId: string | undefined;
  /** The `skill_install` card this proposal opened; its approval installs it (`installApproved`). */
  approvalId: string;
}

/** The `skill_install` binding the broker itself computes (no drift between card and install). */
export function customConnectorBinding(m: CustomConnectorManifest, hash: string) {
  const permissions = new Set<string>();
  if (m.tools.some((t) => t.sideEffect !== "read")) permissions.add("connector_action");
  if (m.auth.kind !== "none") permissions.add("credential_fill");
  const args: SkillInstallBindingArgs = {
    name: `connector:${m.id}`,
    scope: "home",
    source: { kind: "path", path: `connectors/${m.id}.json` },
    treeHash: hash,
    tools: m.tools.map((t) => t.name),
    permissions: [...permissions],
    prompts: [],
  };
  const b = bindingFor("skill_install", args);
  return { bindingHash: b.bindingHash, grantKey: b.grantKey };
}

export class CustomConnectors {
  readonly #o: CustomConnectorServiceOptions;
  readonly #staged = new Map<string, Staged>();
  #seq = 0;
  /** Proposals whose install is running: a second install of the same one is refused. */
  readonly #installing = new Set<string>();

  constructor(options: CustomConnectorServiceOptions) {
    this.#o = options;
  }

  async #existing(id: string): Promise<ConnectorRecord | undefined> {
    return (await this.#o.registry.list()).find(
      (r) =>
        r.type === "custom" && (r.config as { manifest?: { id?: unknown } }).manifest?.id === id,
    );
  }

  async propose(
    input: ProposeCustomInput,
    run?: ProposeRun,
  ): Promise<{ proposal: CustomConnectorProposal; approval: ApprovalRequest }> {
    const findings: ManifestFinding[] = [];
    let raw: unknown = input.manifest;
    if (input.openapi !== undefined) {
      if (input.manifest !== undefined)
        throw new PsycheError("invalid_params", "give a manifest or an OpenAPI document, not both");
      const draft = manifestFromOpenApi(input.openapi);
      raw = draft.manifest;
      findings.push(...draft.findings);
    }
    if (raw === undefined)
      throw new PsycheError("invalid_params", "a manifest or an OpenAPI document is required");
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const r = raw as { source?: Record<string, unknown> };
      raw = {
        ...r,
        source: { kind: "declarative", ...(r.source ?? {}), drafted: input.drafted ?? "owner" },
      };
    }
    const check = checkManifest(raw);
    if (check.manifest === undefined) {
      throw new PsycheError(
        "invalid_params",
        `the connector manifest is not acceptable: ${check.violations.slice(0, 3).join("; ")}`,
        {
          details: { violations: check.violations },
        },
      );
    }
    const m = check.manifest;
    findings.push(...check.findings);
    const hash = manifestHash(m);
    const text = manifestText(m);
    const existing = await this.#existing(m.id);
    const { bindingHash, grantKey } = customConnectorBinding(m, hash);
    const now = this.#o.clock.now();
    const id = this.#o.newId?.() ?? `ccp_${now.toString(36)}${++this.#seq}`;
    const proposal: CustomConnectorProposal = {
      id,
      kind: "connector",
      approvalKind: "skill_install",
      manifest: m,
      text,
      hash,
      findings,
      scopeMode: input.scopeMode ?? "read_act",
      bindingHash,
      grantKey,
      expiresAt: now + CUSTOM_PROPOSAL_TTL_MS,
    };
    if (existing !== undefined) {
      const prev = (existing.config as { manifest: CustomConnectorManifest }).manifest;
      proposal.update = { fromHash: manifestHash(prev), diff: lineDiff(manifestText(prev), text) };
    }
    const high = findings.filter((f) => f.severity === "high").length;
    const drafted = input.drafted === "agent";
    const issued = await this.#o.broker.requestApproval({
      kind: "skill_install",
      summary: `${existing === undefined ? "Install" : "Update"} custom connector "${m.name}"${high > 0 ? ` (${high} high-severity findings: its tools will be off)` : ""}${drafted ? " (drafted by the agent)" : ""}`,
      details: {
        kind: "connector",
        name: m.name,
        id: m.id,
        ...(drafted ? { drafted: "agent" } : {}),
        hash,
        baseUrl: m.baseUrl,
        hosts: m.hosts,
        auth: m.auth.kind === "none" ? "none" : `${m.auth.kind} ${m.auth.credential}`,
        // What the connector can do: every request it may send, listed first on the card.
        tools: m.tools.map((t) => `${t.sideEffect} ${t.method} ${t.path} (${t.name})`),
        permissions: [
          ...(m.tools.some((t) => t.sideEffect !== "read") ? ["connector_action"] : []),
          ...(m.auth.kind === "none" ? [] : ["credential_fill"]),
        ],
        findings: { high, warn: findings.filter((f) => f.severity === "warn").length },
        scopeMode: proposal.scopeMode,
        ...(proposal.update === undefined ? {} : { fromHash: proposal.update.fromHash }),
      },
      bindingHash,
      grantKey,
      requestedBy: run?.requestedBy ?? { runId: null, taskId: null, threadId: null },
      sideEffect: "destructive",
      surfaces: (this.#o.surfaces ?? ["desktop"]).filter((x) => !x.includes(":")),
      scopesOffered: ["once"],
      taint: run?.taint ?? false,
      ...(run?.taintSources === undefined ? {} : { taintSources: run.taintSources }),
      ...(run?.requester === undefined ? {} : { context: { requester: run.requester } }),
    });
    this.#staged.set(id, { proposal, existingId: existing?.id, approvalId: issued.approval.id });
    return { proposal: structuredClone(proposal), approval: issued.approval };
  }

  getProposal(proposalId: string): CustomConnectorProposal {
    const s = this.#staged.get(proposalId);
    if (s === undefined) throw new PsycheError("not_found", "no such custom connector proposal");
    return structuredClone(s.proposal);
  }

  /**
   * Installs the proposal whose card was just approved (the broker's `approval.decided`). Only an
   * approved card of this service's own proposal counts; anything else installs nothing.
   */
  async installApproved(approval: ApprovalRequest): Promise<ConnectorRecord | undefined> {
    if (approval.status !== "approved") return undefined;
    for (const [proposalId, s] of this.#staged) {
      if (s.approvalId === approval.id) return this.install(proposalId, approval.id);
    }
    return undefined;
  }

  async install(proposalId: string, approvalId: string): Promise<ConnectorRecord> {
    const s = this.#staged.get(proposalId);
    if (s === undefined || this.#installing.has(proposalId))
      throw new PsycheError("not_found", "no such custom connector proposal");
    this.#installing.add(proposalId);
    try {
      return await this.#install(proposalId, approvalId, s);
    } finally {
      this.#installing.delete(proposalId);
    }
  }

  async #install(proposalId: string, approvalId: string, s: Staged): Promise<ConnectorRecord> {
    const p = s.proposal;
    if (this.#o.clock.now() > p.expiresAt) {
      this.#staged.delete(proposalId);
      throw new PsycheError(
        "approval_expired",
        "the proposal expired; propose the connector again",
      );
    }
    // Only the card this proposal opened can install it: another approved card (even a real one
    // for another connector) installs nothing here.
    if (approvalId !== s.approvalId) {
      throw new PsycheError("approval_required", "that card is not this connector's trust card");
    }
    const approval = await this.#o.broker.get(approvalId);
    if (
      approval === undefined ||
      approval.kind !== "skill_install" ||
      (approval.details as { kind?: unknown }).kind !== "connector"
    ) {
      throw new PsycheError(
        "approval_required",
        "installing a custom connector needs its approved trust card",
      );
    }
    const v = await this.#o.broker.verifyBinding(approvalId, p.bindingHash);
    if (!v.ok) {
      throw new PsycheError(
        v.reason === "binding_mismatch" ? "binding_mismatch" : "approval_required",
        `trust card not usable: ${v.reason}`,
      );
    }
    this.#staged.delete(proposalId);
    const record = await this.#o.registry.connect({
      catalogueId: "custom",
      scopeMode: p.scopeMode,
      label: p.manifest.name,
      config: { manifest: p.manifest, hash: p.hash },
      ...(s.existingId === undefined ? {} : { connectorId: s.existingId }),
    });
    // Rules per tool: by tier, or off entirely when the scan found text aimed at the model.
    const off = p.findings.some((f) => f.severity === "high");
    const matrix: Record<string, ActionRule> = {};
    for (const a of customActions(p.manifest)) matrix[a.id] = off ? "deny" : a.defaultRule;
    const updated = await this.#o.registry.setMatrix(record.id, matrix);
    await this.#o.broker
      .recordReceipt({
        kind: "connector_install",
        outcome: "ok",
        summary: `Installed custom connector "${p.manifest.name}" (${p.hash.slice(0, 19)})${off ? ", tools off" : ""}`,
        approvalId,
        externalRefs: { connectorId: record.id, hash: p.hash },
      })
      .catch(() => undefined);
    return updated;
  }

  async remove(connectorId: string): Promise<void> {
    const record = await this.#o.registry.get(connectorId);
    if (record.type !== "custom")
      throw new PsycheError("invalid_params", "only custom connectors are removed this way");
    await this.#o.registry.remove(connectorId);
  }
}
