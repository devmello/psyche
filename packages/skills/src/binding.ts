import { bindingFor, type SkillInstallBindingArgs } from "@psyche/permissions";

/**
 * `skill_install` binding (security §3.5, data model §4.2): the Permission Broker's own table, so
 * the hash the card carries and the one `install` verifies cannot drift. It covers the name,
 * scope, source, pinned commit, whole-tree hash and the declared tools, approval kinds and prompt
 * files; the grant key is `{name, scope}` (`skill_install` is `once`-only, so no grant is stored).
 */
export function skillInstallBinding(args: SkillInstallBindingArgs): {
  bindingHash: `sha256:${string}`;
  grantKey: string;
} {
  const b = bindingFor("skill_install", args);
  return { bindingHash: b.bindingHash as `sha256:${string}`, grantKey: b.grantKey };
}
