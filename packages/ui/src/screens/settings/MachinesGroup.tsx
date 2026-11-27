import type { MachineInfo } from "@psyche/protocol";
import { useGatewayQuery } from "../../data/hooks.ts";

/** `machines.list` for Settings: the paired computers the Computer use picker reads. */
export function useMachines(): { machines: MachineInfo[]; loading: boolean; error: string | null } {
  const q = useGatewayQuery("machines.list", {});
  return { machines: q.data?.machines ?? [], loading: q.loading, error: q.error };
}
