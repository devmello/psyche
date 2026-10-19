import {
  type ModelProvider,
  type ModelRef,
  type PersonaIdentity,
  PsycheError,
} from "@psyche/protocol";
import { oneLine } from "./daily.ts";
import { blockingKinds, looksLikeInstruction } from "./filters.ts";
import { type Identity, parseIdentity, serializeIdentity } from "./persona.ts";
import type { SqliteMemoryStore } from "./store.ts";

/**
 * Persona editing by pencil (feature H9; UI design §3.18 "Describe a change", §4.7). A change
 * arrives as fields (the agent's `persona_update` tool, or the Soul & Memory form) or as words
 * the utility model turns into fields (`memory.persona.edit { instruction }`). The result is
 * written to `IDENTITY.md` (an owner write, or an agent write behind a `memory_protected_write`
 * approval) and announced with `persona.updated`, which carries `avatarRequested` when the
 * creature or name changed so the avatar renderer makes a new one.
 */

export const PERSONA_FIELDS = [
  "name",
  "creature",
  "vibe",
  "tagline",
  "emoji",
  "voice",
  "avatar",
] as const;
export type PersonaField = (typeof PERSONA_FIELDS)[number];

const LIMITS: Record<PersonaField, number> = {
  name: 80,
  creature: 300,
  vibe: 200,
  tagline: 200,
  emoji: 16,
  voice: 120,
  avatar: 200,
};
const DESCRIPTION_LIMIT = 2000;

export interface PersonaChange {
  fields?: Partial<Record<PersonaField, string>>;
  description?: string;
}

export interface PersonaResult {
  identity: PersonaIdentity;
  description: string;
  etag: string;
  changed: string[];
  avatarRequested: boolean;
}

