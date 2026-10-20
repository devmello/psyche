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
} as const;
