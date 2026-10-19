// `pnpm sandbox:smoke`: run the container smoke test against a real backend and print a table.
//   --backend apple-container|docker|podman   default: detected (see detect.ts)
//   --variant core|base|full                  image target, default core
//   --image <ref>                             use this image instead of the local dev tag
//   --build                                   build the image target first
//   --build-only                              build and exit (`pnpm sandbox:build`)
//   --keep                                    keep the smoke workspace volume afterwards
import { parseArgs } from "node:util";
import {
  buildImage,
  type ContainerBackendKind,
  ContainerSandboxRunner,
  type ImageVariant,
  parseBackendOverride,
} from "../src/index.ts";
import { SMOKE_CHECKS } from "../src/smoke.ts";

const { values } = parseArgs({
  options: {
    backend: { type: "string" },
    variant: { type: "string", default: "core" },
    image: { type: "string" },
    build: { type: "boolean", default: false },
    "build-only": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});

const variant = values.variant as ImageVariant;
if (!["core", "base", "full"].includes(variant)) throw new Error(`unknown variant ${variant}`);
const backendKind: ContainerBackendKind | undefined = parseBackendOverride(values.backend);
const maxConcurrentExecs = 2;
const runner = new ContainerSandboxRunner({
  ...(backendKind === undefined ? {} : { backend: backendKind }),
  ...(values.image === undefined ? {} : { image: values.image }),
  variant,
  namePrefix: "psyche-smoke",
  maxConcurrentExecs,
  idleTimeoutMs: 0,
});

const backend = await runner.backend();
if (!backend) {
  console.error(
    "No sandbox backend found (Apple container on macOS 26+, Docker, or Podman). Nothing ran; there is no host fallback.",
  );
  process.exit(2);
}
console.error(`backend: ${backend.kind} ${backend.version} (${backend.cli})`);

if ((values.build || values["build-only"]) && values.image === undefined) {
  console.error(`building image target ${variant}…`);
  const built = await buildImage(backend, variant);
  console.error(`built ${built.tag} in ${built.durationMs} ms`);
  if (values["build-only"]) process.exit(0);
}

const scope = { kind: "task" as const, id: `smoke-${Date.now()}` };
const timings: [string, number][] = [];
const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  const out = await fn();
  timings.push([label, Math.round(performance.now() - started)]);
  return out;
};
const echo = (sandboxId: string) =>
  runner.exec({ sandboxId, argv: ["true"], cwd: "/workspace", timeoutMs: 10_000 });

let failures = 0;
const rows: string[] = [];
try {
  const sbx = await time("cold: new volume + container + first exec", async () => {
    const s = await runner.ensureSandbox(scope);
    await echo(s.id);
    return s;
  });
  await time("warm: exec round trip (true)", () => echo(sbx.id));
  await runner.stop(sbx.id);
  await time("restart: start stopped container + exec", () => echo(sbx.id));
  await runner.destroy(sbx.id);
  const again = await time("recreate: new container on existing volume + exec", async () => {
    const s = await runner.ensureSandbox(scope);
    await echo(s.id);
    return s;
  });

  const ctx = { runner, sandboxId: again.id, scope, maxConcurrentExecs };
  for (const check of SMOKE_CHECKS) {
    try {
      const detail = await check.run(ctx);
      rows.push(`| ${check.name} | PASS | ${detail} |`);
    } catch (e) {
      failures += 1;
      const message = e instanceof Error ? e.message : String(e);
      rows.push(`| ${check.name} | FAIL | ${message.replaceAll("\n", " ").slice(0, 300)} |`);
    }
  }
} finally {
  if (values.keep) await runner.dispose({ remove: true });
  else {
    await runner.deleteWorkspace(scope).catch((e: unknown) => console.error(String(e)));
    await runner.dispose({ remove: true });
  }
}

const out = [
  `# Sandbox smoke: ${backend.kind} ${backend.version}, image target ${variant}`,
  "",
  "| metric | ms |",
  "|---|---|",
  ...timings.map(([k, v]) => `| ${k} | ${v} |`),
  "",
  "| check | result | detail |",
  "|---|---|---|",
  ...rows,
  "",
  `Failures: ${failures}`,
];
process.stdout.write(`${out.join("\n")}\n`);
process.exit(failures === 0 ? 0 : 1);
