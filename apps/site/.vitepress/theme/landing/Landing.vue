<script setup lang="ts">
import { withBase } from "vitepress";
import { onBeforeUnmount, onMounted, ref } from "vue";
import CloseStack from "./CloseStack.vue";
import DemoStage from "./DemoStage.vue";
import SheetStack from "./SheetStack.vue";
import { type SceneEngine, startScenes } from "./scroll-scenes";

const repo = "https://github.com/devmello/psyche";
const spread = ref<HTMLElement | null>(null);
const root = ref<HTMLElement | null>(null);
/** 0 while the spread fills the screen, 1 once it has scrolled away: drives the fan. */
const fan = ref(0);
const copied = ref(false);

const install = `git clone ${repo}
cd psyche
pnpm install
pnpm app:ship`;

async function copyInstall() {
  try {
    await navigator.clipboard.writeText(install);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1800);
  } catch {
    copied.value = false;
  }
}

let raf = 0;
let engine: SceneEngine | null = null;
let pinQuery: MediaQueryList | null = null;
const motion = ref(false);
const pinned = ref(false);

function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const el = spread.value;
    if (!el) return;
    // The track is taller than the screen while the spread is pinned; the fan plays across it.
    const travel = el.offsetHeight - window.innerHeight;
    const span = travel > 120 ? travel : el.offsetHeight * 0.6;
    fan.value = Math.min(1, Math.max(0, window.scrollY / span));
  });
}

function onPinChange() {
  pinned.value = !!pinQuery?.matches;
  // Track heights change with pinning; measure again after the layout settles.
  requestAnimationFrame(() => engine?.update());
}

