# Product

<!-- impeccable:product-schema 1 -->

Scope: the public documentation site for Psyche (`apps/site`, published at https://devmello.github.io/psyche/). Product facts come from the repository's `README.md` and `docs/`; where this file and those disagree, the docs win.

## Platform

web

## Users

- **Primary: owners.** One person (or a household that trusts each other) who wants an always-available agent with real access to their life (mail, messages, calendar, files, people, work) and wants that access kept on hardware they control. On the site they are deciding whether Psyche is worth trying and whether they can trust it.
- **Secondary: developers.** People who build it from source today, extend it with skills, connectors and channels, or run the Gateway on their own Linux server.

Owners first, developers second (confirmed 2026-11-04).

## Product Purpose

Psyche is an open-source, local-first personal AI agent for the Mac: one ongoing conversation with a named agent that remembers you in files you can read, answers with the sources it used, does real work (browser, mail, files, tasks), and asks before anything that changes something. The site explains what it is, how to install it, how to use it and how it keeps the owner safe.

## Positioning

Your agent lives on your machine. Memory is plain files (`MEMORY.md`, `SOUL.md`, `USER.md`) you can open in Finder; every answer cites its evidence; every change goes through a Permission Broker whose approval cards bind the exact action, and content from the web or files can never approve anything; every external write leaves a receipt; secrets live in a vault the model never sees; any model, including local ones. The README calls it an open-source take on Meta's Muse; the landing page may say so once, low on the page (confirmed 2026-11-04).

## Operating Context

- Status: alpha (v0.3). The macOS desktop app is built from source; there is no signed release yet. Windows is planned. Linux runs the Gateway (server mode) only.
- Install today: `pnpm install && pnpm app:ship` from a clone.
- Surfaces in the app: Search (⌘K), Chat, Home (needs you, catch-up, today's brief), Library, Memory (people, projects, work). Approvals, the agent sheet, Screen Ask.
- The site is VitePress 2 on GitHub Pages under the `/psyche/` base path.

## Capabilities and Constraints

- Real today (per README): chat with artifacts and side chats, Screen Ask, on-device Search, connectors (Apple Notes, Reminders, Calendar, Mail via the Mac helper; Gmail and Google Calendar with your own OAuth client; MCP), Permission Broker and approval cards with receipts, browser you can take over, no-network command sandbox, encrypted vault, voice dictation (speech to text only; Psyche does not speak back), model choice (Anthropic, OpenAI, Ollama and other OpenAI-compatible providers).
- Still being finished or planned: the Feed, background specialists, meeting capture, mail and meeting workflows, Windows, signed releases.
- Primary call to action while unsigned: the GitHub repository (star/watch); "Get started" (build from source) is secondary (confirmed 2026-11-04).

## Brand Commitments

- Name: Psyche. The agent in fixtures is "Wren".
- The app's "ink" direction is binding for the site: ink blue `#2c5aa0` accent on near-neutral paper grays, amber means "needs you", one accent per view, page titles in the system display serif (New York), no sparkles for AI. The landing page may go bolder within that family.
- Voice: plain, specific, honest about limits. Docs pages carry a "Limits today" section.

## Evidence on Hand

- Real UI rendered on fictional fixture data: the UI kit's Storybook stories (`packages/ui/src/**/*.stories.tsx`, data in `packages/ui/src/fixtures` and `packages/ui/src/data`), with committed visual baselines in `packages/ui/visual/__screenshots__`.
- Absent and never to be fabricated: testimonials, user or download counts, press logos, benchmarks, pricing, a signed release, features the docs mark as planned.

## Product Principles

1. Show the product working, on fictional data, rather than describing it.
2. Every claim matches the docs and says what works today.
3. Trust is the product: local data, cited answers, approvals and receipts lead.
4. Quiet confidence over hype: one accent, plain words.

## Accessibility & Inclusion

WCAG AA contrast; full keyboard and screen-reader access; `prefers-reduced-motion` gets static fallbacks for 3D and video; works at phone width with no horizontal scroll.
