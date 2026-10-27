import type { SandboxBackendKind } from "@psyche/protocol";
import {
  DEFAULT_APPLE_VOLUME_SIZE,
  SANDBOX_GID,
  SANDBOX_UID,
  type SandboxLimits,
  WORKSPACE_PATH,
} from "./limits.ts";

/**
 * Pure argv builders for each container CLI. The flags are the ones spike 02 verified against
 * the contract on Apple `container` 1.5.0 and Docker 29.4 (docs/archive/spikes/sandbox-backends/lib.sh).
 * Podman takes Docker's flags; it was not available on the spike machine.
 */

export type ContainerBackendKind = Exclude<SandboxBackendKind, "fake" | "vm">;

export const CONTAINER_BACKENDS: readonly ContainerBackendKind[] = [
  "apple-container",
  "docker",
  "podman",
];

export const DEFAULT_CLI: Record<ContainerBackendKind, string> = {
  "apple-container": "container",
  docker: "docker",
  podman: "podman",
};

/** Bumped when the run flags change, so containers made by older code are recreated. */
export const CONTRACT_VERSION = "1";

export const LABEL_PREFIX = "dev.psyche.sandbox";

export interface RunSpec {
  name: string;
  image: string;
  volume: string;
  /** `"none"` or a backend network name (the egress proxy's internal network). */
  network: string;
  limits: SandboxLimits;
  labels: Record<string, string>;
  /**
   * Container-level env (proxy settings). Passed by name; the caller spawns the CLI with these
   * values in its environment. Secrets never go here; they travel per exec over stdin.
   */
  env: Record<string, string>;
  /** Host folders bind-mounted under `/workspace` (V10), validated by `validateMounts`. */
  mounts?: readonly { source: string; target: string; readOnly: boolean }[];
}

/** `--mount type=bind,…` per mount, parents before children (read-only `.git` over its repo). */
function mountFlags(spec: RunSpec): string[] {
  return (spec.mounts ?? []).flatMap((m) => [
    "--mount",
    `type=bind,source=${m.source},target=${m.target}${m.readOnly ? ",readonly" : ""}`,
  ]);
}

function labelFlags(flag: string, labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([k, v]) => [flag, `${k}=${v}`]);
}

/**
 * Names only: the CLI inherits each value from its own environment (both Docker and Apple
 * accept `-e KEY`), so values such as a proxy URL with a per-task token stay out of host argv.
 */
function envFlags(env: Record<string, string>): string[] {
  return Object.keys(env).flatMap((k) => ["-e", k]);
}

/** `run -d …` for a per-scope container that idles on `sleep infinity` under an init. */
export function runArgs(kind: ContainerBackendKind, spec: RunSpec): string[] {
  const { limits } = spec;
  if (kind === "apple-container") {
    // No --pids-limit: RLIMIT_NPROC for UID 1000 is equivalent because nothing else runs as
    // that UID inside the per-container VM. No no-new-privileges flag: the image has no
    // setuid/setgid binaries (deploy/sandbox-image/harden.sh) and the bounding set is empty.
    return [
      "run",
      "--detach",
      "--name",
      spec.name,
      "--init",
      "--progress",
      "none",
      "--network",
      spec.network,
      ...(spec.network === "none" ? [] : ["--no-dns"]),
      "--read-only",
      "--cap-drop",
      "ALL",
      "--uid",
      String(SANDBOX_UID),
      "--gid",
      String(SANDBOX_GID),
      "--memory",
      `${limits.memoryMb}M`,
      "--cpus",
      String(limits.cpus),
      "--ulimit",
      `nproc=${limits.pids}:${limits.pids}`,
      "--tmpfs",
      `/tmp:size=${limits.tmpMb}m`,
      "--volume",
      `${spec.volume}:${WORKSPACE_PATH}`,
      ...mountFlags(spec),
      "--workdir",
      WORKSPACE_PATH,
      ...labelFlags("--label", spec.labels),
      ...envFlags(spec.env),
      spec.image,
      "sleep",
      "infinity",
    ];
  }
  return [
    "run",
    "--detach",
    "--name",
    spec.name,
    "--init",
    "--network",
    spec.network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${SANDBOX_UID}:${SANDBOX_GID}`,
    "--memory",
    `${limits.memoryMb}m`,
    "--memory-swap",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(limits.pids),
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${limits.tmpMb}m`,
    "--mount",
    `type=volume,source=${spec.volume},target=${WORKSPACE_PATH}`,
    ...mountFlags(spec),
    "--workdir",
    WORKSPACE_PATH,
    ...labelFlags("--label", spec.labels),
    ...envFlags(spec.env),
    spec.image,
    "sleep",
    "infinity",
  ];
}

