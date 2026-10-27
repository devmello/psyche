/**
 * USER.md's profile sections (`## Education`, `## Work history`, `## Skills`, `## Projects`,
 * `## People`, `## Preferences`): the multi-line half of the structured profile, beside the header
 * fields (`profile-fields.ts`). A learned fact the extractor gives a `section` becomes one bullet
 * there instead of a Learned line, with its id, date, thread and kind in a trailing HTML comment
 * (stripped before the prompt, so it costs none of USER.md's budget) for Undo and the teaching
 * loop. Only facts from the owner's own words get a section (security §8); the caller
 * (`learnUserFacts`) passes `ownerWords`, and nothing here reads untrusted content.
 */

export const PROFILE_SECTIONS = [
  "education",
  "experience",
  "skills",
  "projects",
  "people",
  "preferences",
] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

export function isProfileSection(v: unknown): v is ProfileSection {
  return typeof v === "string" && (PROFILE_SECTIONS as readonly string[]).includes(v);
}

const HEADING: Record<ProfileSection, string> = {
  education: "## Education",
  experience: "## Work history",
  skills: "## Skills",
  projects: "## Projects",
  people: "## People",
  preferences: "## Preferences",
};

/** Where a new section goes: before the first of these headings, else at the end. */
const BEFORE = ["## Learned"];

/** `- text <!--lf_id YYYY-MM-DD thread:id kind-->` */
export const SECTION_LINE =
  /^- (.+?) <!--(lf_[a-z0-9]{6,32}) (\d{4}-\d{2}-\d{2}) thread:([^\s>]+) (\w+)(?: lesson:(ls_[a-z0-9_]+))?-->$/;

export interface SectionFact {
  factId: string;
  date: string;
  threadId: string;
  kind: string;
  section: ProfileSection;
  text: string;
  lessonId?: string;
}

export function formatSectionFact(f: Omit<SectionFact, "section">): string {
  const lesson = f.lessonId === undefined ? "" : ` lesson:${f.lessonId}`;
  return `- ${f.text.replace(/\s+/g, " ").trim()} <!--${f.factId} ${f.date} thread:${f.threadId} ${f.kind}${lesson}-->`;
}

function sectionOfHeading(line: string): ProfileSection | undefined {
  const t = line.trim();
  return PROFILE_SECTIONS.find((s) => HEADING[s] === t);
}

/** Bullets written by the learner in the profile sections (owner-written bullets have no marker). */
export function parseSectionFacts(content: string): (SectionFact & { line: number })[] {
  const out: (SectionFact & { line: number })[] = [];
  let section: ProfileSection | undefined;
  content.split("\n").forEach((raw, i) => {
    if (raw.startsWith("## ")) {
      section = sectionOfHeading(raw);
      return;
    }
    if (section === undefined) return;
    const m = SECTION_LINE.exec(raw.trimEnd());
    if (m === null) return;
    out.push({
      line: i + 1,
      text: m[1] as string,
      factId: m[2] as string,
      date: m[3] as string,
      threadId: m[4] as string,
      kind: m[5] as string,
      section,
      ...(m[6] === undefined ? {} : { lessonId: m[6] }),
    });
  });
  return out;
}

/**
 * Adds bullets to their sections, after the section's last bullet (creating a missing section
 * before the Learned section, else at the end). Every other line is kept as it was.
 */
export function addSectionFacts(content: string, facts: readonly SectionFact[]): string {
  let lines = content.split("\n");
  for (const section of PROFILE_SECTIONS) {
    const mine = facts.filter((f) => f.section === section).map(formatSectionFact);
    if (mine.length === 0) continue;
    const at = lines.findIndex((l) => l.trim() === HEADING[section]);
    if (at < 0) {
      let before = lines.findIndex((l) => BEFORE.some((b) => l.startsWith(b)));
      const block = [HEADING[section], "", ...mine, ""];
      if (before < 0) {
        while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
        lines = [...lines, ...(lines.length === 0 ? [] : [""]), ...block];
      } else {
        while (before > 0 && (lines[before - 1] ?? "").trim() === "") before--;
        lines.splice(before, 0, ...(before === 0 ? [] : [""]), ...block.slice(0, -1));
      }
      continue;
    }
    // The end of the section's content: the next heading or EOF, less trailing blank lines.
    let end = at + 1;
    while (end < lines.length && !(lines[end] ?? "").startsWith("## ")) end++;
    while (end > at + 1 && (lines[end - 1] ?? "").trim() === "") end--;
    lines.splice(end, 0, ...(end === at + 1 ? ["", ...mine] : mine));
  }
  return lines.join("\n");
}
