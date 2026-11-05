import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { expect } from "vitest";
import { type BundleSigningKey, keyIdOf } from "../src/bundle.ts";
import type { FsSkillLoader } from "../src/loader.ts";
import { type SkillTree, TreeBuilder } from "../src/tree.ts";
import { approve, setup, skillMd, writeSkill } from "./helpers.ts";

/** Shared helpers for the shared-bundles tests. */

export const NOW = new Date("2026-11-04T12:00:00Z");
export const SKILL = (name: string, fm = "") => skillMd(name, { frontmatter: fm });
const enc = (s: string) => new TextEncoder().encode(s);

export async function rejects(p: Promise<unknown> | (() => unknown)): Promise<PsycheError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(PsycheError);
    return e as PsycheError;
  }
  throw new Error("expected a rejection");
}

export function authorKey(name: string): BundleSigningKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = privateKey.export({ format: "jwk" }).x as string;
  return {
    author: { name, keyId: keyIdOf(x), publicKey: x },
    sign: (data) => sign(null, data, privateKey).toString("base64url"),
  };
}

export function treeOf(files: Record<string, string>): SkillTree {
  const b = new TreeBuilder();
  for (const [p, t] of Object.entries(files)) b.add(p, enc(t));
  return b.tree;
}

export const simple = (name = "tidy", fm = "", extra = "Extra.\n") =>
  treeOf({ "SKILL.md": SKILL(name, fm), "notes/extra.md": extra });

export async function exportOf(loader: FsSkillLoader, name: string, author?: string) {
  return loader.exportSkill(name, author, loader.previewExport(name).treeHash);
}

type Make = ReturnType<typeof setup>["make"];

/** An owner who made and approved a workspace skill `tidy`, with an author key home. */
export async function owner(extra: Parameters<Make>[0] = {}) {
  const a = setup();
  const psycheHome = join(a.base, "home");
  const loader = a.make({ psycheHome, ...extra });
  writeSkill(a.workspaceDir, "tidy", { files: { "notes/extra.md": "Extra.\n" } });
  const p = await loader.proposeWorkspaceApproval("tidy");
  await loader.install(p.id, await approve(a.broker, a.clock, p));
  return { ...a, loader, psycheHome };
}

/** A second Mac to import on. */
export function importer(extra: Parameters<Make>[0] = {}) {
  const b = setup();
  const psycheHome = join(b.base, "home");
  return { ...b, psycheHome, loader: b.make({ psycheHome, ...extra }) };
}
