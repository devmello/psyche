/**
 * The Gateway side of the first-run steps (`@psyche/ui/onboarding`): memory import with a review,
 * the live starter tasks, saved progress and "what is already set up". Every function takes the
 * shell's `call`, so tests drive it with a stub and the UI kit stays free of Gateway wiring.
 */
import {
  type HabitChoices,
  habitSettings,
  type ImportedMemory,
  type ImportedMemoryPreview,
  type ImportSource,
  ONBOARDING_PROGRESS_KEY,
  type OnboardingProgress,
  type OnboardingStepId,
  parseProgress,
  type WinId,
} from "@psyche/ui";
import type { GatewayCall } from "./onboarding.ts";

type Call = GatewayCall;
let seq = 0;
const key = (what: string) => `onboarding:${what}:${Date.now()}:${++seq}`;

interface Claim {
  id: string;
  text: string;
  kind: string;
}

/** Parses an export without saving anything (`memory.import` dry run). */
export async function previewImport(
  call: Call,
  format: ImportSource,
  content: string,
): Promise<ImportedMemoryPreview> {
  const res = (await call("memory.import", { format, content, dryRun: true })) as {
    claims: Claim[];
    flagged: string[];
    skipped: number;
  };
  const flagged = new Set(res.flagged);
  return {
    items: res.claims.map((c) => ({
      id: c.id,
      text: c.text,
      kind: c.kind,
      flagged: flagged.has(c.id),
    })),
    skipped: res.skipped,
  };
}

/**
 * Saves the items the owner kept. The export is the owner's own, and they just reviewed it, so
 * each staged claim is confirmed (it becomes an owner claim). Returns how many were saved.
 */
export async function commitImport(call: Call, items: readonly ImportedMemory[]): Promise<number> {
  if (items.length === 0) return 0;
  const content = items.map((i) => `- ${i.text.replace(/\s+/g, " ").trim()}`).join("\n");
  const res = (await call(
    "memory.import",
    { format: "text", content },
    { idempotencyKey: key("import") },
  )) as { claims: Claim[] };
  for (const claim of res.claims) {
    await call(
      "memory.claims.confirm",
      { claimId: claim.id },
      { idempotencyKey: key(`confirm:${claim.id}`) },
    );
  }
  return res.claims.length;
}

const WIN_PROMPTS: Record<WinId, string> = {
  brief:
    "Give me a short morning brief for today from my calendar, reminders and mail. Read only; change nothing. Keep it under 120 words.",
  meetings:
    "List my meetings today and, for each, who is attending and one thing to be ready for. Read only; change nothing. Keep it brief.",
  inbox:
    "Triage my unread inbox: the three that need a reply today and a one-line summary of the rest. Read only; send and change nothing.",
};

/** Runs one starter task in a fresh side chat and resolves with the agent's answer. */
export async function runWin(
  call: Call,
  win: WinId,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { pollMs = 1500, timeoutMs = 120_000 } = options;
  const chat = (await call("threads.newChat", { kind: "side" })) as { thread: { id: string } };
  const threadId = chat.thread.id;
  await call(
    "chat.send",
    { threadId, content: WIN_PROMPTS[win] },
    { idempotencyKey: key(`win:${win}`) },
  );
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const res = (await call("chat.history", { threadId })) as {
      messages: { role: string; blocks: { type: string; md?: string }[] }[];
    };
    const reply = res.messages.find((m) => m.role === "agent");
    const text = (reply?.blocks ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.md ?? "")
      .join("\n")
      .trim();
    if (text !== "" && text === last) {
      // Unchanged across two polls: the reply has settled.
      if (++stable >= 1) return text;
    } else {
      stable = 0;
      last = text;
    }
  }
  if (last !== "") return last;
  throw new Error("no answer in time");
}

/** Stores where the owner is, so quitting midway resumes (best effort). */
export async function saveProgress(call: Call, progress: OnboardingProgress): Promise<void> {
  await call(
    "settings.set",
    { key: ONBOARDING_PROGRESS_KEY, value: JSON.stringify(progress) },
    { idempotencyKey: key("progress") },
  );
}

export async function loadProgress(call: Call): Promise<OnboardingProgress | null> {
  const res = (await call("settings.get", { keys: [ONBOARDING_PROGRESS_KEY] })) as {
    settings: Record<string, unknown>;
  };
  return parseProgress(res.settings[ONBOARDING_PROGRESS_KEY]);
}

/** Writes the habit switches; a key an older Gateway doesn't know never blocks finishing. */
export async function saveHabits(call: Call, habits: HabitChoices): Promise<void> {
  for (const [settingKey, value] of Object.entries(habitSettings(habits))) {
    try {
      await call("settings.set", { key: settingKey, value }, { idempotencyKey: key(settingKey) });
    } catch {
      // Off is the safe default.
    }
  }
}

/** What a re-run can skip because it is already set up. */
export async function detectCompleted(call: Call): Promise<OnboardingStepId[]> {
  const done: OnboardingStepId[] = [];
  const attempt = async (step: OnboardingStepId, check: () => Promise<boolean>) => {
    try {
      if (await check()) done.push(step);
    } catch {
      // Unknown: leave the step in.
    }
  };
  await attempt("about", async () => {
    const user = (await call("memory.read", { path: "USER.md" })) as { content: string };
    return /^- Name:[ \t]*\S/m.test(user.content) && /^- Timezone:[ \t]*\S/m.test(user.content);
  });
  await attempt("connectors", async () => {
    const res = (await call("connectors.list", {})) as { connectors: { status: string }[] };
    return res.connectors.some((c) => c.status === "connected");
  });
  await attempt("memory", async () => {
    const res = (await call("memory.claims.list", {})) as { claims: unknown[] };
    return res.claims.length > 0;
  });
  await attempt("habits", async () => {
    const res = (await call("settings.get", { keys: ["mail.digest.enabled"] })) as {
      settings: Record<string, unknown>;
    };
    return typeof res.settings["mail.digest.enabled"] === "boolean";
  });
  return done;
}

/** Creates a capability card's starter automation. */
export async function createStarterAutomation(
  call: Call,
  title: string,
  cron: string,
  prompt: string,
  timezone?: string,
): Promise<void> {
  await call(
    "automations.create",
    { kind: "cron", title, schedule: cron, prompt, ...(timezone ? { timezone } : {}) },
    { idempotencyKey: key(`automation:${title}`) },
  );
}