onMounted(() => {
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !root.value) return;
  motion.value = true;
  // Pinned scenes need a screen tall enough to hold the whole sheet.
  pinQuery = window.matchMedia("(min-width: 961px) and (min-height: 760px)");
  pinned.value = pinQuery.matches;
  pinQuery.addEventListener("change", onPinChange);
  const el = root.value;
  requestAnimationFrame(() => {
    engine = startScenes(el, () => pinned.value);
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  cancelAnimationFrame(raf);
  pinQuery?.removeEventListener("change", onPinChange);
  engine?.destroy();
});
</script>

<template>
  <div ref="root" class="landing" :class="{ motion, pin: pinned }">
    <!-- The spread: an open notebook. -->
    <div ref="spread" class="spread-track">
    <section class="spread" aria-labelledby="hero-title">
      <div class="book lit">
        <div class="page left">
          <p class="run-head">README.md</p>
          <h1 id="hero-title">Your agent, kept in files you can read.</h1>
          <p class="deck">
            Psyche is an open-source personal agent for the Mac. It remembers your mail, messages,
            people and work on your own disk, shows where every answer came from, and asks before
            it changes anything.
          </p>
          <div class="actions">
            <a class="btn primary" :href="repo" rel="noopener">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 .2a8 8 0 0 0-2.53 15.6c.4.07.55-.17.55-.38v-1.36c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.96 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.08-1.87 3.76-3.66 3.96.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2Z"
                />
              </svg>
              Star on GitHub
            </a>
            <a class="btn quiet" :href="withBase('/get-started/')">Build it from source</a>
          </div>
          <p class="status">Alpha 0.3 · macOS, built from source · Apache-2.0 · no telemetry</p>
        </div>
        <div class="gutter" aria-hidden="true" />
        <div class="page right">
          <p class="run-head">~/.psyche/workspace/</p>
          <div class="stage">
            <SheetStack :progress="fan" />
          </div>
          <p class="margin-note">
            Memory, persona and receipts are plain text in <code>~/.psyche</code>. Open them in
            Finder, or keep them in git.
          </p>
        </div>
      </div>
    </section>
    </div>

    <!-- Six things Psyche does, each shown by the app itself. The scroll is the playhead. -->
    <DemoStage
      id="brief-title"
      title="Start the morning with what needs you."
      where="Home"
      clip="brief"
      label="Psyche's Home: what needs you, a catch-up line opened to the message behind it, then the morning brief with numbered sources"
      :ratio="1408 / 960"
      :phone-ratio="720 / 1292"
      :duration="13.54"
      :beats="[
        { at: 0, text: 'Approvals and questions that wait on you come first.' },
        { at: 3.62, text: 'Catching up: what is due, and what moved since you last looked.' },
        { at: 6.0, text: 'Each line opens the message it came from.' },
        { at: 9.82, text: 'Then the brief, every line numbered to its source.' },
      ]"
      :scrub="pinned"
      :motion="motion"
      from="right"
    >
      <p>Home reads your mail, messages, calendar and work, and starts with you. The Feed behind the brief is still being finished.</p>
      <template #foot><a class="more" :href="withBase('/using/feed-ideas-goals')"><span class="src">1</span>Home and the brief <span class="where">using/feed-ideas-goals</span></a></template>
    </DemoStage>

    <DemoStage
      id="answer-title"
      title="Ask, then open the source."
      where="Search · ⌘K"
      clip="answer"
      label="A question typed into Search, answered from memory with source chips; one chip opens the mail it came from"
      :ratio="1120 / 980"
      :phone-ratio="648 / 1008"
      :duration="14.7"
      :beats="[
        { at: 0.5, text: 'Ask in your own words, from anywhere.' },
        { at: 3.7, text: 'Each claim in the answer carries a chip naming its source.' },
        { at: 6.8, text: 'A chip shows the mail behind it, and the fact in Sam\'s own words.' },
        { at: 9.5, text: 'Show source opens the message itself, as plain text.' },
      ]"
      :scrub="pinned"
      :motion="motion"
      from="left"
    >
      <p>One box searches threads, mail, messages, files and memory, indexed on this Mac. A claim that cites nothing is dropped.</p>
      <template #foot><a class="more" :href="withBase('/using/memory')"><span class="src">2</span>How memory and search work <span class="where">using/memory</span></a></template>
    </DemoStage>

    <!-- Approvals: the lights go down, the lamp comes on. -->
    <section class="night" data-scene="flow" data-end="0.15" data-exit aria-label="Approvals">
      <DemoStage
        id="approve-title"
        title="Nothing changes until you say so."
        where="Chat · Dentist booking"
        clip="approval"
        label="A dentist booking waiting on two approvals: the card for filling a saved login, Allow once, and then the next card, an email to send"
        :ratio="1408 / 960"
        :phone-ratio="720 / 1140"
        :duration="10.2"
        :beats="[
          { at: 0, text: 'Wren is booking the dentist. Two steps wait on you.' },
          { at: 2.9, text: 'The card names the exact action: this login, this site, and what Wren sees (a placeholder, never the password).' },
          { at: 5.78, text: 'Allow once. The next step, the email, still waits its turn.' },
        ]"
        :scrub="pinned"
        :motion="motion"
        from="right"
        class="lamplit"
      >
        <p>Sending, buying, filling a password or running a command stops at a card bound to that exact action. Text from a web page, an email or a file can never approve anything.</p>
        <template #foot>
          <p class="note">Purchases and password fills ask for Touch ID. Every write leaves a receipt in a hash-chained audit log.</p>
          <a class="more" :href="withBase('/security/approvals-and-tiers')"><span class="src">3</span>Approvals and app tiers <span class="where">security/approvals-and-tiers</span></a>
        </template>
      </DemoStage>
    </section>

    <DemoStage
      id="memory-title"
      title="It learns the people in your life, and checks with you."
      where="Memory → Review, then Sam Lee"
      clip="memory"
      label="Memory's review list: facts found in mail with the words they came from, one confirmed; then Sam Lee's page with facts, sources and open loops"
      :ratio="1408 / 960"
      :phone-ratio="720 / 1140"
      :duration="20.17"
      :beats="[
        { at: 0, text: 'Wren proposes what it found in your mail, messages and notes.' },
        { at: 2.7, text: 'Each fact shows the words it came from.' },
        { at: 5.2, text: 'Nothing is remembered until you confirm it.' },
        { at: 9.58, text: 'A person\'s page builds up: role, preferences and open loops, each with its source.' },
      ]"
      :scrub="pinned"
      :motion="motion"
      from="left"
    >
      <p>People, projects and promises, learned the way you would, if you wrote everything down. Anything sensitive or unsure always waits for review.</p>
      <template #foot><a class="more" :href="withBase('/using/memory')"><span class="src">4</span>Memory <span class="where">using/memory</span></a></template>
    </DemoStage>

    <DemoStage
      id="devices-title"
      title="Use it from your phone or another computer."
      where="Settings → Devices &amp; nodes, then the iPhone app"
      clip="devices"
      label="Settings on the Mac: an iPad waiting to pair with a code to compare, and the paired iPhone and browser with what each may do. Then the iPhone app: an approval to add a calendar event, allowed, and the Mac has the answer"
      :ratio="1600 / 806"
      :phone-ratio="720 / 1292"
      :duration="19.29"
      :beats="[
        { at: 0, text: 'A new device asks to pair, and waits for you on this Mac.' },
        { at: 2.69, text: 'Check the same code shows on both, and choose what it may do.' },
        { at: 5.3, text: 'A paired iPhone can read, write and answer approvals.' },
        { at: 7.62, text: 'A browser on a work laptop can read and write, and nothing more.' },
        { at: 12.9, text: 'On the iPhone, the same approval. Allow, and your Mac has the answer.' },
      ]"
      :scrub="pinned"
      :motion="motion"
      from="right"
    >
      <p>Your Mac is the Host: data, memory and models stay on it. A phone or another computer is a window onto it, over your own network or your tailnet. The iPhone app is in development, built from source like the Mac app.</p>
      <template #foot><a class="more" :href="withBase('/guides/remote-gateway')"><span class="src">5</span>Use Psyche from another computer <span class="where">guides/remote-gateway</span></a></template>
    </DemoStage>

    <DemoStage
      id="files-title"
      title="Its memory is files you can open."
      where="Wren → Soul → MEMORY.md"
      clip="files"
      label="The agent sheet's files, SOUL.md, IDENTITY.md, USER.md, MEMORY.md and AGENTS.md; MEMORY.md opens as plain Markdown"
      :ratio="1408 / 960"
      :duration="10.58"
      :beats="[
        { at: 0, text: 'Who Wren is, what it knows about you and what it remembers: Markdown files.' },
        { at: 2.85, text: 'Open MEMORY.md. Plain text, rewritten each night, yours to edit.' },
        { at: 6.86, text: 'All of it lives under ~/.psyche, on this Mac.' },
      ]"
      :scrub="pinned"
      :motion="motion"
      from="left"
    >
      <p>No hosted service holds your threads, memory or skills. Model calls are the only thing that leaves, to the provider you choose, or nowhere with a local model.</p>
      <template #foot><a class="more" :href="withBase('/security/on-device')"><span class="src">6</span>What stays on your machine <span class="where">security/on-device</span></a></template>
    </DemoStage>

    <!-- Honest status. -->
    <section class="leaf lit status-page" data-scene="flow" data-end="-0.6" aria-labelledby="status-title">
      <p class="run-head">docs/release-notes/0.3.md</p>
      <h2 id="status-title">Alpha, and plain about it.</h2>
      <div class="columns">
        <div>
          <h3>Works today</h3>
          <ul>
            <li style="--i: 0">One ongoing chat with side chats, and replies that carry files, mail and live artifacts</li>
            <li style="--i: 1">Screen Ask: a hotkey panel over whatever you are looking at</li>
            <li style="--i: 2">On-device Search across threads, files and memory</li>
            <li style="--i: 3">Apple Notes, Reminders, Calendar and Mail; Gmail and Google Calendar with your own OAuth client; MCP servers</li>
            <li style="--i: 4">Approval cards with receipts, a browser you can watch and take over, a no-network sandbox</li>
            <li style="--i: 5">Dictation: hold a key, speak, and review the words before they go</li>
            <li style="--i: 6">Any model: Anthropic, OpenAI, Ollama and other compatible providers</li>
          </ul>
        </div>
        <div>
          <h3>Not yet</h3>
          <ul class="not-yet">
            <li style="--i: 0">A signed release. Today you build the Mac app from source</li>
            <li style="--i: 1">Windows. Linux runs the Gateway in server mode, not the desktop app</li>
            <li style="--i: 2">The Feed, background specialists and meeting capture are still being built</li>
          </ul>
          <p class="origin">
            Psyche began as an open-source take on Meta's Muse: one agent that knows your life,
            rebuilt to run on hardware you own, with the model you choose.
          </p>
        </div>
      </div>
    </section>

    <!-- Close. -->
    <section class="close" data-scene="flow" data-end="0.3" aria-labelledby="close-title">
      <CloseStack class="lit" />
      <h2 id="close-title">Clone it. Build it. Read every file.</h2>
      <div class="terminal lit">
        <div class="terminal-head">
          <span>Terminal · Node 24+, pnpm 12+</span>
          <button type="button" class="copy-btn" @click="copyInstall">
            {{ copied ? "Copied" : "Copy" }}
          </button>
          <span class="sr-only" aria-live="polite">{{ copied ? "Commands copied" : "" }}</span>
        </div>
        <pre><code><span
              v-for="(line, i) in install.split('\n')"
              :key="i"
              class="typed"
              :style="{ '--i': i, '--len': line.length }"
              >{{ line }}</span
            ></code></pre>
      </div>
      <p class="fine">
        <code>pnpm app:ship</code> builds a DMG and installs it into /Applications. Installing
        resets Psyche's local data; pass <code>--keep-data</code> to keep it.
      </p>
      <div class="actions">
        <a class="btn primary" :href="repo" rel="noopener">Star on GitHub</a>
        <a class="btn quiet" :href="withBase('/get-started/')">Read the guide</a>
      </div>
      <nav class="index" aria-label="Documentation">
        <a :href="withBase('/get-started/')"><b>Get started</b><span>The Mac app, Docker, server mode</span></a>
        <a :href="withBase('/using/')"><b>Using Psyche</b><span>Chat, memory, tasks, the browser</span></a>
        <a :href="withBase('/security/')"><b>Security</b><span>Permissions, taint, the vault</span></a>
        <a :href="withBase('/reference/')"><b>Reference</b><span>CLI, settings, protocol</span></a>
        <a :href="withBase('/contributing/')"><b>Contributing</b><span>Architecture and pull requests</span></a>
      </nav>
    </section>
  </div>