/** `exec -i` as UID 1000 in `cwd`; the caller appends the in-container argv. */
export function execArgs(
  kind: ContainerBackendKind,
  name: string,
  cwd: string,
  argv: readonly string[],
): string[] {
  const user =
    kind === "apple-container"
      ? ["--uid", String(SANDBOX_UID), "--gid", String(SANDBOX_GID)]
      : ["--user", `${SANDBOX_UID}:${SANDBOX_GID}`];
  return ["exec", "--interactive", ...user, "--workdir", cwd, name, ...argv];
}

export function startArgs(_kind: ContainerBackendKind, name: string): string[] {
  return ["start", name];
}

export function stopArgs(_kind: ContainerBackendKind, name: string): string[] {
  return ["stop", "-t", "2", name];
}

export function removeArgs(kind: ContainerBackendKind, name: string): string[] {
  return kind === "apple-container" ? ["delete", "--force", name] : ["rm", "--force", name];
}

export function inspectArgs(_kind: ContainerBackendKind, name: string): string[] {
  return ["inspect", name];
}

export function imageInspectArgs(_kind: ContainerBackendKind, image: string): string[] {
  return ["image", "inspect", image];
}

export function volumeInspectArgs(_kind: ContainerBackendKind, volume: string): string[] {
  return ["volume", "inspect", volume];
}

export function volumeCreateArgs(
  kind: ContainerBackendKind,
  volume: string,
  labels: Record<string, string>,
  appleSize = DEFAULT_APPLE_VOLUME_SIZE,
): string[] {
  if (kind === "apple-container") {
    return ["volume", "create", "-s", appleSize, ...labelFlags("--label", labels), volume];
  }
  return ["volume", "create", ...labelFlags("--label", labels), volume];
}

export function volumeRemoveArgs(kind: ContainerBackendKind, volume: string): string[] {
  return kind === "apple-container" ? ["volume", "delete", volume] : ["volume", "rm", volume];
}

/**
 * Apple volumes are ext4 images whose root comes up root:root, so a one-shot container hands
 * `/workspace` to UID 1000. It runs a fixed argv (`chown`), no shell, with no network.
 * Docker and Podman copy the image's `/workspace` ownership into a new named volume instead.
 */
export function volumeInitArgs(
  kind: ContainerBackendKind,
  volume: string,
  image: string,
): string[] | null {
  if (kind !== "apple-container") return null;
  return [
    "run",
    "--rm",
    "--progress",
    "none",
    "--network",
    "none",
    "--uid",
    "0",
    "--gid",
    "0",
    "--volume",
    `${volume}:${WORKSPACE_PATH}`,
    image,
    "/usr/bin/chown",
    `${SANDBOX_UID}:${SANDBOX_GID}`,
    WORKSPACE_PATH,
  ];
}

export function buildArgs(
  _kind: ContainerBackendKind,
  contextDir: string,
  tag: string,
  target: string,
): string[] {
  return ["build", "--target", target, "--tag", tag, contextDir];
}

export interface ContainerState {
  running: boolean;
  labels: Record<string, string>;
}

/** Parses `inspect` JSON from any backend: Docker/Podman `State`/`Config`, Apple `status`. */
export function parseInspect(kind: ContainerBackendKind, json: string): ContainerState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof first !== "object" || first === null) return null;
  const rec = first as Record<string, unknown>;
  if (kind === "apple-container") {
    const status = rec.status as { state?: unknown } | undefined;
    const config = rec.configuration as { labels?: unknown } | undefined;
    return {
      running: status?.state === "running",
      labels: stringRecord(config?.labels),
    };
  }
  const state = rec.State as { Running?: unknown } | undefined;
  const config = rec.Config as { Labels?: unknown } | undefined;
  return { running: state?.Running === true, labels: stringRecord(config?.Labels) };
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}
