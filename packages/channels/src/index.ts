import { NotImplementedError, type ChannelAdapter } from "@psyche/protocol";

/**
 * Placeholder for the `ChannelAdapter` implementation owned by S10.
 * Build against `FakeChannelAdapter` from `@psyche/testing` until this lands.
 */
export function createChannelAdapter(): ChannelAdapter {
  throw new NotImplementedError("@psyche/channels", "createChannelAdapter");
}
