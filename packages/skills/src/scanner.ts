import type { ScanFinding } from "@psyche/protocol";
import { parseSkill } from "./frontmatter.ts";
import { type SkillTree, textOf } from "./tree.ts";

/**
 * Static scan of a whole skill folder before it is enabled (security §11, feature T2, review
 * design-24). It looks for what the ClawHavoc campaign used: `curl | sh` "prerequisites",
 * Gatekeeper bypasses, credential theft, exfiltration endpoints, encoded payloads, hidden text
 * and instructions aimed at the agent. A `high` finding blocks enabling.
 *
 * Messages never quote the matched text, so a secret in a skill is not copied into findings.
 */
export interface SkillScanFinding extends ScanFinding {
  /** Path inside the skill folder. */
  file?: string;
}

interface LineRule {
  rule: string;
  severity: ScanFinding["severity"];
  message: string;
  pattern: RegExp;
  /** Only in Markdown files. */
  markdownOnly?: boolean;
}

const SHELLS = "(?:sudo\\s+)?(?:ba|z|da|k|fi)?sh|(?:sudo\\s+)?(?:python3?|node|perl|ruby|osascript)";

const LINE_RULES: LineRule[] = [
  // Remote code execution
  {
    rule: "pipe-to-shell",
    severity: "high",
    message: "downloads a script and pipes it into a shell or interpreter",
    pattern: new RegExp(
      `\\b(?:curl|wget|fetch|iwr|invoke-webrequest)\\b[^\\n|]*\\|\\s*(?:${SHELLS})\\b`,
      "i",
    ),
  },
  {
    rule: "remote-exec",
    severity: "high",
    message: "executes downloaded content (process substitution, eval or sh -c)",
    pattern:
      /(?:\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)|\b(?:eval|(?:ba|z)?sh\s+-c)\s+["']?\$\(\s*(?:curl|wget)|\b(?:iex|invoke-expression)\b)/i,
  },
  {
    rule: "decode-and-exec",
    severity: "high",
    message: "decodes an encoded payload and executes it",
    pattern:
      /(?:base64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:(?:ba|z)?sh|python3?|node)\b|\beval\s*\(\s*atob\s*\(|\bexec\s*\(\s*(?:base64\.b64decode|codecs\.decode|bytes\.fromhex)|\bFunction\s*\(\s*atob\s*\()/i,
  },
  // Install instructions the agent would run itself (design-24 #1)
  {
    rule: "install-instructions",
    severity: "high",
    message:
      "contains package-install commands; declare prerequisites in `requires` so the owner installs them",
    pattern:
      /\b(?:(?:brew|apt-get|apt|yum|dnf|pacman|port|choco|winget)\s+install|npm\s+(?:i|install)\s+(?:-g|--global)|pnpm\s+(?:add|install)\s+(?:-g|--global)|npx\s+(?:-y|--yes)|pip3?\s+install|pipx\s+install|uv\s+tool\s+install|go\s+install|cargo\s+install|gem\s+install)\b/i,
  },
  // macOS defences
  {
    rule: "gatekeeper-bypass",
    severity: "high",
    message: "removes the quarantine attribute or disables Gatekeeper",
    pattern:
      /(?:\bxattr\s+(?:-\w*[dc]\w*)\b[^\n]*(?:quarantine)?|\bspctl\s+--master-disable|\bcsrutil\s+disable)/i,
  },
  {
    rule: "persistence",
    severity: "high",
    message: "installs a login item, launch agent or cron job",
    pattern:
      /(?:\blaunchctl\s+(?:load|bootstrap|submit)|LaunchAgents\/|LaunchDaemons\/|\bcrontab\s+(?:-\w+\s+)*-?\s*[^\s-]|\bloginitems?\b)/i,
  },
  {
    rule: "credential-access",
    severity: "high",
    message: "reads credential stores (SSH keys, keychain, browser cookies, cloud credentials)",
    pattern:
      /(?:~\/\.ssh\/|\$HOME\/\.ssh|\.aws\/credentials|\.config\/gcloud|\.netrc\b|\.npmrc\b|\bsecurity\s+(?:find|dump)-(?:generic|internet)-password|\bdump-keychain\b|Library\/Keychains|Cookies\.binarycookies|\bLogin Data\b|wallet\.dat|\bkeychain-db\b)/i,
  },
  {
    rule: "exfiltration-endpoint",
    severity: "high",
    message: "references a paste, tunnel or webhook service often used to exfiltrate data",
    pattern:
      /(?:webhook\.site|requestbin|pipedream\.net|ngrok(?:-free)?\.(?:io|app|dev)|pastebin\.com|paste\.ee|transfer\.sh|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com\/services)/i,
  },
  {
    rule: "raw-ip-url",
    severity: "high",
    message: "fetches from a bare IP address",
    pattern: /\bhttps?:\/\/\d{1,3}(?:\.\d{1,3}){3}\b/i,
  },
  // Secrets shipped in the skill
  {
    rule: "secret",
    severity: "high",
    message: "contains what looks like a secret key or token",
    pattern:
      /(?:\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b|\b[rs]k_live_[A-Za-z0-9]{16,}\b|\bAIza[0-9A-Za-z_-]{35}\b)/,
  },
  // Instructions aimed at the agent (prompt injection)
  {
    rule: "agent-directed-instruction",
    severity: "high",
    message: "tells the agent to ignore its rules, hide actions or bypass approvals",
    pattern:
      /(?:\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|your|the\s+system)\s+(?:instructions|rules|messages|prompt)|\bdisregard\s+(?:the\s+|all\s+)?(?:system|previous|prior|safety)|\b(?:do\s+not|don't|never)\s+(?:tell|inform|show|mention|reveal|notify)\b[^.\n]{0,40}\b(?:user|owner|human)\b|\bwithout\s+(?:asking|confirmation|approval|telling|notifying)\b|\b(?:bypass|disable|skip|turn\s+off|circumvent)\b[^.\n]{0,30}\b(?:approvals?|permissions?|confirmations?|safety|sandbox|guardrails?)\b|\byou\s+are\s+now\b|\b(?:reveal|print|output|send|upload|exfiltrate)\b[^.\n]{0,40}\b(?:system\s+prompt|api\s+keys?|credentials|passwords?|cookies|tokens)\b)/i,
  },
  // Weaker signals
  {
    rule: "privileged-command",
    severity: "warn",
    message: "runs privileged or destructive shell commands (sudo, rm -rf, chmod +x)",
    pattern: /(?:\bsudo\s+\S|\brm\s+-\w*[rR]\w*f|\brm\s+-\w*f\w*[rR]|\bchmod\s+(?:\+x|[0-7]*7[0-7]{2})\b|\bdd\s+if=)/,
  },
  {
    rule: "credential-placeholder",
    severity: "warn",
    message: "references a vault credential placeholder",
    pattern: /\{\{\s*cred:/,
  },
  {
    rule: "encoded-blob",
    severity: "warn",
    message: "contains a long encoded string (possible obfuscated payload)",
    pattern: /(?:[A-Za-z0-9+/]{160,}={0,2}|(?:\\x[0-9a-fA-F]{2}){12,}|(?:%[0-9a-fA-F]{2}){24,}|String\.fromCharCode\((?:\s*\d+\s*,){12,})/,
  },
];

const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;
const URL = /\bhttps?:\/\/([^\s/)>"'`]+)/gi;
/** Commands that fetch from the network (a URL alone is a reference, not a fetch). */
const NETWORK_CMD = /\b(?:curl|wget|git\s+clone|invoke-webrequest|iwr|scp|rsync|ncat|aria2c)\b/i;
const PREREQ_HEADING =
  /^#{1,6}\s*(?:prerequisites?|requirements|setup|set\s*up|installation|install(?:ing)?|before\s+you\s+(?:begin|start)|getting\s+started|dependencies)\b/i;
const BROAD_DESCRIPTION =
  /\b(?:any|every|all)\s+(?:tasks?|requests?|questions?|messages?|conversations?)\b|\balways\s+(?:use|load|relevant)\b/i;

function isMarkdown(path: string): boolean {
  return /\.(?:md|markdown|mdx|txt)$/i.test(path);
}

/** Scans every file of a skill tree. `SKILL.md` must be present and valid. */
export function scanSkillTree(tree: SkillTree, expectedName?: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const skillMd = tree.get("SKILL.md");
  if (skillMd === undefined) {
    findings.push({ rule: "missing-skill-md", severity: "high", message: "no SKILL.md at the top of the folder" });
  } else {
    const text = textOf(skillMd);
    const parsed = text === undefined ? undefined : parseSkill(text, expectedName);
    if (parsed === undefined || !parsed.ok) {
      findings.push({
        rule: "invalid-frontmatter",
        severity: "high",
        message: parsed === undefined ? "SKILL.md is not UTF-8 text" : parsed.errors.join("; "),
        file: "SKILL.md",
      });
    } else {
      const { meta, frontmatter } = parsed.skill;
      if (BROAD_DESCRIPTION.test(meta.description)) {
        findings.push({
          rule: "broad-description",
          severity: "warn",
          message: "the description claims to apply to every task, so it would load everywhere",
          file: "SKILL.md",
        });
      }
      findings.push(...scanInstallSpecs(frontmatter));
    }
  }

  for (const [path, file] of [...tree.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const text = textOf(file);
    if (text === undefined) {
      findings.push({
        rule: "binary-file",
        severity: "warn",
        message: "binary file that cannot be reviewed as text",
        file: path,
      });
      continue;
    }
    if (file.executable || /\.(?:sh|bash|zsh|py|js|mjs|ts|rb|pl|applescript|scpt|command)$/i.test(path)) {
      findings.push({ rule: "script", severity: "info", message: "bundled script or executable", file: path });
    }
    findings.push(...scanText(path, text));
  }
  return dedupe(findings);
}

/** Line rules, invisible characters, hidden comments, network use and prerequisite sections. */
export function scanText(path: string, text: string): SkillScanFinding[] {
  const out: SkillScanFinding[] = [];
  const md = isMarkdown(path);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let inPrereq = false;
  const hosts = new Set<string>();
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (md && /^#{1,6}\s/.test(line)) inPrereq = PREREQ_HEADING.test(line);
    for (const r of LINE_RULES) {
      if (r.markdownOnly === true && !md) continue;
      if (r.pattern.test(line)) {
        out.push({ rule: r.rule, severity: r.severity, message: r.message, line: lineNo, file: path });
      }
    }
    const scrubbed = i === 0 ? line.replace(/^﻿/, "") : line;
    if (INVISIBLE.test(scrubbed)) {
      out.push({
        rule: "invisible-characters",
        severity: "high",
        message: "contains zero-width or bidirectional control characters (hidden text)",
        line: lineNo,
        file: path,
      });
    }
    if (inPrereq && NETWORK_CMD.test(line)) {
      out.push({
        rule: "network-in-prerequisites",
        severity: "high",
        message: "the setup / prerequisites section fetches from the network",
        line: lineNo,
        file: path,
      });
    }
    for (const m of line.matchAll(URL)) hosts.add((m[1] ?? "").toLowerCase());
  });
  if (md) {
    for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
      if ((m[1] ?? "").trim().length === 0) continue;
      out.push({
        rule: "hidden-comment",
        severity: "warn",
        message: "HTML comment that is invisible when rendered",
        line: text.slice(0, m.index).split("\n").length,
        file: path,
      });
    }
  }
  if (hosts.size > 0) {
    out.push({
      rule: "network-reference",
      severity: "info",
      message: `refers to ${[...hosts].sort().slice(0, 8).join(", ")}${hosts.size > 8 ? ", …" : ""}`,
      file: path,
    });
  }
  return out;
}

/** OpenClaw-style install specs in frontmatter: shown to the owner; downloads need a sha256. */
function scanInstallSpecs(frontmatter: Record<string, unknown>): SkillScanFinding[] {
  const out: SkillScanFinding[] = [];
  const meta = frontmatter.metadata as Record<string, unknown> | undefined;
  const oc = meta?.openclaw as Record<string, unknown> | undefined;
  const specs = [frontmatter.install, oc?.install].flatMap((v) => (Array.isArray(v) ? v : []));
  for (const spec of specs) {
    const s = (typeof spec === "object" && spec !== null ? spec : {}) as Record<string, unknown>;
    const kind = typeof s.kind === "string" ? s.kind : "unknown";
    if (kind === "download" && typeof s.sha256 !== "string") {
      out.push({
        rule: "unpinned-download",
        severity: "high",
        message: "declares a download installer without a sha256 pin",
        file: "SKILL.md",
      });
    } else {
      out.push({
        rule: "declared-installer",
        severity: "warn",
        message: `declares a ${kind} installer; the owner runs it from the install screen, never the agent`,
        file: "SKILL.md",
      });
    }
  }
  return out;
}

function dedupe(findings: SkillScanFinding[]): SkillScanFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.rule}|${f.file ?? ""}|${f.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hasBlockingFindings(findings: readonly ScanFinding[]): boolean {
  return findings.some((f) => f.severity === "high");
}

export function summarizeFindings(findings: readonly ScanFinding[]): Record<ScanFinding["severity"], number> {
  const out = { high: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}
