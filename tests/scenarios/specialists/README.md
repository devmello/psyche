# Specialist delegation eval

`delegation.json` holds 30 scripted owner requests, each labelled with the specialist role the
main agent should delegate to (`researcher`, `shopper`, `coder`, `organizer`, `writer`,
`planner`) or `null` when the job belongs in the thread (docs/agent/specialists-2026.md §4.8:
quick answers, back-and-forth, and anything whose main risk is a send, a payment or a delete).

`packages/skills/test/delegation-eval.test.ts` scores it offline, without a model: a fixture
delegator applies the §4.8 "don't delegate" rules and then matches each request against the
`description` line of the bundled `specialist-*` skills, the same text the main agent reads.
The bar is **26 of 30**. It checks that the role descriptions are distinct enough to route
on and that the rules are written down; how a real model delegates is measured by the live
acceptance driver.

This folder has no `scenario.json`, so the scenario runner and `validate.mjs` only scan it for
secrets.
