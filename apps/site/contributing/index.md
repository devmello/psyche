---
title: Contributing
---

# Contributing

Psyche is an open-source monorepo: a TypeScript Gateway, an Electron desktop app, a React web UI, a CLI, a Swift helper for macOS, and about twenty-five libraries they share. This page gets you from a fresh clone to a working setup, shows where things live, and points to the design documents that decide how things should work. The rules themselves are in [CONTRIBUTING.md](https://github.com/devmello/psyche/blob/main/CONTRIBUTING.md) and [docs/archive/prompts/_shared-rules.md](https://github.com/devmello/psyche/blob/main/docs/archive/prompts/_shared-rules.md); read both before your first pull request.

## Set up

You need Node 24 and pnpm 12. On macOS, the helper also needs Swift 6.

1. Clone the repository and enter it.
2. Use the Node version in `.nvmrc`:

   ```bash
   nvm use
   ```

3. Let Corepack pick up the pinned pnpm from `packageManager` in `package.json` (it verifies the pnpm download against a hash):

   ```bash
   corepack enable
   ```

4. Install dependencies:

   ```bash
   pnpm install
   ```

5. Check that everything compiles and passes lint:

   ```bash
   pnpm -w typecheck
   pnpm -w lint
   ```

Lint and formatting use Biome only. Fix what it reports with `pnpm lint:fix`. Tests use Vitest. Run the tests of the package you change, not the whole workspace:

```bash
pnpm --filter @psyche/permissions test
```

No test reaches the network in CI. Live tests against real model providers run only with `PSYCHE_LIVE_TESTS=1`.

## Run Psyche from source

Run the Gateway with a model:

```bash
PSYCHE_MODEL=ollama/qwen3.8:27b pnpm --filter @psyche/gateway start
```

Then, in another terminal, the desktop app:

```bash
pnpm --filter @psyche/desktop dev
```

The walking-skeleton scenario runs the real Gateway, agent loop, broker, memory and task engine against a scripted model, as CI does:

```bash
pnpm --filter @psyche/integration-tests test
```

To work on this documentation site, run `pnpm docs:dev`. Some pages are generated from `docs/guides/`, `docs/release-notes/` and the CLI's command table; edit those sources, not the generated copies.

## Repository layout

| Path | What it holds |
| --- | --- |
| `apps/gateway` | `psyched`, the Gateway: the composition root, WebSocket and HTTP API, pairing |
| `apps/desktop`, `apps/web` | The Electron shell and the React web UI it shares with the browser |
| `apps/cli` | The `psyche` command |
| `apps/mac-helper` | Psyche Helper, the Swift app for Accessibility, screenshots, Keychain, notifications, speech and VMs |
| `apps/node` | `psyche-node`, for VM guests and remote machines |
| `packages/protocol` | Schemas, the method and event registry, and the interfaces every package implements |
| `packages/*` | One library per subsystem: `agent-core`, `model-router`, `permissions`, `audit`, `vault`, `memory`, `browser`, `sandbox`, `mcp-host`, `connectors`, `channels`, `tasks`, `scheduler`, `ui`, `viewers` and others |
| `packages/testing` | In-memory fakes for every interface, fixtures, the secret-leak checker, the scenario and injection runners |
| `skills/`, `templates/` | Bundled skills, and the default persona files |
| `deploy/` | Dockerfiles, Compose, launchd and systemd files, release scripts |
| `tests/` | Integration and acceptance tests, the injection corpus, scenario fixtures |
| `apps/site` | This documentation site |
| `docs/archive/` | How Psyche was built (session prompts, plans, status logs, spikes, research); history, not current |

Each package has a README with its purpose, public API, how it maps to the design docs, and what is stubbed.

## Where design decisions live

The design is written down before it is built, and the docs win when code and docs disagree.

| Document | Answers |
| --- | --- |
| [docs/00-vision-and-principles.md](https://github.com/devmello/psyche/blob/main/docs/00-vision-and-principles.md) | What Psyche is, for whom, and what it will not do |
| [docs/02-architecture.md](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md) | Processes, the Gateway's modules, the protocol, storage |
| [docs/03-feature-spec.md](https://github.com/devmello/psyche/blob/main/docs/03-feature-spec.md) | Every feature, with an id and "done when" criteria |
| [docs/04-data-model.md](https://github.com/devmello/psyche/blob/main/docs/04-data-model.md) | Tables, file formats, approvals, receipts, audit entries |
| [docs/05-security-and-permissions.md](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md) | The security rules no change may break |
| [docs/06-ui-design.md](https://github.com/devmello/psyche/blob/main/docs/06-ui-design.md) | Screens, components, keyboard map |
| [docs/07-tech-decisions.md](https://github.com/devmello/psyche/blob/main/docs/07-tech-decisions.md) | Architecture decision records: why each technology |
| [docs/09-execution-plan.md](https://github.com/devmello/psyche/blob/main/docs/09-execution-plan.md) | Who owns which paths |

The plans, status logs and design reviews of the original build are kept in [docs/archive/](https://github.com/devmello/psyche/tree/main/docs/archive) as history. If you think a doc is wrong, say so in the pull request and follow the doc, unless it is a security problem.

## Ownership

Psyche is built by many parallel workstreams, human or agent, each owning a separate set of paths. Edit only the paths you own, listed in [docs/09 §2](https://github.com/devmello/psyche/blob/main/docs/09-execution-plan.md#2-repository-layout-and-ownership) and [.github/CODEOWNERS](https://github.com/devmello/psyche/blob/main/.github/CODEOWNERS). Code against other packages' interfaces and their fakes, never against an unmerged branch. If an interface is missing something, add it in a separate, additive `protocol:` pull request.

## Security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](https://github.com/devmello/psyche/blob/main/SECURITY.md) and use GitHub private vulnerability reporting.

## Learn more

- [Architecture](/contributing/architecture)
- [Pull requests](/contributing/pull-requests)
- [Protocol](/reference/protocol)
- [CONTRIBUTING.md](https://github.com/devmello/psyche/blob/main/CONTRIBUTING.md)
- [docs/archive/prompts/_shared-rules.md](https://github.com/devmello/psyche/blob/main/docs/archive/prompts/_shared-rules.md)
- [README.md](https://github.com/devmello/psyche/blob/main/README.md)
