# Onboarding copy

Status: v0.1 (2026-10-19). Owner: S20. Implements the text for `docs/06-ui-design.md` §3.19 and feature R1. Voice rules: [voice.md](voice.md). Onboarding is entirely in Psyche's voice until step 6, where the agent speaks for the first time.

Placeholders: `{agent}` is the name chosen in step 1 (or "your agent" before that), `{site}`, `{n}`, `{ram}` as described in voice.md.

Progress strip labels: **1 Meet your agent · 2 Permissions · 3 Connectors · 4 Model · 5 Where · 6 Done**

Global controls on every step: **Back**, **Skip** (where allowed), **Continue**. Footer: "You can change all of this later in Settings."

---

## 0. Welcome

- Title: **Psyche**
- Body: "A personal agent that runs on your Mac. It remembers you in files you can read, asks before anything that matters, and keeps a receipt for everything it does."
- Second line: "No account needed. Nothing leaves this Mac unless you connect a service or a cloud model."
- Button: **Get started**
- Link: **Restore from a backup**

## 1. Meet your agent

- Title: **Meet your agent**
- Lead: "Give it a name, a look and a personality. You can change any of it later by asking."

### Name

- Label: **Name**
- Placeholder: "Name your agent"
- Suggestions (chips; show four at random, reshuffle on click): Wren · Juno · Moss · Pip · Fern · Otis · Sable · Quill · Bramble · Nova · Tansy · Ember · Rook · Marlo · Kit · Basil
- Shuffle button tooltip: "More names"
- Keep-default chip: **Keep "Psyche"**
- Validation: empty → "Pick a name or keep "Psyche"." Over 24 characters → "Keep it under 24 characters so it fits in notifications."

### Creature

- Label: **What does {agent} look like?**
- Helper: "Describe a creature in a sentence. Psyche draws it if you've set up an image model, otherwise pick one of the creatures below."
- Placeholder examples (rotate):
  - "a small grey moth with lantern eyes"
  - "a sleepy otter in a knitted scarf"
  - "a teal dragon the size of a teacup, wearing round glasses"
  - "a cactus with a tiny straw hat"
  - "a fox made of folded paper"
  - "a round blue owl that looks perpetually surprised"
- Bundled set heading: **Or pick one**
- Generating state: "Drawing {agent}…"
- No image model: "No image model is set up, so pick a creature for now. You can describe a new one after you add an image model in Settings → Model & providers."
- Generation failed: "The image model didn't return a picture ({reason}). Psyche kept your description; pick a creature for now or try again."
- Buttons: **Try again** · **Use this one**

### Vibe and tagline

- Label: **Vibe**
- Helper: "A few words for how {agent} comes across."
- Examples (chips): calm, direct, warm · dry, curious, a little wry · brisk and businesslike · gentle and patient · playful but focused
- Label: **Tagline** (optional)
- Placeholder examples: "Let's get it done." · "One thing at a time." · "I've got the boring parts." · "Ask me anything twice."

### Tone preset (optional)

- Label: **Starting personality**
- Helper: "This sets the Personality section of {agent}'s Soul file. The safety rules are the same in all of them."
- Options:
  - **Default**: "Warm, direct and brief."
  - **Calm and steady**: "Unhurried, gentle, quiet about small things."
  - **Dry wit**: "Good company. Understated humor, never in the way."
  - **Strict chief of staff**: "Protects your time, pushes back, bottom line first."
- Link: **Read the Soul file**

### Emoji

- Label: **Emoji** (optional)
- Helper: "Used where pictures don't fit, like some chat apps."

### Preview

- Avatar preview caption: "{agent} · {tagline}"
- Button: **Continue**

---

## 2. Permissions

- Title: **Let {agent} use this Mac**
- Lead: "Each of these is optional. Without them, {agent} still chats, browses in its own browser and uses connected accounts. You can grant them later in Settings → Computer use."

| Permission | Row text | Why (shown under the row) | Buttons |
| --- | --- | --- | --- |
| Accessibility | **Accessibility** · "Lets {agent} click, type and use apps." | "macOS requires this for any app that controls other apps. {agent} reads an app's buttons and fields, then clicks or types only in apps you've set to Read and interact, and you can stop it with Esc." | **Allow** · **Skip** |
| Screen Recording | **Screen Recording** · "Lets {agent} see app windows when it needs to." | "Used for screenshots of an app window when its buttons and text aren't readable another way. Psyche's own windows and password fields are hidden from screenshots." | **Allow** · **Skip** |
| Notifications | **Notifications** · "Lets {agent} reach you when something needs you." | "Approvals, questions, finished tasks and reminders. You can approve some actions right from the notification; purchases and password fills ask for Touch ID." | **Allow** · **Skip** |