</template>

<style scoped>
.landing {
  --gutter-x: clamp(16px, 4vw, 56px);
  background: var(--desk);
  color: var(--paper-12);
  padding: 0 var(--gutter-x) 48px;
  overflow-x: clip;
  font-family: var(--font-text);
}
.landing :where(h1, h2, h3) {
  font-family: var(--font-display);
  font-weight: 500;
  text-wrap: balance;
  margin: 0;
}
.landing :where(p) {
  margin: 0;
}
.landing code {
  font-family: var(--font-code);
  font-size: 0.88em;
  padding: 0.1em 0.35em;
  border-radius: 5px;
  background: var(--paper-3);
  border: 1px solid var(--paper-5);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Running head: the file a page is about. */
.run-head {
  font-family: var(--font-code);
  font-size: 12.5px;
  color: var(--paper-9);
  padding-bottom: 12px;
  margin-bottom: clamp(28px, 4vw, 56px);
  position: relative;
}
.run-head::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--paper-5);
  transform-origin: left;
}

/* ---------- The spread ---------- */
.spread-track {
  position: relative;
}
@media (min-width: 961px) and (min-height: 640px) {
  .spread-track {
    height: calc(100svh + 60svh);
  }
  .spread {
    position: sticky;
    top: var(--vp-nav-height, 64px);
    height: calc(100svh - var(--vp-nav-height, 64px));
  }
}
@media (prefers-reduced-motion: reduce) {
  .spread-track {
    height: auto;
  }
  .spread {
    position: static;
    height: auto;
  }
}
.spread {
  box-sizing: border-box;
  padding: clamp(8px, 1.4vw, 20px) 0 clamp(20px, 2.6vw, 36px);
  min-height: calc(100svh - var(--vp-nav-height, 64px));
  display: flex;
}
.book {
  position: relative;
  flex: 1;
  max-width: 1480px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr);
  background: var(--sheet);
  border-radius: 6px;
  box-shadow: var(--shadow-lift);
  min-height: min(720px, calc(100svh - var(--vp-nav-height, 64px) - 56px));
}
.book::before {
  /* The gutter's soft fold. */
  content: "";
  position: absolute;
  left: calc(50% - 40px);
  width: 80px;
  top: 0;
  bottom: 0;
  background: linear-gradient(
    90deg,
    transparent,
    oklch(0.2 0.01 80 / 0.05) 45%,
    oklch(0.2 0.01 80 / 0.09) 50%,
    oklch(0.2 0.01 80 / 0.05) 55%,
    transparent
  );
  pointer-events: none;
}
.gutter {
  background: var(--paper-5);
}
.page {
  padding: clamp(24px, 3.4vw, 56px) clamp(22px, 4.2vw, 72px) clamp(28px, 3vw, 48px);
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.left h1 {
  font-size: clamp(44px, 6.3vw, 96px);
  line-height: 0.97;
  letter-spacing: -0.028em;
  max-width: 11ch;
  margin-top: auto;
}
.deck {
  margin-top: clamp(22px, 2.4vw, 34px);
  font-size: clamp(17px, 1.45vw, 21px);
  line-height: 1.5;
  color: var(--paper-11);
  max-width: 34em;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: clamp(26px, 3vw, 40px);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  height: 46px;
  padding: 0 20px;
  border-radius: 10px;
  font-size: 15.5px;
  font-weight: 550;
  text-decoration: none;
  transition:
    background 0.18s,
    border-color 0.18s,
    transform 0.18s var(--ease-out),
    box-shadow 0.18s;
}
.btn svg {
  width: 17px;
  height: 17px;
  fill: currentColor;
}
.btn.primary {
  background: var(--ink);
  color: #fff;
  box-shadow: 0 1px 1px oklch(0.2 0.05 258 / 0.2), 0 6px 14px -8px oklch(0.3 0.1 258 / 0.6);
}
.btn.primary:hover {
  background: var(--ink-hover);
  transform: translateY(-1px);
}
.btn.primary:active {
  transform: none;
}
.btn.quiet {
  color: var(--paper-12);
  border: 1px solid var(--paper-7);
  background: var(--sheet);
}
.btn.quiet:hover {
  border-color: var(--paper-9);
  background: var(--paper-2);
}
.status {
  margin-top: 22px;
  font-size: 13.5px;
  color: var(--paper-11);
  margin-bottom: auto;
  padding-bottom: 8px;
}
.right {
  position: relative;
}
.stage {
  flex: 1;
  position: relative;
  min-height: 0;
}
.margin-note {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--paper-11);
  max-width: 40ch;
  margin-left: auto;
  text-align: right;
}

