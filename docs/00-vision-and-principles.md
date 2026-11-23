# Psyche — Vision and Principles

Status: draft v0.1 (2026-10-18)

## The one-paragraph version

Psyche is a personal AI agent you own. It lives on your Mac (or in a Mac-inside-your-Mac virtual machine, or on a server you run), has a name and a face you chose, remembers you in files you can read, and does real work: it browses in a browser you can watch and take over, reads and sends your mail and messages, fills forms, shops, runs commands in a sandbox, controls your apps, and keeps going after you close the window. It asks before anything that matters, keeps a receipt for everything it does, and never sees your passwords. It talks to whichever model you point it at.

## Why build it

Meta's Muse (September 2026) showed what a consumer personal agent should feel like: one ongoing conversation with a persona, a Feed it writes for you, Ideas it proposes, Goals it tracks, a browser you can take control of, approval cards you can trust, and Soul / Identity / Memory files you can edit. It also showed the cost: it runs in Meta's cloud, trains on your trajectories unless you opt out, requires a card on file, and is US/Canada-only.

The open alternatives each cover part of the shape. OpenClaw is the strongest self-hosted runtime (gateway, channels, memory files, skills, nodes) but is a power tool with a difficult security history and no Muse-like product surface. OpenMuse (CopilotKit) is the closest open product clone but depends on a hosted thread service and targets mobile. The Claude desktop app has the best agent workspace (panes, browser, computer use, plans, approvals) but is tied to one vendor's models and cloud.

Psyche combines them: Muse's product, Claude desktop's workspace, OpenClaw's gateway and files, OpenMuse's review-and-receipt discipline, with any model and no required cloud.

## Who it is for

- A single owner (or a household that trusts each other) who wants an always-available agent with real access to their life and wants to keep that access on hardware they control.
- Developers who want to extend it with skills, connectors, channels and viewers.
- Operators who want to run it as a server that answers on Telegram / iMessage / WhatsApp for one designated person.

## What "imitate Muse" means concretely

| Muse | Psyche |
| --- | --- |
| One persistent main chat plus side chats | Same; plus fork-from-message and a visible follow-up queue |
| Bottom tabs on phone, left rail on Mac: Chat, Search, Feed, Ideas, Goals, Library | Same left rail on desktop and web |
| Animated creature avatar at the top that "types" while working; tap it for Activity, Approvals, Upcoming, Soul & Memory | Same agent header and agent sheet |
| Editable Memory, Soul ("core truths, boundaries, personality") and Identity ("name, creature, vibe or tagline") files | `MEMORY.md`, `SOUL.md`, `IDENTITY.md` (+ `USER.md`, daily notes) in a workspace folder you can open in Finder or git |
| Browser view with a status pill, "Take control", "Stop the task", closing keeps the task running | Embedded browser pane with the same controls |
| Approval cards outside the chat with Allow once / for this task / for this site / Always / Deny; "Ask for some actions" default | Permission Broker with the same scopes, plus expiry, binding to exact arguments and a grant ledger |
| Per-connector read-vs-act scopes and per-action Allow / Ask / Deny; per-Mac-app Off / Read only / Read and interact | Same matrices in Settings → Permissions and Computer use |
| Credentials in a Secure store the agent cannot read; payments via single-use cards with approval each time | Credential Broker (own vault or system keychain, 1Password / Bitwarden bridges); Stripe Link Agent Wallet |
| Feed of agent-written posts on a schedule; Ideas from goals, patterns and conversations; Goals with plans and check-ins | Same surfaces, local pipelines, every item cites its evidence and is confirmable |
| Cloud VM per user | Your Mac, a local macOS VM, or your server |
| Muse Spark models | Any model: Anthropic, OpenAI, Google, OpenRouter, Ollama / llama.cpp / LM Studio / MLX |

## Principles (short form)

1. One conversation, one agent, one identity.
2. Evidence is not permission.
3. Approvals are capabilities, not chat.
4. Every external write leaves a receipt.
5. The model never sees a secret.
6. Memory is files you can read.
7. Work keeps going.
8. Sandbox is the boundary, approvals are the policy.
9. Local first, loopback by default.
10. Proactivity is bounded and confirmable.

The long form, with the mechanisms that enforce each, is in [02-architecture.md](02-architecture.md) §2.

## Non-goals

- A hostile multi-tenant service. One trusted boundary per Gateway.
- A general chat client. Psyche is a personal agent; the chat is how you talk to it, not the product.
- Parity with every provider feature on day one. Tool calling, streaming, vision and reasoning round-tripping are required; provider-specific extras are optional.
- Solving CAPTCHAs, storing card numbers, reading Safari / Passwords.app credentials, or making financial trades.

## Success criteria for v1.0

- A new user installs Psyche, names their agent, connects Gmail and Calendar, grants the browser a site, and completes "find me a cheaper flight to Chicago and hold it for my approval" end to end on a Mac, with receipts.
- The same Gateway, moved to a Linux box with Docker Compose, answers the owner on Telegram with the same memory and approvals, and uses the Mac only for iMessage and app control.
- A third party can read every file that shapes the agent's behavior (`SOUL.md`, `AGENTS.md`, skills, policy) and every action it took (audit log), and can swap the model without losing anything.
