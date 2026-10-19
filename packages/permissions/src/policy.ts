import {
  ApprovalKind,
  GrantScope,
  PermissionMode,
  PsycheError,
  StringEnum,
  type Target,
} from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalHost, canonicalPath, canonicalUrl } from "./targets.ts";

/**
 * `policy.json`: the owner-authored permission policy (the `permissions` section of `config.json`,
 * security §3.11, mirrored into `policy_rules`). The broker never writes it from a tool call
 * (security §3.9). Unknown keys are rejected so a typo cannot silently disable a rule.
 */

export const RuleEffect = StringEnum(["allow", "ask", "deny"], { $id: "RuleEffect" });
export type RuleEffect = Static<typeof RuleEffect>;

export const AppTier = StringEnum(["off", "read", "click", "interact"], { $id: "AppTier" });
export type AppTier = Static<typeof AppTier>;

const Rules = Type.Array(Type.String({ minLength: 1 }), {
  description:
    'Rules: "<tool glob>", "<tool glob>(<target glob>)", or "<origin|path|recipient|app|account|command>:<glob>"',
});

export const PolicyConfig = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    defaultMode: Type.Optional(PermissionMode),
    grants: Type.Optional(
      Type.Object(
        {
          siteExpiryDays: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 365 })),
          alwaysExpiryDays: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 365 })),
          execHostAlwaysExpiryDays: Type.Optional(
            Type.Number({ exclusiveMinimum: 0, maximum: 90 }),
          ),
          sessionIdleHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 24 })),
          sessionMaxHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 72 })),
          taskHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 168 })),
          destructiveTaskHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 24 })),
          alwaysWarnDays: Type.Optional(Type.Number({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    approvals: Type.Optional(
      Type.Object(
        {
          ttlMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 24 * 60 })),
          /** Extra kinds that are never delivered to chat (the built-in set is always applied). */
          deviceOnly: Type.Optional(Type.Array(ApprovalKind)),
          /** Scopes a chat surface may answer with (default `once`; design-28). */
          chatScopes: Type.Optional(Type.Array(GrantScope)),
          answersPerMinute: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    deny: Type.Optional(Rules),
    ask: Type.Optional(Rules),
    allow: Type.Optional(Rules),
    connectors: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1 }),
        Type.Record(Type.String({ minLength: 1 }), RuleEffect),
      ),
    ),
    apps: Type.Optional(Type.Record(Type.String({ minLength: 1 }), AppTier)),
    sites: Type.Optional(Type.Record(Type.String({ minLength: 1 }), RuleEffect)),
    folders: Type.Optional(
      Type.Array(
        Type.Object(
          { path: Type.String({ minLength: 1 }), mode: StringEnum(["ro", "rw"]) },
          { additionalProperties: false },
        ),
      ),
    ),
    /** Always-rw roots (the per-thread sandbox `/workspace`). */
    workspaceRoots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** Sensitive categories: host globs that always ask for reads and pause when unwatched. */
    sensitiveOrigins: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    exec: Type.Optional(
      Type.Object(
        {
          execHostEnabled: Type.Optional(Type.Boolean()),
          /** Env names the owner typed and allows despite the dangerous-name list. */
          allowEnv: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: true },
      ),
    ),
    classifier: Type.Optional(
      Type.Object(
        {
          model: Type.Optional(Type.String()),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
          failClosed: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: "PolicyConfig", additionalProperties: false },
);
export type PolicyConfig = Static<typeof PolicyConfig>;

/** The bundled, editable sensitive-category list (security §3.2): banking, brokerage, government, health, password managers, identity providers, mail web UIs. */
export const DEFAULT_SENSITIVE_ORIGINS = [
  "*.bank",
  "*.chase.com",
  "*.bankofamerica.com",
  "*.wellsfargo.com",
  "*.citi.com",
  "*.paypal.com",
  "*.schwab.com",
  "*.fidelity.com",
  "*.vanguard.com",
  "*.robinhood.com",
  "*.coinbase.com",
  "*.gov",
  "*.gov.uk",
  "*.mychart.com",
  "*.1password.com",
  "*.bitwarden.com",
  "*.lastpass.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
  "*.okta.com",
  "*.auth0.com",
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "mail.yahoo.com",
  "*.icloud.com",
];

export const DEFAULT_POLICY: Required<Pick<PolicyConfig, "defaultMode">> & PolicyConfig = {
  defaultMode: "balanced",
};

export function parsePolicy(input: unknown): PolicyConfig {
  if (!Value.Check(PolicyConfig, input)) {
    const first = [...Value.Errors(PolicyConfig, input)][0];
    throw new PsycheError(
      "invalid_params",
      `policy: ${first === undefined ? "invalid" : `${first.path || "/"} ${first.message}`}`,
    );
  }
  for (const list of [input.deny, input.ask, input.allow]) for (const r of list ?? []) parseRule(r);
  return input;
}

// ---- rules ------------------------------------------------------------------------------------

export type RuleTargetKind = "origin" | "path" | "recipient" | "app" | "account" | "command";

export interface Rule {
  raw: string;
  /** Tool glob, or undefined for a pure target rule. */
  tool?: RegExp;
  targetKind?: RuleTargetKind;
  target?: RegExp;
}

const TARGET_PREFIXES: RuleTargetKind[] = [
  "origin",
  "path",
  "recipient",
  "app",
  "account",
  "command",
];

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Path globs: `**` crosses segments, `*` and `?` do not. Other globs: `*` is any run. */
export function globToRegExp(glob: string, flavor: "path" | "plain"): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? "";
    if (flavor === "path" && c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") {
      re += flavor === "path" ? "[^/]*" : ".*";
    } else if (c === "?") {
      re += flavor === "path" ? "[^/]" : ".";
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`, flavor === "path" ? "" : "i");
}

export function parseRule(raw: string): Rule {
  const s = raw.trim();
  for (const kind of TARGET_PREFIXES) {
    if (s.startsWith(`${kind}:`)) {
      const pattern = s.slice(kind.length + 1);
      if (pattern === "")
        throw new PsycheError("invalid_params", `policy rule "${raw}" has no pattern`);
      return {
        raw,
        targetKind: kind,
        target: globToRegExp(pattern, kind === "path" ? "path" : "plain"),
      };
    }
  }
  const call = /^([^()]+)\((.+)\)$/.exec(s);
  if (call?.[1] !== undefined && call[2] !== undefined) {
    const arg = call[2];
    return {
      raw,
      tool: globToRegExp(call[1], "plain"),
      target: globToRegExp(arg, arg.startsWith("/") || arg.startsWith("**") ? "path" : "plain"),
    };
  }
  if (/[()\s]/.test(s))
    throw new PsycheError("invalid_params", `policy rule "${raw}" is malformed`);
  return { raw, tool: globToRegExp(s, "plain") };
}

/** Strings a target rule is compared against: canonical forms only. */
export function targetCandidates(target: Target | undefined): string[] {
  if (target === undefined) return [];
  const v = target.value;
  switch (target.kind) {
    case "origin":
      try {
        const u = canonicalUrl(v);
        return [u.host, u.origin];
      } catch {
        try {
          return [canonicalHost(v)];
        } catch {
          return [v];
        }
      }
    case "path":
      try {
        return [canonicalPath(v)];
      } catch {
        return [v];
      }
    case "recipient":
      return [v.toLowerCase()];
    default:
      return [v];
  }
}

export function ruleMatches(rule: Rule, tool: string, target: Target | undefined): boolean {
  if (rule.tool !== undefined && !rule.tool.test(tool)) return false;
  if (rule.target === undefined) return true;
  if (rule.targetKind !== undefined && target?.kind !== rule.targetKind) {
    // `app:` also matches computer-use calls whose target is the app bundle id.
    return false;
  }
  return targetCandidates(target).some((c) => rule.target?.test(c) === true);
}

export interface CompiledPolicy {
  config: PolicyConfig;
  deny: Rule[];
  ask: Rule[];
  allow: Rule[];
  sensitive: RegExp[];
  folders: { path: string; mode: "ro" | "rw" }[];
  workspaceRoots: string[];
  sites: { pattern: RegExp; effect: RuleEffect; raw: string }[];
}

export function compilePolicy(config: PolicyConfig = DEFAULT_POLICY): CompiledPolicy {
  const parsed = parsePolicy(config);
  return {
    config: parsed,
    deny: (parsed.deny ?? []).map(parseRule),
    ask: (parsed.ask ?? []).map(parseRule),
    allow: (parsed.allow ?? []).map(parseRule),
    sensitive: (parsed.sensitiveOrigins ?? DEFAULT_SENSITIVE_ORIGINS).map((g) =>
      globToRegExp(g, "plain"),
    ),
    folders: (parsed.folders ?? [])
      .map((f) => ({ path: canonicalPath(f.path), mode: f.mode }))
      .sort((a, b) => b.path.length - a.path.length),
    workspaceRoots: (parsed.workspaceRoots ?? ["/workspace"]).map(canonicalPath),
    sites: Object.entries(parsed.sites ?? {}).map(([raw, effect]) => ({
      raw,
      effect,
      pattern: globToRegExp(raw.includes("://") ? raw : raw, "plain"),
    })),
  };
}

export function isSensitiveHost(policy: CompiledPolicy, host: string): boolean {
  return policy.sensitive.some((re) => re.test(host));
}