/* ---------- Leaves: sheets laid on the desk ---------- */
.leaf {
  position: relative;
  max-width: 1480px;
  margin: clamp(40px, 7vw, 112px) auto 0;
  background: var(--sheet);
  border-radius: 6px;
  box-shadow: var(--shadow-sheet);
  padding: clamp(24px, 4vw, 64px) clamp(22px, 5vw, 88px) clamp(32px, 5vw, 80px);
}
.leaf::before {
  /* Margin rule. */
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: clamp(12px, 2.4vw, 44px);
  width: 1px;
  background: var(--paper-4);
}
.leaf h2,
.close h2 {
  font-size: clamp(32px, 3.7vw, 54px);
  line-height: 1.04;
  letter-spacing: -0.022em;
  max-width: 17ch;
}
.lede {
  margin-top: 20px;
  font-size: 17.5px;
  line-height: 1.6;
  color: var(--paper-11);
  max-width: 36em;
}
/* Each section cites the doc page it is drawn from, the way Psyche cites its sources. */
.more {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: 8px;
  row-gap: 2px;
  margin-top: 26px;
  font-weight: 550;
  font-size: 15.5px;
  color: var(--ink-text);
  text-decoration: none;
}
.more .src {
  align-self: center;
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--ink-soft);
  font: 500 12px/1 var(--font-code);
  color: var(--ink-text);
}
.more .where {
  font: 400 12.5px/1.4 var(--font-code);
  color: var(--paper-9);
}
.more:hover {
  text-decoration: underline;
  text-decoration-color: var(--ink-line);
  text-underline-offset: 4px;
}
.more:hover .where,
.more:hover .src {
  text-decoration: none;
}
/* ---------- Night: one sheet under the lamp ---------- */
.night {
  margin: clamp(56px, 9vw, 144px) calc(var(--gutter-x) * -1) 0;
  padding: clamp(56px, 8vw, 128px) var(--gutter-x);
  background: oklch(0.165 0.002 80);
  position: relative;
  /* clip, not hidden: hidden would make a scroll container and break the pinned stage. */
  overflow: clip;
}
.night::before {
  /* The lamp, above the sheet's upper left. */
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse 55% 75% at 30% 18%,
    oklch(0.96 0.025 85 / 0.13),
    transparent 72%
  );
  pointer-events: none;
}
.night :deep(.stage-track) {
  margin-top: 0;
}
.note {
  font-size: 14px;
  line-height: 1.5;
  color: var(--paper-11);
  max-width: 36em;
  margin-bottom: 4px;
}
.lamplit :deep(.stage) {
  /* Night-strength shadow, easing back toward a daylight sheet shadow as the band leaves. */
  --lamp-k: calc(1 - var(--x, 0) * 0.78);
  --shadow-lamp:
    0 2px 2px oklch(0 0 0 / calc(0.35 * var(--lamp-k))),
    0 24px 48px -18px oklch(0 0 0 / calc(0.7 * var(--lamp-k))),
    0 70px 120px -50px oklch(0 0 0 / calc(0.8 * var(--lamp-k)));
  box-shadow: var(--shadow-lamp);
}
.dark .landing .book::before {
  background: linear-gradient(
    90deg,
    transparent,
    oklch(0.2 0.01 80 / 0.08) 45%,
    oklch(0.2 0.01 80 / 0.14) 50%,
    oklch(0.2 0.01 80 / 0.08) 55%,
    transparent
  );
}

