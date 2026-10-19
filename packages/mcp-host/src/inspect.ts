import type { Tool } from "@modelcontextprotocol/client";

/**
 * Probe-style scan of tool metadata for tool-poisoning patterns (Invariant Labs; security §7.2
 * "probe-style scanning flags instruction-like text"). Findings are warnings shown on the
 * approval / re-approval card; they never make policy weaker. Pattern list is deliberately
 * small and conservative; the injection corpus (S18) is the real evaluation.
 */
export interface ToolWarning {
  tool: string;
  code:
    | "instruction_like"
    | "hidden_markup"
    | "sensitive_path"
    | "cross_tool_reference"
    | "invisible_characters"
    | "oversized_description";
  detail: string;
}

export const MAX_DESCRIPTION_CHARS = 4000;

const CHECKS: { code: ToolWarning["code"]; re: RegExp; detail: string }[] = [
  {
    code: "instruction_like",
    re: /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier)\b|\bdo not (tell|inform|mention)\b|\b(you must|always|before using any other tool)\b[^.]{0,60}\b(call|read|send|include)\b/i,
    detail: "description contains instructions aimed at the model",
  },
  {
    code: "hidden_markup",
    re: /<\s*(important|system|instructions?|secret)\s*>|<!--/i,
    detail: "description contains hidden-instruction markup",
  },
  {
    code: "sensitive_path",
    re: /~\/\.(ssh|aws|psyche|gnupg)|id_rsa|\.env\b|mcp\.json|credentials?\.json/i,
    detail: "description references credential files",
  },
  {
    code: "cross_tool_reference",
    re: /\bmcp__[a-z0-9_-]+__/i,
    detail: "description references another server's tools",
  },
  {
    code: "invisible_characters",
    re: /[​-‏‪-‮⁠-⁤﻿\u{E0000}-\u{E007F}]/u,
    detail: "description contains invisible or bidi control characters",
  },
];

export function inspectTool(tool: Tool): ToolWarning[] {
  const text = [
    tool.title ?? "",
    tool.description ?? "",
    JSON.stringify(tool.inputSchema ?? {}),
  ].join("\n");
  const out: ToolWarning[] = [];
  for (const c of CHECKS)
    if (c.re.test(text)) out.push({ tool: tool.name, code: c.code, detail: c.detail });
  if ((tool.description ?? "").length > MAX_DESCRIPTION_CHARS) {
    out.push({
      tool: tool.name,
      code: "oversized_description",
      detail: `description is longer than ${MAX_DESCRIPTION_CHARS} characters`,
    });
  }
  return out;
}
