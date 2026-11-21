/**
 * The psyche-server release gate (`deploy/scripts/check-headless-starter.mjs`, wave B0): it must
 * pass on this branch's real starter and fail on every half-built shape, which a grep for the
 * unit's name could not tell apart.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..", "..");
type Result = { ok: true; unit: string } | { ok: false; reason: string };
const gate = (await import(join(repo, "deploy/scripts/check-headless-starter.mjs"))) as {
  checkHeadlessStarter(root?: string): Promise<Result>;
};

const STARTER_OK = `
export const helperUnitFor = (g: boolean): string =>
  g ? "psyche-helper.service" : "psyche-helper-headless.service";
export async function startHelperWithSystemd(
  signal: AbortSignal | undefined,
  run: (file: string, args: string[]) => Promise<string>,
  graphical: () => Promise<boolean>,
): Promise<void> {
  await run("/usr/bin/systemctl", ["--user", "start", helperUnitFor(await graphical())]);
}
`;
const COMPOSE_OK = `const deps = {
  startHelper: (signal: AbortSignal, decided?: boolean) =>
    startHelperWithSystemd(signal, undefined, () => Promise.resolve(decided === true)),
};`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake checkout with the given files (undefined leaves one out). */
function fakeRepo(files: { unit?: boolean; starter?: string; compose?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "psyche-b0-gate-"));
  dirs.push(root);
  mkdirSync(join(root, "deploy/systemd"), { recursive: true });
  mkdirSync(join(root, "apps/gateway/src/compose"), { recursive: true });
  if (files.unit !== false) {
    writeFileSync(join(root, "deploy/systemd/psyche-helper-headless.service"), "[Service]\n");
  }
  if (files.starter !== undefined) {
    writeFileSync(join(root, "apps/gateway/src/compose/computer-linux.ts"), files.starter);
  }
  if (files.compose !== undefined) {
    writeFileSync(join(root, "apps/gateway/src/compose/computer.ts"), files.compose);
  }
  return root;
}

describe("check-headless-starter.mjs", () => {
  it("passes on this branch: the real starter starts the headless unit", async () => {
    expect(await gate.checkHeadlessStarter(repo)).toEqual({
      ok: true,
      unit: "psyche-helper-headless.service",
    });
  });

  it("passes on a complete fake checkout", async () => {
    const r = await gate.checkHeadlessStarter(
      fakeRepo({ starter: STARTER_OK, compose: COMPOSE_OK }),
    );
    expect(r.ok).toBe(true);
  });

  it.each<[string, Parameters<typeof fakeRepo>[0], RegExp]>([
    ["no unit file", { unit: false, starter: STARTER_OK, compose: COMPOSE_OK }, /is missing/],
    ["no starter module", { compose: COMPOSE_OK }, /does not load/],
    [
      "a pre-B0 starter with no unit picker",
      {
        starter: "export async function startHelperWithSystemd(): Promise<void> {}\n",
        compose: COMPOSE_OK,
      },
      /no helperUnitFor/,
    ],
    [
      "a picker that starts the graphical unit without a session",
      {
        starter: STARTER_OK.replace('"psyche-helper-headless.service"', '"psyche-helper.service"'),
        compose: COMPOSE_OK,
      },
      /picks psyche-helper.service/,
    ],
    [
      "a starter that never runs systemctl start",
      {
        starter: STARTER_OK.replace('"start"', '"status"'),
        compose: COMPOSE_OK,
      },
      /did not run systemctl/,
    ],
    [
      "a starter that runs systemctl through PATH",
      {
        starter: STARTER_OK.replace('"/usr/bin/systemctl"', '"systemctl"'),
        compose: COMPOSE_OK,
      },
      /did not run systemctl/,
    ],
    [
      "a Gateway that never hands the starter to computer use",
      {
        starter: STARTER_OK,
        compose: `// psyche-helper-headless.service\nexport const x = startHelperWithSystemd;\n`,
      },
      /does not hand startHelperWithSystemd/,
    ],
  ])("fails with %s", async (_name, files, reason) => {
    const r = await gate.checkHeadlessStarter(fakeRepo(files));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(reason);
  });

  it("is what release.yml's psyche-server job runs, after the install it needs", () => {
    const yml = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");
    const job = yml.slice(yml.indexOf("\n  server:\n"));
    const gateAt = job.indexOf("node deploy/scripts/check-headless-starter.mjs");
    expect(gateAt).toBeGreaterThan(0);
    expect(job.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(gateAt);
    expect(job).not.toMatch(/grep -q 'psyche-helper-headless/);
  });
});
