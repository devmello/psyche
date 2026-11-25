import type { ApprovalRequest, GrantScope } from "@psyche/protocol";
import { t } from "../i18n/core.ts";
import { parseSendGrantKey, splitRecipients } from "../lib/send-grant.ts";
import { floorClassOf } from "./LiftFloorDialog.tsx";

/**
 * What the Allow button and its second choice can send. `trust` / `trustSubdomains` are "Always
 * for this site" (and its subdomains): sent as `once` plus `trustSite`, only on a first-read card
 * that offers it (`details.trustSite`). `program` and `space` are likewise sent as `once` plus an
 * extra the Gateway understands.
 */
export type AllowScope =
  | Exclude<GrantScope, never>
  | "trust"
  | "trustSubdomains"
  | "program"
  | "space";

export interface Choice {
  value: AllowScope;
  /** What the choice covers, in plain words. It is the label of the button that sends `value`. */
  label: string;
}

/** The origin a first-read card offers to trust, as the Gateway computed it. */
export function trustSiteOffer(
  approval: ApprovalRequest,
): { origin: string; display: string; subdomains: boolean } | null {
  const o = (approval.details as Record<string, unknown>).trustSite;
  if (typeof o !== "object" || o === null) return null;
  const { origin, subdomains } = o as { origin?: unknown; subdomains?: unknown };
  if (typeof origin !== "string" || !approval.scopesOffered.includes("once")) return null;
  return { origin, display: origin.replace(/^https:\/\//, ""), subdomains: subdomains === true };
}

/**
 * "Always allow <program> in <folder>" on a host-command card, as the Gateway computed it
 * (`details.hostProgram`): sent as `once` plus `hostProgram`. `exact` when it covers only the
 * argv shown (a program that can run other code), else any arguments of a read-only tool.
 */
export function hostProgramOffer(
  approval: ApprovalRequest,
): { program: string; folder: string; exact: boolean } | null {
  const o = (approval.details as Record<string, unknown>).hostProgram;
  if (typeof o !== "object" || o === null) return null;
  const { program, folder, argv } = o as { program?: unknown; folder?: unknown; argv?: unknown };
  if (typeof program !== "string" || typeof folder !== "string") return null;
  if (!approval.scopesOffered.includes("once")) return null;
  return { program, folder, exact: Array.isArray(argv) };
}

/**
 * "Allow in this Space" on a folder card, as the Gateway offered it (`details.space`): sent as
 * `once` plus `inSpace`. Never on a tainted card (spaces-2026 §5.3).
 */
export function spaceOffer(
  approval: ApprovalRequest,
): { name: string; automationsWrite: boolean } | null {
  if (approval.kind !== "folder_access" || approval.taint) return null;
  const o = (approval.details as Record<string, unknown>).space;
  if (typeof o !== "object" || o === null) return null;
  const { id, name, automationsWrite } = o as {
    id?: unknown;
    name?: unknown;
    automationsWrite?: unknown;
  };
  if (typeof id !== "string" || id === "" || !approval.scopesOffered.includes("once")) return null;
  return {
    name: typeof name === "string" ? name : "",
    automationsWrite: automationsWrite === true,
  };
}

/** "Notion › create page" for `mcp__notion__create_page`, "Gmail › send" for `gmail.send`. */
export function toolPhrase(tool: string): string {
  const words = (s: string) => s.replace(/[_-]+/g, " ").trim();
  const cap = (s: string) => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp?.[1] && mcp[2]) return `${cap(words(mcp[1]))} › ${words(mcp[2])}`;
  const dot = tool.indexOf(".");
  if (dot > 0 && dot < tool.length - 1) {
    return `${cap(words(tool.slice(0, dot)))} › ${words(tool.slice(dot + 1))}`;
  }
  return words(tool);
}

/** A payment (a purchase, or money moving): never an "always", whatever the card offers. */
export function isPaymentCard(approval: ApprovalRequest): boolean {
  return approval.kind === "purchase" || approval.sideEffect === "financial";
}

/** Kinds with their own binding table (`packages/permissions/src/binding.ts`), not {tool, target}. */
const DEDICATED_KINDS: readonly string[] = [
  "exec",
  "exec_host",
  "send_email",
  "calendar_write",
  "message_send",
  "browser_submit",
  "credential_fill",
  "purchase",
  "file_write",
  "mcp_tool",
  "connector_action",
  "computer_action",
  "new_origin",
  "skill_install",
];

const asText = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * The words for an "Always allow" on this card, from what its grant key really covers
 * (security §3.3, audit §1.3): the same exact command, the recipient set, the tool with any
 * arguments, or the same tool for the same target.
 */
export function alwaysLabel(approval: ApprovalRequest): string {
  const d = approval.details as Record<string, unknown>;
  if (approval.kind === "batch") return t("blocks.approval.scope.prepNotes");
  if (approval.kind === "send_email" && approval.target?.kind === "recipient") {
    const recipients = splitRecipients(approval.target.value);
    const account = parseSendGrantKey(approval.grantKey)?.account ?? null;
    if (recipients.length > 0) {
      return account !== null
        ? t("blocks.approval.alwaysRecipientFrom", { recipients: recipients.join(", "), account })
        : t("blocks.approval.alwaysRecipient", { recipients: recipients.join(", ") });
    }
  }
  const tool = asText(d.tool);
  const target = approval.target ? (approval.target.display ?? approval.target.value) : null;
  // MCP tools and connector actions: the grant is the tool, whatever its arguments.
  if ((approval.kind === "mcp_tool" || approval.kind === "connector_action") && tool !== null) {
    return t("approvals.choice.alwaysTool", { tool: toolPhrase(tool) });
  }
  // A host or sandbox command: the grant is bound to the exact argv, cwd and binary.
  if (approval.kind === "exec" || approval.kind === "exec_host") {
    return t("approvals.choice.alwaysExec");
  }
  if (approval.kind === "file_write" && target !== null) {
    return t("approvals.choice.alwaysWrite", { target });
  }
  // The generic grant key is {tool, target}; the kinds with their own binding say it less exactly.
  if (!DEDICATED_KINDS.includes(approval.kind) && tool !== null) {
    return target !== null
      ? t("approvals.choice.alwaysToolFor", { tool: toolPhrase(tool), target })
      : t("approvals.choice.alwaysTool", { tool: toolPhrase(tool) });
  }
  return t("approvals.choice.alwaysSame");
}

export interface ChoiceOptions {
  /** Origin the card is about, for "For this site (…)". */
  site: string | null;
  /** The owner typed UNSANDBOXED: this run only, so no lasting choice. */
  unsandboxed?: boolean;
  /** A folder card: its own words for Once and Always. */
  folderWords?: boolean;
  /** `separate_desktop_share`: once only, with its own words. */
  sdShare?: boolean;
  /** The label of the single choice of a `permission_request` card. */
  permissionLabel?: string;
  /** This window can approve once only (Touch ID from here), so a lasting label would be a lie. */
  onceOnly?: boolean;
}

/**
 * Every scope this card can send, as {scope, label}, in the order the old menu listed them. Only
 * scopes the card offers appear; a payment card offers nothing but `once` whatever it is sent.
 */
export function buildChoices(
  approval: ApprovalRequest,
  offered: readonly GrantScope[],
  opts: ChoiceOptions,
): Choice[] {
  const trust = approval.status === "pending" ? trustSiteOffer(approval) : null;
  const program = approval.status === "pending" ? hostProgramOffer(approval) : null;
  const space = approval.status === "pending" ? spaceOffer(approval) : null;
  const folderScope = (s: "once" | "always") =>
    opts.folderWords
      ? t(opts.sdShare ? "blocks.folder.sd.scope.once" : `blocks.folder.scope.${s}`)
      : null;
  const unsandboxed = opts.unsandboxed === true;
  const payment = isPaymentCard(approval);
  const list: Choice[] = [
    ...(offered.includes("once")
      ? [
          {
            value: "once" as const,
            label: opts.permissionLabel ?? folderScope("once") ?? t("blocks.approval.scope.once"),
          },
        ]
      : []),
    ...(offered.includes("task")
      ? [{ value: "task" as const, label: t("approvals.choice.task") }]
      : []),
    ...(offered.includes("site") && opts.site !== null
      ? [{ value: "site" as const, label: t("approvals.choice.site", { site: opts.site }) }]
      : []),
    ...(trust !== null
      ? [
          {
            value: "trust" as const,
            label: t("blocks.approval.scope.trustSite", { site: trust.display }),
          },
          ...(trust.subdomains
            ? [
                {
                  value: "trustSubdomains" as const,
                  label: t("blocks.approval.scope.trustSiteSubdomains", { site: trust.display }),
                },
              ]
            : []),
        ]
      : []),
    ...(program !== null && !unsandboxed
      ? [
          {
            value: "program" as const,
            label: t(
              program.exact
                ? "blocks.approval.scope.hostProgramExact"
                : "blocks.approval.scope.hostProgram",
              { program: program.program, folder: program.folder },
            ),
          },
        ]
      : []),
    ...(space !== null
      ? [
          {
            value: "space" as const,
            // Names the card's Space: the answer applies to that Space only.
            label:
              space.name === ""
                ? t("blocks.folder.scope.space")
                : t("blocks.folder.scope.spaceNamed", { space: space.name }),
          },
        ]
      : []),
    ...(offered.includes("session") && !unsandboxed
      ? [{ value: "session" as const, label: t("approvals.choice.session") }]
      : []),
    ...(offered.includes("always") && !unsandboxed
      ? [
          {
            value: "always" as const,
            label: folderScope("always") ?? alwaysLabel(approval),
          },
        ]
      : []),
  ];
  // A payment is once only. The Gateway never offers more; the card does not either.
  return payment || opts.onceOnly === true ? list.filter((c) => c.value === "once") : list;
}

/**
 * Which lasting scope sits next to Allow. The chat scope first (it ends with the chat), then the
 * narrowest "always" (a program in one folder, then the same action, then one site), then the
 * wider ones. The scope Allow itself sends is never repeated, and nothing is picked on a payment.
 */
const SECOND_ORDER: readonly AllowScope[] = [
  "session",
  "program",
  "always",
  "trust",
  "site",
  "space",
  "task",
  "trustSubdomains",
];

export function splitChoices(
  choices: readonly Choice[],
  allowValue: AllowScope,
  payment: boolean,
): { allow: Choice | null; second: Choice | null; more: Choice[] } {
  const allow = choices.find((c) => c.value === allowValue) ?? null;
  if (payment) return { allow, second: null, more: [] };
  const rest = choices.filter((c) => c.value !== allowValue);
  const second =
    SECOND_ORDER.map((v) => rest.find((c) => c.value === v)).find((c) => c !== undefined) ?? null;
  return { allow, second, more: rest.filter((c) => c !== second) };
}

/** The narrowest scope the card offers: what plain Allow sends. */
export function defaultAllow(approval: ApprovalRequest): AllowScope {
  return (
    (["once", "task", "site", "session", "always"] as const).find((v) =>
      approval.scopesOffered.includes(v),
    ) ?? "once"
  );
}

/**
 * The choices an Inbox or Home row can send without opening the card: the same ones the card
 * offers, minus an "always" that lifts a floor (a send, a delete: the card confirms that first) and
 * minus any lasting choice on a tainted card, which offers Allow once only.
 */
export function inlineChoices(approval: ApprovalRequest): {
  allow: Choice | null;
  second: Choice | null;
  more: Choice[];
  all: Choice[];
} {
  const floor = floorClassOf(approval.kind, approval.sideEffect);
  const offered =
    floor !== null && approval.taint
      ? approval.scopesOffered.filter((s) => s === "once")
      : approval.scopesOffered.filter((s) => !(floor !== null && s === "always"));
  const site = (() => {
    if (approval.target?.kind === "origin") return approval.target.display ?? approval.target.value;
    const d = approval.details as Record<string, unknown>;
    const o = d.origin ?? d.currentOrigin;
    return typeof o === "string" ? o.replace(/^https?:\/\//, "") : null;
  })();
  const choices = buildChoices(approval, offered, { site });
  const parts = splitChoices(choices, defaultAllow(approval), isPaymentCard(approval));
  return {
    ...parts,
    all: [...(parts.second ? [parts.second] : []), ...parts.more],
  };
}

/** The scope and extras a choice sends. */
export function answerFor(value: AllowScope): {
  scope: GrantScope;
  extras?: { trustSite: "origin" | "subdomains" } | { hostProgram: true };
} {
  switch (value) {
    case "trust":
      return { scope: "once", extras: { trustSite: "origin" } };
    case "trustSubdomains":
      return { scope: "once", extras: { trustSite: "subdomains" } };
    case "program":
      return { scope: "once", extras: { hostProgram: true } };
    case "space":
      return { scope: "once" };
    default:
      return { scope: value };
  }
}