- After **Allow** for Accessibility or Screen Recording: "macOS opens System Settings. Turn on Psyche, then come back here." Button: **Open System Settings**. Then: "Waiting for macOS…" → granted: "Granted" / still off after return: "Still off. You can skip this and turn it on later."
- Footnote: "Psyche never reads Safari or Passwords app passwords. macOS doesn't allow it, and Psyche doesn't try."

### Permissions requested later (first use, not during onboarding)

| Permission | Prompt title | Why |
| --- | --- | --- |
| Automation (per app) | "Let {agent} control {app}?" | "Needed to run actions in {app}, such as creating a note or a Shortcut. macOS asks once per app." |
| Calendars and Reminders | "Let {agent} use Calendar and Reminders on this Mac?" | "To read and, with your approval, add events and reminders in your Mac's calendars. Not needed if you only use a Google or Microsoft calendar connector." |
| Contacts | "Let {agent} read your contacts?" | "To match names to email addresses and phone numbers when you ask it to message someone." |
| Full Disk Access | "Let {agent} read your Messages?" | "iMessage history lives in a protected file on this Mac. Full Disk Access lets Psyche read it so {agent} can answer and draft replies. Sending still asks you each time." |
| Microphone | "Let {agent} hear you?" | "For dictation and voice chat. Audio is transcribed on this Mac when your Mac supports it." |
| Folder access | "Let {agent} open {folder}?" | "{agent} can only see folders you share with it. Choose read-only or read and write." Buttons: **Read only** · **Read and write** · **Don't share** |

---

## 3. Connectors

- Title: **Connect your accounts**
- Lead: "Decide now which accounts {agent} should see. Connect one at a time; you can add more later in Settings → Connectors."
- Each connector asks for its scope at connect time:
  - **Read only**: "{agent} can read but can't send, create or change anything."
  - **Read and act**: "{agent} can also draft, send, create and change things. Each action still follows your permission settings, and sends ask first by default."
- Skip link: **I'll do this later**

| Connector | Card text | Notes shown on connect |
| --- | --- | --- |
| Google (Gmail, Calendar, Drive) | "Mail, calendar and the Drive files you pick." | See "Setting up Google" below. · "Drive access is limited to files {agent} creates or you open with it." |
| Microsoft (Outlook, OneDrive) | "Outlook mail and calendar, OneDrive files." | "Sign in with your Microsoft account in the window that opens." |
| Other mail (IMAP) | "Any mail account with IMAP and SMTP." | "Use an app password from your mail provider, not your main password. Psyche stores it in the vault; {agent} never sees it." |
| Fastmail | "Mail and calendar through Fastmail's API." | "Create an API token in Fastmail → Settings → Privacy & Security, then paste it here. It goes straight into the vault." |
| Apple apps | "Mail, Calendar, Reminders, Notes and Contacts on this Mac." | "Uses the apps already set up on this Mac. macOS asks for each app the first time." |
| Web search | "Lets {agent} search the web." | "Pick a provider: Brave, Exa, Tavily, or your own SearXNG. Paid providers need an API key, stored in the vault." |
| Slack | "Read channels and DMs, draft and send messages." | "You choose the workspace in Slack's own window." |
| Notion · Linear · GitHub | "Pages and databases" · "Issues and projects" · "Repos, issues and pull requests" | "Connects to the service's own MCP server. You can set each tool to Allow, Ask or Deny afterwards." |
| Stripe Link | "Lets {agent} pay with one-time cards you approve." | "Psyche never stores card numbers. When {agent} wants to buy something, you approve the exact items and total on this Mac with Touch ID, then again in Link. Each purchase gets a single-use card." |

### Setting up Google

Google requires every app that reads Gmail to have its own sign-in client. Psyche uses one that you own, so your mail never passes through anyone else's server. It takes about five minutes, once.

1. "Open the Google Cloud console and create a project. Any name works, for example "Psyche"." Button: **Open Google Cloud console**
2. "Turn on the Gmail API and the Google Calendar API for the project."
3. "Under Google Auth Platform → Branding, set the audience to External. Under Audience, choose **Publish app** so its status is **In production**."
   - Warning (always shown): "Leave it in Testing and Google signs you out every 7 days. In production with only you as a user, Google doesn't require a review."
