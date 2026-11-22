import { describe, expect, it } from "vitest";
import { ContainerSandboxRunner } from "../src/runner.ts";
import { FakeDriver } from "./fake-driver.ts";

/**
 * #1435 review r3: "Keep it" stops a repository's sandboxes, including one left by an earlier
 * Gateway process that this one has not adopted yet; the workspace volume stays.
 */
function setup() {
  const driver = new FakeDriver();
  driver.respond = (args: string[]) =>
    args[0] === "inspect" || (args[0] === "volume" && args[1] === "inspect")
      ? { exitCode: 1 }
      : undefined;
  const runner = new ContainerSandboxRunner({
    driver,
    detect: async () => [{ kind: "docker", cli: "/usr/bin/docker", version: "29" }],
    image: "psyche-sandbox:core-dev",
    idleTimeoutMs: 0,
  });
  return { driver, runner };
}

const scope = { kind: "project" as const, id: "cw_abc" };

describe("destroyScope", () => {
  it("removes the container of a scope this process never adopted, by its name", async () => {
    const { driver, runner } = setup();
    // The name an earlier process gave it: what ensureSandbox would make.
    const other = setup();
    await other.runner.ensureSandbox(scope);
    const name = other.driver.calls
      .map((c) => c.args)
      .find((a) => a[0] === "run" || a[0] === "create")
      ?.find((_a, i, all) => all[i - 1] === "--name");
    expect(name).toMatch(/-sbx-/);

    await runner.destroyScope(scope);
    const removals = driver.calls.filter((c) => c.args[0] === "rm");
    expect(removals).toHaveLength(1);
    expect(removals[0]?.args).toContain(name);
    // The volume stays.
    expect(driver.calls.some((c) => c.args[0] === "volume" && c.args[1] === "rm")).toBe(false);
  });

  it("destroys an adopted sandbox through its entry", async () => {
    const { driver, runner } = setup();
    await runner.ensureSandbox(scope);
    await runner.destroyScope(scope);
    expect(driver.calls.filter((c) => c.args[0] === "rm")).toHaveLength(1);
  });
});
