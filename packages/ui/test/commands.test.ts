import { describe, expect, it } from "vitest";
import { COMMANDS, completion, matchCommands, parseCommand } from "../src/chat/commands.ts";

describe("composer commands (C9)", () => {
  it("lists every command the spec names", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "model",
      "new",
      "btw",
      "fork",
      "schedule",
      "incognito",
      "forget",
      "remember",
      "teach",
      "plan",
      "status",
      "export",
      "stop",
    ]);
  });

  it("parses commands, messages and the // escape", () => {
    expect(parseCommand("/remember I prefer aisle seats")).toEqual({
      type: "command",
      name: "remember",
      arg: "I prefer aisle seats",
    });
    expect(parseCommand("/model anthropic/claude-sonnet-5-5")).toMatchObject({
      arg: "anthropic/claude-sonnet-5-5",
    });
    expect(parseCommand("/export json")).toMatchObject({ type: "command", name: "export" });
    expect(parseCommand("hello /new")).toEqual({ type: "message", text: "hello /new" });
    expect(parseCommand("//new is a word")).toEqual({ type: "message", text: "/new is a word" });
  });

  it("explains usage errors instead of sending them", () => {
    expect(parseCommand("/frobnicate")).toMatchObject({ type: "error" });
    expect(parseCommand("/remember")).toMatchObject({
      type: "error",
      message: "Usage: /remember <fact>",
    });
    expect(parseCommand("/stop now")).toMatchObject({ type: "error" });
    expect(parseCommand("/model gpt")).toMatchObject({ type: "error" });
    expect(parseCommand("/export pdf")).toMatchObject({ type: "error" });
  });

  it("matches a partial name and completes with a space only when an argument follows", () => {
    expect(matchCommands("/").length).toBe(13);
    expect(matchCommands("/f").map((c) => c.name)).toEqual(["fork", "forget"]);
    expect(matchCommands("/f x")).toEqual([]);
    expect(matchCommands("hi")).toEqual([]);
    const byName = (n: string) => COMMANDS.find((c) => c.name === n);
    expect(completion(byName("status") as never)).toBe("/status");
    expect(completion(byName("remember") as never)).toBe("/remember ");
  });
});
