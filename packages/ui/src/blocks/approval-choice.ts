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
  /**
   * The card's data could not say what this grant covers, so the label is the honest wide
   * reading. A vague choice is never the second choice; it stays under More options.
   */
  vague?: boolean;
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

/**
 * A payment, or a card that needs presence: never a lasting choice, whatever the card offers.
 * Presence is for payments only, so a card that asks for it is treated like one.
 */
export function isPaymentCard(approval: ApprovalRequest): boolean {
  return (
    approval.kind === "purchase" ||
    approval.sideEffect === "financial" ||
    approval.requiresAuthentication
  );
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

const folderOf = (path: string): string => {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : path;
};

/**
 * What a lasting grant on this card covers, in words that follow "Allow": the recipient set, the
 * tool with any arguments, the exact command, the path, the app. Null when the card's own data
 * cannot say it, so no lifetime or "always" is ever worded without its reach. The reach is what
 * the grant key covers (`packages/permissions/src/binding.ts`), not what the call did.
 */
export function reachPhrase(approval: ApprovalRequest, site: string | null): string | null {
  const d = approval.details as Record<string, unknown>;
  const tool = asText(d.tool);
  const target = approval.target ? (approval.target.display ?? approval.target.value) : null;
  switch (approval.kind) {
    case "send_email": {
      if (approval.target?.kind !== "recipient") return null;
      const recipients = splitRecipients(approval.target.value);
      if (recipients.length === 0) return null;
      const account = parseSendGrantKey(approval.grantKey)?.account ?? null;
      return account !== null
        ? t("approvals.what.send", { recipients: recipients.join(", "), account })
        : t("approvals.what.sendAny", { recipients: recipients.join(", ") });
    }
    case "mcp_tool":
    case "connector_action":
      // The grant is the tool, whatever its arguments.
      return tool === null ? null : t("approvals.what.tool", { tool: toolPhrase(tool) });
    case "exec":
    case "exec_host":
      // Bound to the exact argv, cwd and binary.
      return t("approvals.what.exec");
    case "file_write": {
      // The grant is {root, operation}: any content, at that path or under that folder.
      if (target === null) return null;
      const root = asText(d.root);
      const operation = asText(d.operation);
      if (root !== null && root !== target) {
        return operation !== null
          ? t("approvals.what.writeIn", { operation, folder: root })
          : t("approvals.what.filesIn", { folder: root });
      }
      if (root !== null) return t("approvals.what.writeTarget", { target });
      // The card does not carry the grant root, which can be the folder: say the wider reading.
      return t("approvals.what.filesIn", { folder: folderOf(target) });
    }
    case "message_send": {
      const recipient = asText(d.recipient);
      const channel = asText(d.channel);
      return recipient !== null && channel !== null
        ? t("approvals.what.message", { recipient, channel })
        : null;
    }
    case "calendar_write": {
      const calendar = asText(d.calendar);
      const operation = asText(d.operation);
      return calendar !== null && operation !== null
        ? t("approvals.what.calendar", { calendar, operation })
        : null;
    }
    case "computer_action": {
      const app = asText(d.app);
      return app === null ? null : t("approvals.what.computer", { app });
    }
    case "new_origin":
      return site === null ? null : t("approvals.what.site", { site });
    case "credential_fill": {
      const item = asText(d.itemName);
      return item !== null && site !== null ? t("approvals.what.fill", { item, site }) : null;
    }
    default:
      // The generic grant key is {tool, target}.
      if (DEDICATED_KINDS.includes(approval.kind) || tool === null) return null;
      return target !== null
        ? t("approvals.what.toolFor", { tool: toolPhrase(tool), target })
        : t("approvals.what.tool", { tool: toolPhrase(tool) });
  }
}

type Lifetime = "always" | "session" | "task" | "site";

/** A lasting choice named by its lifetime and its reach; vague (and said so) without a reach. */
function lastingChoice(value: Lifetime, approval: ApprovalRequest, site: string | null): Choice {
  if (value === "always" && approval.kind === "batch") {
    return { value, label: t("blocks.approval.scope.prepNotes") };
  }
  const what = reachPhrase(approval, site);
  if (what === null) {
    return {
      value,
      vague: true,
      label:
        value === "site"
          ? t("approvals.reach.vague.site", { site: site ?? "" })
          : t(`approvals.reach.vague.${value}`),
    };
  }
  if (value === "site") {
    return {
      value,
      label: what.includes(site ?? "\u0000")
        ? t("approvals.reach.siteIn", { what })
        : t("approvals.reach.siteOn", { what, site: site ?? "" }),
    };
  }
  return { value, label: t(`approvals.reach.${value}`, { what }) };
}

/** What a card offers once the card's own rules narrow it (a tainted floored card: once only). */
export function cardOffered(approval: ApprovalRequest): readonly GrantScope[] {
  const floor = floorClassOf(approval.kind, approval.sideEffect);
  return floor !== null && approval.taint
    ? approval.scopesOffered.filter((s) => s === "once")
    : approval.scopesOffered;
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
    ...(offered.includes("task") ? [lastingChoice("task", approval, opts.site)] : []),
    ...(offered.includes("site") && opts.site !== null
      ? [lastingChoice("site", approval, opts.site)]
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
      ? [lastingChoice("session", approval, opts.site)]
      : []),
    // A separate-desktop share is once only: its labels never stand in for an "always".
    ...(offered.includes("always") && !unsandboxed && opts.sdShare !== true
      ? [
          folderScope("always") !== null
            ? { value: "always" as const, label: folderScope("always") as string }
            : lastingChoice("always", approval, opts.site),
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
    SECOND_ORDER.map((v) => rest.find((c) => c.value === v && c.vague !== true)).find(
      (c) => c !== undefined,
    ) ?? null;
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

/** The choices the full card shows: what plain Allow sends, the one second choice, the rest. */
export function cardChoices(
  approval: ApprovalRequest,
  opts: ChoiceOptions,
): { allow: Choice | null; second: Choice | null; more: Choice[] } {
  const choices = buildChoices(approval, cardOffered(approval), opts);
  return splitChoices(
    choices,
    defaultAllow(approval),
    isPaymentCard(approval) || opts.onceOnly === true,
  );
}

/**
 * The choices an Inbox or Home row can send without opening the card. A send, a delete, a payment
 * or a card that needs presence gets plain Allow (once) only: its lasting choices live on the full
 * card, where the recipients, the body and the confirm are in view. Other cards keep their
 * reach-labelled lasting choices, never a Space or a program (they need the card's own picks).
 */
export function inlineChoices(approval: ApprovalRequest): {
  allow: Choice | null;
  second: Choice | null;
  more: Choice[];
  all: Choice[];
} {
  const site = (() => {
    if (approval.target?.kind === "origin") return approval.target.display ?? approval.target.value;
    const d = approval.details as Record<string, unknown>;
    const o = d.origin ?? d.currentOrigin;
    return typeof o === "string" ? o.replace(/^https?:\/\//, "") : null;
  })();
  const onceOnly =
    floorClassOf(approval.kind, approval.sideEffect) !== null || isPaymentCard(approval);
  const parts = cardChoices(approval, { site, onceOnly });
  const drop = (c: Choice) => c.value !== "space" && c.value !== "program";
  const second = parts.second !== null && drop(parts.second) ? parts.second : null;
  const more = parts.more.filter(drop);
  return { allow: parts.allow, second, more, all: [...(second ? [second] : []), ...more] };
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
