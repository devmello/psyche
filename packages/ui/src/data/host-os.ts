import { useGatewayQuery } from "./hooks.ts";

/** The Host's operating system, as the Gateway reports it (`gateway.info.hostOs`). */
export type HostOs = "macos" | "windows" | "linux";

/**
 * The OS of the computer running the Gateway (linux-helper-only design §8.4, B3): a Client of a
 * Linux Host names it in the Host's words, shows Apple connectors as "Only on a Mac host" and
 * offers computer use only on the Host's private screen. `undefined` while loading or from an
 * older Gateway that does not say, and then nothing changes.
 */
export function useHostOs(): HostOs | undefined {
  const info = useGatewayQuery("gateway.info", {});
  return info.data?.hostOs;
}

/** Apple connectors read the Host Mac's apps through its helper: none on another Host OS. */
export function appleConnectorsUnavailable(hostOs: HostOs | undefined): boolean {
  return hostOs !== undefined && hostOs !== "macos";
}