/* ---------- Status ---------- */
.columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: clamp(28px, 5vw, 88px);
  margin-top: clamp(28px, 3.5vw, 48px);
}
.columns h3 {
  font-size: 22px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--paper-7);
}
.columns ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.columns li {
  position: relative;
  padding: 12px 0 12px 22px;
  border-bottom: 1px solid var(--paper-5);
  font-size: 15.5px;
  line-height: 1.5;
}
.columns li::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 19px;
  width: 9px;
  height: 5px;
  border-left: 1.5px solid var(--paper-12);
  border-bottom: 1.5px solid var(--paper-12);
  transform: rotate(-45deg);
}
.not-yet li {
  color: var(--paper-11);
}
.not-yet li::before {
  top: 21px;
  height: 0;
  width: 9px;
  border-left: none;
  border-bottom: 1.5px solid var(--paper-9);
  transform: none;
}
.origin {
  margin-top: 28px;
  font-family: var(--font-display);
  font-size: 19px;
  line-height: 1.5;
  color: var(--paper-11);
  max-width: 30em;
}

/* ---------- Close ---------- */
.close {
  max-width: 980px;
  margin: clamp(72px, 11vw, 168px) auto 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.close h2 {
  max-width: 16ch;
  font-size: clamp(36px, 4.6vw, 66px);
}
.terminal {
  width: 100%;
  max-width: 640px;
  margin-top: clamp(32px, 4vw, 52px);
  text-align: left;
  background: var(--sheet);
  border-radius: 12px;
  box-shadow:
    0 0 0 1px var(--paper-6),
    var(--shadow-sheet);
  overflow: hidden;
}
.terminal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 8px 8px 16px;
  border-bottom: 1px solid var(--paper-5);
  font-size: 13px;
  color: var(--paper-9);
}
.copy-btn {
  font: 500 13px/1 var(--font-text);
  color: var(--paper-12);
  padding: 7px 12px;
  border-radius: 7px;
  border: 1px solid var(--paper-6);
  background: var(--paper-2);
  cursor: pointer;
  min-width: 64px;
  transition: background 0.15s;
}
.copy-btn:hover {
  background: var(--paper-4);
}
.terminal pre {
  margin: 0;
  padding: 18px 20px 20px;
  overflow-x: auto;
}
.terminal pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: clamp(12px, 3.3vw, 14.5px);
  line-height: 1.75;
  color: var(--paper-12);
}
.fine code {
  white-space: nowrap;
}
.fine {
  margin-top: 16px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--paper-11);
  max-width: 52ch;
}
.close .actions {
  justify-content: center;
}
.index {
  width: 100%;
  margin-top: clamp(56px, 7vw, 96px);
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-top: 1px solid var(--paper-7);
  text-align: left;
}
.index a {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 16px 18px 0;
  text-decoration: none;
  color: var(--paper-12);
}
.index b {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 18px;
  transition: color 0.15s;
}
.index span {
  font-size: 13.5px;
  line-height: 1.4;
  color: var(--paper-11);
}
.index a:hover b {
  color: var(--ink-text);
}