4. "Under Clients, create an OAuth client of type **Desktop app**. Paste its client ID and client secret here." Fields: **Client ID** · **Client secret** (stored in the vault).
5. "Sign in with Google." Button: **Sign in with Google**
   - Before the browser opens: "Google will show "Google hasn't verified this app". That's expected for a client only you use. Choose **Advanced**, then **Go to Psyche (unsafe)**, then allow the permissions Psyche lists."
   - Scopes shown before sign-in: Read only → "Read your mail and calendar". Read and act → "Read, draft, label and send mail; read and change your calendar; files you open with Psyche in Drive".
6. Success: "Connected · {account}". Failure: "Google didn't finish the sign-in ({reason}). Check that the client type is Desktop app and the app is In production, then try again."

- Connected state on a card: "Connected · {account} · {Read only | Read and act}"
- Failed: "Couldn't connect to {service} ({reason}). Nothing was saved. Try again."

---

## 4. Model

- Title: **Choose {agent}'s model**
- Lead: "Psyche works with any model you can reach. Use a cloud provider with your own key or subscription, or run one on this Mac."

| Option | Text |
| --- | --- |
| Cloud provider | **Anthropic · OpenAI · Google** · "Paste an API key or sign in with your subscription. The key goes into the vault, never into a config file." |
| OpenRouter | **OpenRouter** · "One key for many models. Billing is through OpenRouter." |
| On this Mac | **Local model** · "Runs on your Mac with Ollama, llama.cpp, LM Studio or MLX. Private and free to run; slower and less capable than the largest cloud models." |
| Custom endpoint | **Other endpoint** · "Any OpenAI- or Anthropic-compatible server. Enter its URL." |

- Local RAM guidance (shown with the Mac's memory filled in): "This Mac has {ram} GB of memory. Good fits: {suggestions}." Using the bands: 16 GB → "small models around 9B parameters"; 32 GB → "models around 27–31B"; 96–128 GB → "large mixture-of-experts models around 120B".
- Tool-calling check: running "Checking that {model} can use tools…"; pass "Ready. {model} can use tools."; fail "{model} can chat but failed the tool check, so it can't do tasks. Pick another model for tasks, or keep it for chat only."
- Permission-mode note: "Auto mode, where {agent} takes routine actions without asking, is only available with models that have published prompt-injection test results. Other models use Balanced mode: {agent} asks before anything that changes something."
- Key error: "That key didn't work ({provider} said: {reason}). Nothing was saved."

---

## 5. Where

- Title: **Where should {agent} work?**

| Option | Text |
| --- | --- |
| This Mac (default) | **On this Mac** · "{agent} uses its own browser, a sandbox for commands, and the apps and folders you allow. Fastest to set up." |
| Mac inside Psyche | **In a Mac inside Psyche** · "{agent} gets its own virtual Mac to use apps in, separate from your files and apps. Needs an Apple silicon Mac and about 80 GB of disk; setup downloads macOS and takes a while. On macOS 27 it sets itself up; on earlier versions you may need to click through the macOS setup assistant once." |

- VM defaults (shown when the VM option is selected): "4 CPU cores · 8 GB memory · 80 GB disk (adjustable) · One virtual Mac at a time · Shares your Mac's internet connection, including your local network · No folders shared until you add them, and those are read-only unless you change them · You can paste into it; nothing copies back out · Your passwords stay in this Mac's vault and are lent for one fill at a time."
- VM caveats: "The virtual Mac needs you logged in to this Mac to run. Apple's license allows macOS virtual machines for personal and development use. The App Store doesn't work inside it."
- Footnote: "Commands always run in a sandbox with no network by default. Psyche never falls back to running them directly on your Mac."

---

## 6. Done

- Title: **{agent} is ready**
- Body: "Your main chat is open. {agent} will say hello and ask a couple of questions to finish setting up."
- Summary list: "Name: {agent} · Model: {model} · Connected: {connectors or "nothing yet"} · Mode: Balanced (asks before acting)"
- Button: **Start chatting**
- The first agent message comes from `BOOTSTRAP.md` (templates/BOOTSTRAP.md), in the agent's voice. Example for a calm default:
  > "Hi, I'm Wren. I can take care of email, your calendar, research and errands on the web, and I'll ask before anything that matters. Two quick questions so I get things right."
