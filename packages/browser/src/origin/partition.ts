import {
  canonicalizeUrl,
  matchesPattern,
  type OriginPattern,
  parseOriginPattern,
} from "./canonical.ts";

/**
 * Which partition a tab opens in (feature I15; security §6 "Logged-out default"; architecture
 * §8 "Session choice and consent"). A task states its mode explicitly:
 *
 * - `profile`: every tab uses the persistent agent profile (the owner's sign-ins);
 * - `clean`: every tab uses an ephemeral partition ("browse without my sign-ins");
 * - `auto` (the default): a tab uses the profile only when its first origin is one the owner
 *   has signed into (`signedInOrigins`); every other tab, and every blank tab, is `clean`.
 *
 * The choice is per task and per tab, never remembered across tasks, and the pane shows it
 * (`bridge.tab.open {profile}`). Popups inherit the opener's partition, since an OAuth window
 * belongs to the flow that opened it.
 */
export type TabPartition = "profile" | "clean";

export type PartitionMode = TabPartition | "auto";

export interface PartitionPolicy {
  mode: PartitionMode;
  /** Origin patterns (`https://github.com`, `https://*.google.com`) the owner signed into. */
  signedInOrigins?: string[];
}

export type PartitionReason =
  | "task_profile"
  | "task_clean"
  | "signed_in"
  | "not_signed_in"
  | "no_url";

export interface PartitionChoice {
  partition: TabPartition;
  reason: PartitionReason;
  /** The pane's indicator text, in the owner's words. */
  label: string;
}

const LABELS: Record<PartitionReason, string> = {
  task_profile: "Using your sign-ins",
  task_clean: "Browsing without your sign-ins",
  signed_in: "Using your sign-in for this site",
  not_signed_in: "Browsing without your sign-ins",
  no_url: "Browsing without your sign-ins",
};

export class PartitionChooser {
  readonly mode: PartitionMode;
  #signedIn: OriginPattern[];

  constructor(policy: PartitionPolicy = { mode: "auto" }) {
    this.mode = policy.mode;
    this.#signedIn = (policy.signedInOrigins ?? []).map(parseOriginPattern);
  }

  /** The session's default, what a tab gets before any URL is known. */
  get defaultPartition(): TabPartition {
    return this.mode === "profile" ? "profile" : "clean";
  }

  /** True when the owner has signed into this URL's origin (profile mode or a match). */
  isSignedIn(url: string): boolean {
    let u: ReturnType<typeof canonicalizeUrl>;
    try {
      u = canonicalizeUrl(url);
    } catch {
      return false;
    }
    return this.#signedIn.some((p) => matchesPattern(u, p));
  }

  choose(url: string | undefined): PartitionChoice {
    if (this.mode === "profile") return pick("profile", "task_profile");
    if (this.mode === "clean") return pick("clean", "task_clean");
    if (url === undefined) return pick("clean", "no_url");
    return this.isSignedIn(url) ? pick("profile", "signed_in") : pick("clean", "not_signed_in");
  }
}

function pick(partition: TabPartition, reason: PartitionReason): PartitionChoice {
  return { partition, reason, label: LABELS[reason] };
}

/** One-shot form of `PartitionChooser.choose`. */
export function choosePartition(
  url: string | undefined,
  policy: PartitionPolicy = { mode: "auto" },
): PartitionChoice {
  return new PartitionChooser(policy).choose(url);
}
