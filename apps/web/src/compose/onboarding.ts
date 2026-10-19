/**
 * Onboarding → workspace files (feature H1, H2; docs/06 onboarding). The UI kit's
 * `OnboardingFlow` hands its result to the host's `onComplete`; this turns it into owner writes
 * through `memory.*` (a paired device with `operator.write` is the owner, docs/status/s07.md):
 * IDENTITY.md gets the name, creature and tagline, USER.md the owner's name and timezone, and
 * SOUL.md is replaced only when the owner picked a persona preset.
 */

export interface OnboardingAnswers {
  name: string;
  creature: string;
  tagline: string;
  ownerName?: string;
  timeZone?: string;
  /** Full text of a persona preset (`templates/personas/*.md`) to use as SOUL.md. */
  soul?: string;
}

export type GatewayCall = (
  method: string,
  params: unknown,
  options?: { idempotencyKey?: string },
) => Promise<unknown>;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

/** Sets top-level `key: "value"` lines in a YAML frontmatter block (adds missing keys). */
export function setFrontmatter(content: string, fields: Record<string, string>): string {
  const match = FRONTMATTER.exec(content);
  const lines = match ? (match[1] ?? "").split(/\r?\n/) : [];
  const body = match ? content.slice(match[0].length) : content;
  for (const [key, value] of Object.entries(fields)) {
    const line = `${key}: ${JSON.stringify(value)}`;
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** Fills `- Label:` lines of USER.md's "About the owner" list when they are still empty. */
export function fillUserFacts(content: string, facts: Record<string, string>): string {
  let out = content;
  for (const [label, value] of Object.entries(facts)) {
    // A replacer function: `$&` or `$1` in the owner's text stay literal.
    out = out.replace(new RegExp(`^- ${label}:[ \\t]*$`, "m"), () => `- ${label}: ${value}`);
  }
  return out;
}

function identityBody(body: string, a: OnboardingAnswers): string {
  const owner = a.ownerName?.trim() || "the owner";
  const [, ...rest] = body.split("\n");
  return [`${a.name} is ${owner}'s personal agent: ${a.creature}.`, ...rest].join("\n");
}

let seq = 0;
const key = (path: string) => `onboarding:${path}:${Date.now()}:${++seq}`;

export async function writeOnboarding(call: GatewayCall, a: OnboardingAnswers): Promise<string[]> {
  const written: string[] = [];
  const update = async (path: string, edit: (current: string) => string) => {
    const current = (await call("memory.read", { path })) as { content: string; etag?: string };
    const content = edit(current.content);
    if (content === current.content) return;
    await call(
      "memory.write",
      { path, content, ...(current.etag === undefined ? {} : { etag: current.etag }) },
      { idempotencyKey: key(path) },
    );
    written.push(path);
  };

  await update("IDENTITY.md", (current) => {
    const withFields = setFrontmatter(current, {
      name: a.name,
      creature: a.creature,
      tagline: a.tagline,
    });
    const match = FRONTMATTER.exec(withFields);
    const head = match ? match[0] : "";
    return head + identityBody(withFields.slice(head.length), a);
  });
  await update("USER.md", (current) =>
    fillUserFacts(current, {
      ...(a.ownerName ? { Name: a.ownerName } : {}),
      ...(a.timeZone ? { Timezone: a.timeZone } : {}),
    }),
  );
  if (a.soul !== undefined) await update("SOUL.md", () => a.soul as string);
  return written;
}
