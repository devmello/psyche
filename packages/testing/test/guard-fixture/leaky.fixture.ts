import { expect, it } from "vitest";
import { FakeModelProvider, fixtureSecret } from "../../src/index.ts";

it("clean turn", async () => {
  const model = FakeModelProvider.script([]);
  for await (const _ of model.stream({ model: "m", messages: [] } as never)) {
    // drain
  }
  expect(model.requests).toHaveLength(1);
});

it("leaky turn", async () => {
  const model = FakeModelProvider.script([]);
  const request = {
    model: "m",
    messages: [{ text: `pw ${fixtureSecret("mail-login", "password")}` }],
  };
  for await (const _ of model.stream(request as never)) {
    // drain
  }
});
