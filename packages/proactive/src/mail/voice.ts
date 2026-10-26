import type { Clock, MemoryStore, ModelProvider, ModelRef } from "@psyche/protocol";
import {
  jobMarker,
  type LaunchResult,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "../jobs.ts";
import type { ToolLookup } from "../proposals/service.ts";
import { toIso } from "../sqlite.ts";
import { cleanHeader } from "./classify.ts";
import { addressOf, domainOf } from "./rules.ts";
import { readTool } from "./tools.ts";

/**
 * The owner's writing voice (docs/workflows/mail-and-meetings-2026.md §4.3, §3 rule 6): learned
 * from the owner's own sent text only (quotes, forwards and signatures stripped), kept as two
 * workspace files the owner can read, edit and reset:
 * - `mail/VOICE.md`: greetings and sign-offs per relationship tier, length, contractions,
 *   emoji and exclamation habits, with examples copied only from the owner's own lines;
 * - `mail/voice-samples.jsonl`: up to 40 short sentences of the owner's, chosen for variety.
 * Opt-in (`mail.voice.enabled`, off by default). They reach a model only inside a drafting
 * prompt; with a local model pinned they never leave the Mac.
 */

export const VOICE_PATH = "mail/VOICE.md";
export const VOICE_SAMPLES_PATH = "mail/voice-samples.jsonl";
export const MAIL_VOICE_JOB = "mail-voice";
export const MAX_SENT = 100;
export const MAX_SAMPLES = 40;

export type Tier = "colleague" | "known" | "unknown";

export interface SentMessage {
  to: string[];
  body: string;
  at: string;
}

export interface VoiceSample {
  text: string;
  tier: Tier;
}

export interface VoiceProfile {
  messages: number;
  greetings: Record<Tier, Record<string, number>>;
  signoffs: Record<Tier, Record<string, number>>;
  medianWords: number;
  medianSentenceWords: number;
  contractions: number;
  emoji: number;
  exclamations: number;
  samples: VoiceSample[];
}

const QUOTE_HEADER =
  /^(on .{3,120} wrote:|-{2,} ?original message ?-{2,}|-{5,} ?forwarded message ?-{5,}|from: .+|sent from my .+)$/i;
const GREETING = /^(hi|hey|hello|dear|good (morning|afternoon|evening)|morning|yo)\b[^\n]{0,40}$/i;
const SIGNOFF =
  /^(thanks|thank you|thx|best|cheers|regards|kind regards|best regards|warmly|talk soon|see you|love|xx|—|-)([,!.]?(\s[^\n]{0,30})?)$/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const CONTRACTION = /\b\w+'(s|t|re|ve|ll|d|m)\b/i;

/** The owner's own lines of a sent message: quoted text, forwards and the signature removed. */
export function ownText(body: string, signature?: string): string {
  const out: string[] = [];
  for (const raw of body.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "--" || QUOTE_HEADER.test(line.trim())) break;
    if (line.trimStart().startsWith(">")) continue;
    out.push(line);
  }
  let text = out.join("\n").trim();
  if (signature !== undefined && signature !== "" && text.endsWith(signature)) {
    text = text.slice(0, -signature.length).trim();
  }
  return text;
}