/* ---------- Scroll scenes ----------
 * Each [data-scene] carries --p (0 → 1) from scroll-scenes.ts. The default is 1, the finished
 * state, so without the engine (no script, reduced motion) every scene shows complete.
 */
[data-scene] {
  --p: 1;
}
/* Ease the raw progress once per scene: quick to arrive, settling at the end. */
.motion [data-scene="flow"] {
  --q: calc(1 - (1 - var(--p)) * (1 - var(--p)) * (1 - var(--p)));
}

/* Night: the lights go down as the band arrives, and the lamp comes on. */
/* --x (exit) brings the lights back up as the band leaves, so the receipts sheet rises in daylight. */
.motion .night {
  --dark: calc(var(--q) * (1 - var(--x, 0)));
  background-color: color-mix(in oklch, oklch(0.165 0.002 80) calc(var(--q) * 100%), var(--desk));
  /* Leaving: daylight rises from the bottom of the band with a soft edge, not a gray block. */
  background-image: linear-gradient(
    to top,
    var(--desk) calc(var(--x, 0) * 125% - 25%),
    transparent calc(var(--x, 0) * 125% + 12%)
  );
}
.motion .night::before {
  opacity: var(--dark);
  transform: scale(calc(0.7 + var(--q) * 0.3));
  transform-origin: 30% 0;
}
/* Status: "Works today" is checked off row by row; "Not yet" stays in pencil. */
.status-page .columns li {
  border-bottom-color: transparent;
}
.status-page .columns li::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--paper-5);
  transform-origin: left;
}
.motion .status-page .columns li {
  --k: clamp(0, calc((var(--p) - 0.15 - var(--i) * 0.1) / 0.12), 1);
}
.motion .status-page .columns ul:not(.not-yet) li {
  color: color-mix(in oklch, var(--paper-12) calc(var(--k) * 100%), var(--paper-9));
}
.motion .status-page .columns li::after {
  transform: scaleX(var(--k));
}
.motion .status-page .columns ul:not(.not-yet) li::before {
  opacity: var(--k);
  transform: rotate(-45deg) scale(calc(0.3 + var(--k) * 0.7));
}