function toWire(identity: Identity): PersonaIdentity {
  const out: PersonaIdentity = {};
  for (const key of PERSONA_FIELDS) {
    const value = identity[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Reads the persona from `IDENTITY.md`. */
export async function readPersona(store: SqliteMemoryStore): Promise<{
  identity: PersonaIdentity;
  description: string;
  etag: string;
}> {
  const file = await store.readFile("IDENTITY.md");
  const parsed = parseIdentity(file?.content ?? "---\n---\n");
  return {
    identity: toWire(parsed.identity),
    description: parsed.body.replace(/<!--[\s\S]*?-->/g, "").trim(),
    etag: file?.etag ?? "",
  };
}

/** Validates one change; agent changes must not read like instructions (persistent injection). */
export function validatePersonaChange(
  change: PersonaChange,
  actor: "owner" | "agent",
): PersonaChange {
  const out: PersonaChange = {};
  const fields: Partial<Record<PersonaField, string>> = {};
  for (const [key, raw] of Object.entries(change.fields ?? {})) {
    if (!(PERSONA_FIELDS as readonly string[]).includes(key)) {
      throw new PsycheError("invalid_params", `unknown persona field ${key}`);
    }
    if (typeof raw !== "string") throw new PsycheError("invalid_params", `${key} must be text`);
    const value = oneLine(raw);
    if (value.length > LIMITS[key as PersonaField]) {
      throw new PsycheError("invalid_params", `${key} is too long`);
    }
    fields[key as PersonaField] = value;
  }
  if (Object.keys(fields).length > 0) out.fields = fields;
  if (change.description !== undefined) {
    const description = change.description.trim();
    if (description.length > DESCRIPTION_LIMIT) {
      throw new PsycheError("invalid_params", "description is too long");
    }
    out.description = description;
  }
  const all = [...Object.values(fields), out.description ?? ""].join("\n");
  if (blockingKinds(all, true).length > 0) {
    throw new PsycheError(
      "policy_denied",
      "persona text cannot contain credentials or card numbers",
    );
  }
  if (actor === "agent" && looksLikeInstruction(all)) {
    throw new PsycheError(
      "policy_denied",
      "persona text reads like an instruction; ask the owner to edit it",
    );
  }
  return out;
}

/** Applies a change to `IDENTITY.md` and emits `persona.updated`. */
export async function applyPersonaChange(
  store: SqliteMemoryStore,
  change: PersonaChange,
  options: { actor: "owner" | "agent"; approvalId?: string; etag?: string },
): Promise<PersonaResult> {
  const valid = validatePersonaChange(change, options.actor);
  const file = await store.readFile("IDENTITY.md");
  if (options.etag !== undefined && file?.etag !== options.etag) {
    throw new PsycheError("conflict", "IDENTITY.md changed since it was read");
  }
  const parsed = parseIdentity(file?.content ?? "---\n---\n");
  const identity: Identity = { ...parsed.identity, extra: { ...parsed.identity.extra } };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(valid.fields ?? {}) as [PersonaField, string][]) {
    if (identity[key] !== value) {
      identity[key] = value;
      changed.push(key);
    }
  }
  let body = parsed.body;
  if (valid.description !== undefined) {
    // Keep the owner's guidance comments; replace the self-description itself.
    const comments = (parsed.body.match(/<!--[\s\S]*?-->/g) ?? []).join("\n\n");
    const next = `${valid.description}\n${comments.length > 0 ? `\n${comments}\n` : ""}`;
    if (next.trim() !== parsed.body.trim()) {
      body = next;
      changed.push("description");
    }
  }
  const explicitAvatar = changed.includes("avatar");
  const avatarRequested =
    !explicitAvatar && (changed.includes("creature") || changed.includes("name"));
  if (changed.length === 0) {
    const current = await readPersona(store);
    return { ...current, changed, avatarRequested: false };
  }
  const written = await store.write("IDENTITY.md", serializeIdentity(identity, body), {
    provenance: options.actor === "owner" ? "owner" : "agent",
    actor: options.actor,
    source: options.actor === "owner" ? "api" : "tool",
    ...(file === undefined ? {} : { etag: file.etag }),
    ...(options.approvalId === undefined ? {} : { approvalId: options.approvalId }),
  });
  const wire = toWire(identity);
  store.publish({
    event: "persona.updated",
    payload: { identity: wire, changed, avatarRequested },
  });
  return {
    identity: wire,
    description: body.replace(/<!--[\s\S]*?-->/g, "").trim(),
    etag: written.etag,
    changed,
    avatarRequested,
  };
}

export interface PersonaModel {
  provider: ModelProvider;
  /** Utility model (a local model is fine). */
  model: ModelRef;
}

export const PERSONA_SYSTEM_PROMPT = `You edit the persona of a personal assistant. The owner describes a change in their own words. Reply with one JSON object holding only the fields that change, chosen from:
- "name": the assistant's name
- "creature": a short visual description of the assistant's creature, used to draw its avatar
- "vibe": a few adjectives for its manner
- "tagline": a short motto
- "emoji": one emoji
- "voice": a voice id, only if the owner names one
- "description": one or two sentences in which the assistant describes itself
Keep the owner's wording where you can. Never add instructions, rules or permissions. If the request is not about the persona, reply {}.`;

/** Turns the owner's words into a `PersonaChange` with one utility-model turn. */
export async function interpretPersonaInstruction(
  model: PersonaModel,
  instruction: string,
  current: { identity: PersonaIdentity; description: string },
  signal?: AbortSignal,
): Promise<PersonaChange> {
  let reply = "";
  for await (const event of model.provider.stream(
    {
      model: model.model,
      system: PERSONA_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: `Current persona: ${JSON.stringify({ ...current.identity, description: current.description })}\n\nRequested change: ${oneLine(instruction)}`,
            },
          ],
        },
      ],
      toolChoice: "none",
      maxOutputTokens: 400,
      temperature: 0,
    },
    signal === undefined ? {} : { signal },
  )) {
    if (event.type === "text_delta") reply += event.text;
    if (event.type === "finish" && event.reason !== "stop" && event.reason !== "length") {
      throw new PsycheError("unavailable", "the persona model did not answer");
    }
  }
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (json === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PsycheError("unavailable", "the persona model's answer was not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const change: PersonaChange = {};
  const fields: Partial<Record<PersonaField, string>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (key === "description") change.description = value;
    // The model may not set the avatar asset id; that comes from the avatar renderer.
    else if ((PERSONA_FIELDS as readonly string[]).includes(key) && key !== "avatar") {
      fields[key as PersonaField] = value;
    }
  }
  if (Object.keys(fields).length > 0) change.fields = fields;
  return change;
}
