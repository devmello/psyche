import { describe, expect, it } from "vitest";
import { parseSendGrantKey } from "../src/lib/send-grant.ts";

/** Real grant keys arrive namespaced by the tool, and an account may itself contain ":". */
describe("parseSendGrantKey", () => {
  it("reads a plain key", () => {
    expect(parseSendGrantKey("send_email:me@example.com:a@x.com,b@y.com")).toEqual({
      account: "me@example.com",
      recipients: ["a@x.com", "b@y.com"],
    });
  });

  it("reads a key namespaced by the tool, as the loop sends it", () => {
    expect(
      parseSendGrantKey("mcp__gmail__gmail_send|send_email:me@example.com:jane@example.com"),
    ).toEqual({ account: "me@example.com", recipients: ["jane@example.com"] });
  });

  it("keeps an Apple Mail account whole (it contains a colon)", () => {
    expect(parseSendGrantKey("send_email:apple-mail:conn_1:jane@example.com")).toEqual({
      account: "apple-mail:conn_1",
      recipients: ["jane@example.com"],
    });
    expect(
      parseSendGrantKey("apple_mail_send|send_email:apple-mail:conn_1:a@x.com,b@y.com"),
    ).toEqual({ account: "apple-mail:conn_1", recipients: ["a@x.com", "b@y.com"] });
  });

  it("returns null for other keys and malformed ones", () => {
    expect(parseSendGrantKey("connector_action:gmail:label")).toBeNull();
    expect(parseSendGrantKey("tool|connector_action:send_email:x")).toBeNull();
    expect(parseSendGrantKey("send_email:")).toBeNull();
    expect(parseSendGrantKey("send_email:me@example.com:")).toBeNull();
  });
});
