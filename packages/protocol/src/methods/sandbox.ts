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
    }),
    scope: "operator.read",
    description: "Reports the container backend and, with sandboxId, one sandbox's state.",
  }),
  "sandbox.setup": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      recommended: SandboxContainerBackend,
      backends: Type.Array(SandboxSetupBackend),
      ready: Type.Boolean({
        description: "A runtime is running now (detected fresh, not at boot)",
      }),
      active: SandboxBackend,
      restartNeeded: Type.Boolean({
        description: "A runtime is running but this Gateway started without one: restart it",
      }),
    }),
    scope: "operator.read",
    description:
      "Looks at the container runtimes on this computer again, for the guided sandbox setup: which are supported, installed and running, which one to install, and whether the Gateway must restart to use one. Never installs or starts anything.",
  }),
} as const;
