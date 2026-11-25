import type { ChannelCapabilities } from "@psyche/protocol";

/**
 * What the agent may be told about a chat channel, derived from the one place an adapter declares
 * what it can send (`capabilities()`), so the words never drift from the adapter. A channel that
 * cannot send files says so and says not to offer them (the send itself would fail with
 * `not_implemented`).
 */
export function channelCapabilityText(
  label: string,
  caps: Pick<ChannelCapabilities, "attachments" | "voiceNotes">,
): string {
  const lines: string[] = [];
  lines.push(
    caps.attachments
      ? `${label}: files and images can be sent.`
      : `${label}: only text can be sent. Files and images are not sent here, so do not offer to attach or send one.`,
  );
  if (!caps.voiceNotes) lines.push(`${label}: voice notes are not sent.`);
  return lines.join(" ");
}
