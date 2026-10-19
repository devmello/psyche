import type { SkillScanFinding } from "./scanner.ts";
import { type SkillTree, sha256Hex } from "./tree.ts";

/**
 * Optional VirusTotal lookup (security §11): only SHA-256 hashes are sent, never file contents,
 * and only when the owner configured an API key (resolved from the vault by the Gateway and held
 * in memory). Off by default; no network in tests (inject `fetch`).
 */
export interface VirusTotalOptions {
  apiKey: string;
  fetch?: typeof fetch;
  /** Default `https://www.virustotal.com/api/v3`. */
  baseUrl?: string;
  /** Files looked up per install (free API keys allow 4 requests a minute). Default 4. */
  maxLookups?: number;
}

export interface VirusTotalClient {
  scan(tree: SkillTree): Promise<SkillScanFinding[]>;
}

interface VtStats {
  malicious?: number;
  suspicious?: number;
}

export function createVirusTotalClient(opts: VirusTotalOptions): VirusTotalClient {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? "https://www.virustotal.com/api/v3";
  const max = opts.maxLookups ?? 4;
  return {
    async scan(tree) {
      const out: SkillScanFinding[] = [];
      // Scripts and binaries first: they are what a stealer would hide in.
      const paths = [...tree.keys()].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
      for (const path of paths.slice(0, max)) {
        const file = tree.get(path);
        if (file === undefined) continue;
        const hash = sha256Hex(file.bytes);
        let res: Response;
        try {
          res = await f(`${base}/files/${hash}`, { headers: { "x-apikey": opts.apiKey } });
        } catch {
          out.push({ rule: "virustotal-unavailable", severity: "info", message: "VirusTotal could not be reached", file: path });
          continue;
        }
        if (res.status === 404) continue; // unknown to VirusTotal: nothing to report
        if (!res.ok) {
          out.push({ rule: "virustotal-unavailable", severity: "info", message: `VirusTotal answered ${res.status}`, file: path });
          continue;
        }
        const body = (await res.json()) as { data?: { attributes?: { last_analysis_stats?: VtStats } } };
        const stats = body.data?.attributes?.last_analysis_stats ?? {};
        if ((stats.malicious ?? 0) > 0) {
          out.push({ rule: "virustotal-malicious", severity: "high", message: `${stats.malicious} VirusTotal engines flag this file as malicious`, file: path });
        } else if ((stats.suspicious ?? 0) > 0) {
          out.push({ rule: "virustotal-suspicious", severity: "warn", message: `${stats.suspicious} VirusTotal engines flag this file as suspicious`, file: path });
        }
      }
      if (paths.length > max) {
        out.push({ rule: "virustotal-partial", severity: "info", message: `looked up ${max} of ${paths.length} files` });
      }
      return out;
    },
  };
}

function rank(path: string): number {
  if (/\.(?:sh|bash|zsh|py|js|mjs|rb|pl|command|scpt|applescript|exe|dylib|so|bin)$/i.test(path)) return 2;
  if (/\.(?:md|txt|json|ya?ml)$/i.test(path)) return 0;
  return 1;
}
