/**
 * drizzle mirror of the skills table (owner S16, `packages/skills`); see the header of
 * `schema.ts` for the conventions.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// §10 Skills (owner S16; migrations/202610191300_skills_init.sql).

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  version: text("version"),
  path: text("path").notNull(),
  hash: text("hash"),
  trust: text("trust").notNull(),
  enabled: integer("enabled").notNull(),
  installedAt: text("installed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const s16Schema = { skills };

export type SkillRow = typeof skills.$inferSelect;
export type NewSkillRow = typeof skills.$inferInsert;