/* Close: the commands type out with the scroll. */
.typed {
  display: block;
}
.motion .close .typed {
  --k: clamp(0, calc((var(--p) - 0.35 - var(--i) * 0.14) / 0.14), 1);
  clip-path: inset(0 calc(100% - round(down, calc(var(--k) * var(--len)), 1) * 1ch) 0 0);
}

/* ---------- Narrow ---------- */
@media (max-width: 960px) {
  .book {
    grid-template-columns: minmax(0, 1fr);
  }
  .book::before,
  .gutter {
    display: none;
  }
  .left {
    border-bottom: 1px solid var(--paper-5);
  }
  .left h1 {
    margin-top: 12px;
  }
  .stage {
    height: min(118vw, 560px);
    flex: none;
  }
  .margin-note {
    text-align: left;
    margin-left: 0;
  }
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
  .index {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .landing {
    --gutter-x: 12px;
  }
  .book,
  .leaf {
    border-radius: 4px;
  }
  .index {
    grid-template-columns: minmax(0, 1fr);
  }
  .btn {
    flex: 1 1 auto;
    justify-content: center;
  }
}
</style>

<style>
/* Lamplit paper: in dark mode, and on the night band, sheets stay paper. */
.landing .night .lit,
.dark .landing .lit {
  --sheet: oklch(0.93 0.0035 80);
  --paper-1: oklch(0.93 0.0035 80);
  --paper-2: oklch(0.915 0.0035 80);
  --paper-3: oklch(0.89 0.004 80);
  --paper-4: oklch(0.87 0.004 80);
  --paper-5: oklch(0.84 0.0045 80);
  --paper-6: oklch(0.81 0.0045 80);
  --paper-7: oklch(0.77 0.005 80);
  --paper-9: oklch(0.5 0.005 80);
  --paper-11: oklch(0.43 0.0045 80);
  --paper-12: oklch(0.22 0.003 80);
  --ink: oklch(0.4727 0.1241 258.67);
  --ink-hover: oklch(0.4377 0.1217 258.67);
  --ink-text: oklch(0.44 0.124 258.67);
  --ink-soft: oklch(0.89 0.03 250);
  --ink-line: oklch(0.68 0.08 258.67);
  /* Amber as it reads on paper, not the night value. */
  --amber: #ffc53d;
  --amber-line: #f3d673;
  --amber-text: #ab6400;
  --amber-soft: #fefbe9;
  color: var(--paper-12);
}

/* The nav sits on the desk on the landing page. */
:root:has(.landing) {
  --vp-nav-bg-color: var(--desk);
}
:root:has(.landing) .VPNav,
:root:has(.landing) .VPNavBar,
:root:has(.landing) .VPNavBar .content-body,
:root:has(.landing) .VPNavBar .title {
  background: var(--desk) !important;
}
:root:has(.landing) .VPNavBar .divider-line,
:root:has(.landing) .VPLocalNav {
  display: none;
}
.dark .night {
  background: oklch(0.118 0.0015 80);
}
:root:has(.landing) .VPContent {
  background: var(--desk);
}
</style>
