import { NotImplementedError, type SkillLoader } from "@psyche/protocol";

/**
 * Placeholder for the `SkillLoader` implementation owned by S16.
 * Build against `FakeSkillLoader` from `@psyche/testing` until this lands.
 */
export function createSkillLoader(): SkillLoader {
  throw new NotImplementedError("@psyche/skills", "createSkillLoader");
}