/** The trailing lines most sent messages share: the owner's signature. */
export function commonSignature(bodies: readonly string[]): string | undefined {
  if (bodies.length < 3) return undefined;
  const tails = new Map<string, number>();
  for (const b of bodies) {
    const lines = b.trim().split("\n");
    for (let n = 2; n <= Math.min(4, lines.length - 1); n += 1) {
      const tail = lines.slice(-n).join("\n").trim();
      tails.set(tail, (tails.get(tail) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  for (const [tail, count] of tails) {
    if (count / bodies.length >= 0.6 && (best === undefined || tail.length > best.length))
      best = tail;
  }
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

function bump(m: Record<string, number>, key: string): void {
  m[key] = (m[key] ?? 0) + 1;
}

export function buildProfile(
  messages: readonly SentMessage[],
  tierOf: (address: string) => Tier,
): VoiceProfile {
  const signature = commonSignature(messages.map((m) => m.body));
  const greetings: VoiceProfile["greetings"] = { colleague: {}, known: {}, unknown: {} };
  const signoffs: VoiceProfile["signoffs"] = { colleague: {}, known: {}, unknown: {} };
  const words: number[] = [];
  const sentenceWords: number[] = [];
  let contractions = 0;
  let emoji = 0;
  let exclaim = 0;
  const pool: VoiceSample[] = [];
  for (const m of messages) {
    const text = ownText(m.body, signature);
    if (text === "") continue;
    const tier = tierOf(addressOf(m.to[0] ?? ""));
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const first = lines[0];
    if (first !== undefined && GREETING.test(first))
      bump(greetings[tier], first.replace(/[ ,]+\w+[,!]?$/, "").replace(/[,!]$/, "") || first);
    const last = lines.at(-1);
    if (last !== undefined && SIGNOFF.test(last) && last.length <= 30) bump(signoffs[tier], last);
    words.push(text.split(/\s+/).length);
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of sentences) {
      sentenceWords.push(s.split(/\s+/).length);
      if (s.length >= 12 && s.length <= 160 && !GREETING.test(s) && !SIGNOFF.test(s))
        pool.push({ text: s, tier });
    }
    if (CONTRACTION.test(text)) contractions += 1;
    if (EMOJI.test(text)) emoji += 1;
    if (text.includes("!")) exclaim += 1;
  }
  const n = Math.max(1, words.length);
  // Variety: one sample per first word, spread over tiers and lengths.
  const seen = new Set<string>();
  const samples: VoiceSample[] = [];
  for (const s of [...pool].sort((a, b) => a.text.length - b.text.length)) {
    const key = `${s.tier}:${(s.text.split(/\s+/)[0] ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push(s);
    if (samples.length >= MAX_SAMPLES) break;
  }
  return {
    messages: words.length,
    greetings,
    signoffs,
    medianWords: median(words),
    medianSentenceWords: median(sentenceWords),
    contractions: Math.round((contractions / n) * 100) / 100,
    emoji: Math.round((emoji / n) * 100) / 100,
    exclamations: Math.round((exclaim / n) * 100) / 100,
    samples,
  };
}

function top(m: Record<string, number>, k = 3): string {
  const list = Object.entries(m)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([v, c]) => `"${v}" (${c})`);
  return list.length === 0 ? "none seen" : list.join(", ");
}

/** The human-readable profile (`mail/VOICE.md`); every example is the owner's own text. */
export function renderVoice(p: VoiceProfile, at: string): string {
  const tiers: Tier[] = ["colleague", "known", "unknown"];
  return [
    "# My writing voice",
    "",
    `<!-- Learned by Psyche from ${p.messages} of your sent emails on ${at.slice(0, 10)}. Edit anything; Reset in Settings → Mail & meetings deletes this file. -->`,
    "",
    "## Greetings",
    ...tiers.map(
      (t) =>
        `- ${t === "colleague" ? "Colleagues" : t === "known" ? "People you know" : "Others"}: ${top(p.greetings[t])}`,
    ),
    "",
    "## Sign-offs",
    ...tiers.map(
      (t) =>
        `- ${t === "colleague" ? "Colleagues" : t === "known" ? "People you know" : "Others"}: ${top(p.signoffs[t])}`,
    ),
    "",
    "## Habits",
    `- Length: about ${p.medianWords} words; sentences about ${p.medianSentenceWords} words.`,
    `- Contractions in ${Math.round(p.contractions * 100)}% of emails; emoji in ${Math.round(p.emoji * 100)}%; exclamation marks in ${Math.round(p.exclamations * 100)}%.`,
    "",
    "## Examples (your own sentences)",
    ...p.samples.slice(0, 6).map((s) => `- ${s.text}`),
    "",
  ].join("\n");
}

export interface VoiceServiceOptions {
  clock: Clock;
  tools: ToolLookup;
  memory: Pick<MemoryStore, "readFile" | "writeFile"> & {
    delete?: (path: string, options: { provenance: "owner" }) => Promise<unknown>;
  };
  scheduler?: SchedulerLike;
  /** The owner's own addresses (sent mail is theirs); their domain marks colleagues. */
  ownerAddresses: () => Promise<string[]>;
  isKnownPerson?: (address: string) => Promise<boolean>;
  timezone?: string;
  provider?: ModelProvider;
  model?: ModelRef;
}

export class VoiceService {
  readonly #o: VoiceServiceOptions;

  constructor(options: VoiceServiceOptions) {
    this.#o = options;
  }

  /** Sent mail of the last 180 days through the mail tools, at most `MAX_SENT` messages. */
  async #sent(): Promise<SentMessage[]> {
    const since = toIso(this.#o.clock.now() - 180 * 86_400_000);
    const out: SentMessage[] = [];
    const list = await readTool(this.#o.tools, "mail_search", {
      mailbox: "Sent",
      since,
      limit: MAX_SENT,
    });
    const msgs =
      (list as { messages?: { id?: string; mailbox?: string }[] } | undefined)?.messages ?? [];
    for (const m of msgs.slice(0, MAX_SENT)) {
      if (typeof m.id !== "string") continue;
      const full = (await readTool(this.#o.tools, "mail_read", {
        id: m.id,
        mailbox: m.mailbox ?? "Sent",
      })) as { body?: string; to?: string[]; summary?: { date?: string } } | undefined;
      if (typeof full?.body !== "string") continue;
      out.push({ to: full.to ?? [], body: full.body, at: full.summary?.date ?? since });
    }
    return out;
  }

  /** Builds and writes the profile (the nightly job, and "refresh my writing style"). */
  async refresh(): Promise<VoiceProfile | undefined> {
    const sent = await this.#sent();
    if (sent.length === 0) return undefined;
    const owners = (await this.#o.ownerAddresses()).map((a) => a.toLowerCase());
    const ownDomains = new Set(owners.map(domainOf));
    const known = new Set<string>();
    for (const m of sent) {
      const a = addressOf(m.to[0] ?? "");
      if ((await this.#o.isKnownPerson?.(a)) === true) known.add(a);
    }
    const profile = buildProfile(sent, (a) =>
      ownDomains.has(domainOf(a)) ? "colleague" : known.has(a) ? "known" : "unknown",
    );
    const at = toIso(this.#o.clock.now());
    await this.#o.memory.writeFile(VOICE_PATH, renderVoice(profile, at), { provenance: "owner" });
    await this.#o.memory.writeFile(
      VOICE_SAMPLES_PATH,
      `${profile.samples.map((s) => JSON.stringify({ text: cleanHeader(s.text, 200), tier: s.tier })).join("\n")}\n`,
      { provenance: "owner" },
    );
    return profile;
  }

  /** The profile text and the samples nearest a tier (for a drafting prompt). */
  async forDraft(tier: Tier): Promise<{ voice?: string; samples: VoiceSample[] }> {
    const voice = (await this.#o.memory.readFile(VOICE_PATH))?.content;
    const raw = (await this.#o.memory.readFile(VOICE_SAMPLES_PATH))?.content ?? "";
    const samples: VoiceSample[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const s = JSON.parse(line) as VoiceSample;
        if (typeof s.text === "string") samples.push(s);
      } catch {
        // an edited line that no longer parses is skipped
      }
    }
    const ordered = [
      ...samples.filter((s) => s.tier === tier),
      ...samples.filter((s) => s.tier !== tier),
    ];
    const has = voice !== undefined && voice.trim() !== "";
    return { ...(has ? { voice } : {}), samples: ordered.slice(0, 6) };
  }

  /** Reset (Settings): both files go; drafts then say "No writing style yet". */
  async reset(): Promise<void> {
    for (const path of [VOICE_PATH, VOICE_SAMPLES_PATH]) {
      if ((await this.#o.memory.readFile(path)) === undefined) continue;
      if (this.#o.memory.delete !== undefined)
        await this.#o.memory.delete(path, { provenance: "owner" });
      else await this.#o.memory.writeFile(path, "", { provenance: "owner" });
    }
  }

  async ensureSchedule(options: { enabled?: boolean; timezone?: string } = {}) {
    if (this.#o.scheduler === undefined) return undefined;
    const prompt = jobMarker(MAIL_VOICE_JOB, "nightly");
    const fields = {
      title: "Learn my writing style",
      schedule: "15 3 * * *",
      timezone: options.timezone ?? this.#o.timezone ?? "UTC",
      sessionTarget: "main",
      delivery: {},
      prompt,
      enabled: options.enabled ?? false,
      scratch: null,
    };
    const existing = (await this.#o.scheduler.list()).find((a) => a.prompt.trim() === prompt);
    return existing === undefined
      ? this.#o.scheduler.create({ kind: "cron", system: true, ...fields })
      : this.#o.scheduler.update(existing.id, fields);
  }

  job(): ProactiveJob {
    return {
      name: "mail voice",
      matches: (a) => parseJobMarker(a.prompt)?.job === MAIL_VOICE_JOB,
      run: async (): Promise<LaunchResult> => {
        const p = await this.refresh();
        return {
          status: "no_reply",
          summary:
            p === undefined ? "no sent mail" : `${p.messages} emails, ${p.samples.length} samples`,
        };
      },
    };
  }
}
