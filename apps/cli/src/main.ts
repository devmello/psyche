#!/usr/bin/env node
import { run } from "./cli.ts";

// `psyche` entry point (bin). Exit codes are documented in apps/cli/README.md.
process.exitCode = await run(process.argv.slice(2));
