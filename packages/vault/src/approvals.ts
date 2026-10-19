import type {
  ApprovalRequestInput,
  CredentialExecutor,
  CredentialField,
  CredentialMeta,
  FillElement,
  Surface,
} from "@psyche/protocol";
import {
  type CredentialFillBindingInput,
  canonicalHost,
  canonicalOrigin,
  credentialFillBindingHash,
  credentialFillGrantKey,
  fieldClass,
} from "./binding.ts";

export interface CredentialFillRequest {
  credential: CredentialMeta;
  /** The target as the executor will see it (origin, or API host for connectors). */
  target: string;
  executor: CredentialExecutor;
  field?: CredentialField;
  selector?: string;
  element?: FillElement;
  requestedBy: ApprovalRequestInput["requestedBy"];
  /** Untrusted content was read in this turn (security §3.6). */
  taint: boolean;
  /** Default: desktop card plus an OS notification (which must authenticate). */
  surfaces?: Surface[];
  /** Offer the opt-in `site` grant next to `once`. Default true for browser logins. */
  offerSite?: boolean;
}

/** The binding input the vault recomputes at resolve time; requester and vault share it. */
export function fillBindingInput(req: {
  credential: CredentialMeta;
  target: string;
  executor: CredentialExecutor;
  field?: CredentialField;
  selector?: string;
  element?: FillElement;
}): CredentialFillBindingInput {
  const target =
    req.executor === "browser"
      ? (canonicalOrigin(req.target) ?? req.target)
      : (canonicalOrigin(req.target) ?? canonicalHost(req.target) ?? req.target);
  const input: CredentialFillBindingInput = {
    itemId: req.credential.id,
    target,
    field: req.field ?? "secret",
    executor: req.executor,
  };
  if (req.selector !== undefined) input.selector = req.selector;
  if (req.element !== undefined) input.element = req.element;
  return input;
}

/**
 * The `credential_fill` ApprovalRequest for one fill (architecture §4.7, feature G7): item,
 * site, task and agent on the card; scope `once` by default with an opt-in `site` grant whose
 * key includes the field class (S23 design-01); device-only, and the OS notification must
 * require authentication (the broker sets `requiresAuthentication` for this kind; the flag is
 * repeated in `details` for surfaces that read it there).
 */
export function credentialFillApproval(req: CredentialFillRequest): ApprovalRequestInput {
  const binding = fillBindingInput(req);
  const field = fieldClass(binding.field, req.credential.kind);
  const site = binding.target;
  const offerSite =
    req.offerSite ?? (req.executor === "browser" && req.credential.kind === "login");
  return {
    kind: "credential_fill",
    summary: `Fill ${field} of “${req.credential.name}” on ${site}`,
    details: {
      item: req.credential.name,
      slug: req.credential.slug,
      credentialId: req.credential.id,
      kind: req.credential.kind,
      field,
      site,
      executor: req.executor,
      ...(req.selector === undefined ? {} : { selector: req.selector }),
      ...(req.element === undefined
        ? {}
        : { element: { tagName: req.element.tagName, type: req.element.type ?? "" } }),
      task: req.requestedBy.taskId,
      agent: req.requestedBy.agent ?? null,
      requiresAuthentication: true,
    },
    bindingHash: credentialFillBindingHash(binding),
    grantKey: credentialFillGrantKey(binding, req.credential.kind),
    requestedBy: req.requestedBy,
    sideEffect: "write",
    targetKind: "origin",
    target: { kind: "origin", value: site },
    surfaces: req.surfaces ?? ["desktop", "notification"],
    scopesOffered: offerSite ? ["once", "site"] : ["once"],
    taint: req.taint,
  };
}
