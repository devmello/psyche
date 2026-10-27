import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/** `sandbox.*`: read-only status of per-task containers (architecture §9). */

export const SandboxBackend = StringEnum(["apple-container", "docker", "podman", "none"], {
  $id: "SandboxBackend",
});
export type SandboxBackend = Static<typeof SandboxBackend>;

export const SandboxInfo = Type.Object(
  {
    id: Id,
    threadId: Nullable(Id),
    taskId: Nullable(Id),
    status: StringEnum(["creating", "running", "stopped", "error"], { $id: "SandboxStatus" }),
    image: Type.String(),
    network: StringEnum(["none", "proxy"], { $id: "SandboxNetwork" }),
    createdAt: IsoDateTime,
    lastUsedAt: Nullable(IsoDateTime),
  },
  { $id: "SandboxInfo" },
);
export type SandboxInfo = Static<typeof SandboxInfo>;

export const SandboxContainerBackend = StringEnum(["apple-container", "docker", "podman"], {
  $id: "SandboxContainerBackend",
});
export type SandboxContainerBackend = Static<typeof SandboxContainerBackend>;

/**
 * `srt` (Anthropic's sandbox-runtime, Seatbelt on macOS): how host commands run sandboxed with
 * no VM. Found from `PSYCHE_SRT_PATH`, the `exec.srtPath` setting, or PATH and the usual folders.
 */
export const SandboxSrtStatus = Type.Object(
  {
    available: Type.Boolean(),
    path: Nullable(Type.String()),
    source: Nullable(StringEnum(["env", "setting", "detected"], { $id: "SandboxSrtSource" })),
    version: Nullable(Type.String()),
    problem: Nullable(
      StringEnum(["not_found", "not_absolute", "not_executable"], { $id: "SandboxSrtProblem" }),
    ),
  },
  { $id: "SandboxSrtStatus" },
);
export type SandboxSrtStatus = Static<typeof SandboxSrtStatus>;

/** One container runtime as the guided setup sees it. */
export const SandboxSetupBackend = Type.Object(
  {
    kind: SandboxContainerBackend,
    supported: Type.Boolean({
      description: "This Mac can use it (Apple container needs macOS 26 on Apple silicon)",
    }),
    installed: Type.Boolean(),
    running: Type.Boolean({ description: "It answers now, so a sandbox could start on it" }),
    version: Nullable(Type.String()),
  },
  { $id: "SandboxSetupBackend" },
);
export type SandboxSetupBackend = Static<typeof SandboxSetupBackend>;

/** The optional container runtimes (stronger isolation: a Linux VM per sandbox). */
export const SandboxContainerSetup = Type.Object(
  {
    recommended: SandboxContainerBackend,
    backends: Type.Array(SandboxSetupBackend),
    ready: Type.Boolean({ description: "A runtime is running now (detected fresh, not at boot)" }),
    active: SandboxBackend,
    restartNeeded: Type.Boolean({
      description: "A runtime is running but this Gateway started without one: restart it",
    }),
  },
  { $id: "SandboxContainerSetup" },
);
export type SandboxContainerSetup = Static<typeof SandboxContainerSetup>;

export const SandboxMethods = {
  "sandbox.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ sandboxes: Type.Array(SandboxInfo) }),
    scope: "operator.read",
    description: "Lists sandboxes.",
  }),
  "sandbox.status": defineMethod({
    params: Type.Object({ sandboxId: Type.Optional(Id) }),
    result: Type.Object({
      backend: SandboxBackend,
      available: Type.Boolean({
        description: "false → exec reports an error; there is never a host fallback",
      }),
      sandbox: Nullable(SandboxInfo),
      /** The host egress proxy for `network: "proxy"` sandboxes is running (security §5.2, K4). */
      egress: Type.Optional(Type.Boolean()),
      /** `srt` for host commands (stdio MCP servers, host exec), looked up now. */
      srt: Type.Optional(SandboxSrtStatus),
    }),
    scope: "operator.read",
    description: "Reports the container backend and, with sandboxId, one sandbox's state.",
  }),
  "sandbox.setup": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      ready: Type.Boolean({ description: "srt is available, so command servers can run" }),
      srt: SandboxSrtStatus,
      containers: SandboxContainerSetup,
    }),
    scope: "operator.read",
    description:
      "Looks again for the sandboxes on this computer, for the guided setup: srt first (Seatbelt, commands run on the Mac without reading Psyche's private data), then the optional container runtimes (supported, installed, running, recommended, restart needed). Never installs or starts anything.",
  }),
} as const;
