# Changesets

Every PR that changes a package's behavior adds a changeset: `pnpm changeset`, pick the packages, write one line a user would understand. Protocol changes always get one (see `packages/protocol/CHANGES.md`). Releases are cut by the integrator with `pnpm changeset version`.
