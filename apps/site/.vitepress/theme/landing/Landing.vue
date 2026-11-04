<script setup lang="ts">
import { withBase } from "vitepress";
import { onBeforeUnmount, onMounted, ref } from "vue";
import DemoClip from "./DemoClip.vue";
import SheetStack from "./SheetStack.vue";

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
let io: IntersectionObserver | null = null;
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

onMounted(() => {
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Sheets below the fold are laid down as they arrive; anything already on screen stays put.
  const pending = [...(root.value?.querySelectorAll<HTMLElement>("[data-lay]") ?? [])].filter(
    (el) => el.getBoundingClientRect().top > window.innerHeight * 0.9,
  );
  for (const el of pending) el.classList.add("to-lay");
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("laid");
        io?.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
  );
  for (const el of pending) io.observe(el);
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  cancelAnimationFrame(raf);
  io?.disconnect();
});
</script>

<template>
  <div ref="root" class="landing">
    <!-- The spread: an open notebook. -->
    <div ref="spread" class="spread-track">
    <section class="spread" aria-labelledby="hero-title">
      <div class="book">
        <div class="page left">
          <p class="run-head"><span>Psyche</span><span>open source · alpha</span></p>
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
          <p class="run-head"><span>~/.psyche</span><span>what it keeps</span></p>
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

    <!-- Memory. -->
    <section class="leaf memory" data-lay aria-labelledby="memory-title">
      <p class="run-head"><span>workspace/MEMORY.md</span><span>Memory</span></p>
      <div class="split">
        <div class="copy">
          <h2 id="memory-title">It remembers the way you would, if you wrote everything down.</h2>
          <p>
            People, projects, open loops and what you prefer, gathered from your mail, messages and
            notes. Each fact keeps a note of where it came from, and anything Psyche would act on
            waits for you to confirm it.
          </p>
          <p>
            The persona and memory files are Markdown you can edit. Change a line and the agent
            follows it.
          </p>
          <a class="more" :href="withBase('/using/memory')">How memory works</a>
        </div>
        <DemoClip name="memory" :ratio="1600 / 1088" label="Psyche's Memory page showing a person, their facts with sources, and open loops">
          <b>Memory → Sam Lee.</b> Facts carry their source: “From Sam Lee's mail, Oct 12.” A loop it
          found in mail waits for your Confirm.
        </DemoClip>
      </div>
    </section>

    <!-- Search and Home, as two facing pages. -->
    <section class="two-up" aria-label="Search and Home">
      <article class="leaf half" data-lay aria-labelledby="search-title">
        <p class="run-head"><span>⌘K</span><span>Search</span></p>
        <h2 id="search-title">Ask once. Search the whole Mac.</h2>
        <p>
          Threads, messages, tasks, memory, your Library and the Feed, in one box. The index is
          built and kept on this machine.
        </p>
        <DemoClip name="search" :ratio="1600 / 1024" label="The Search palette finding a dentist booking across threads, messages, tasks and the feed">
          <b>Search ⌘K</b>, typing “dentist”: a thread, your own message, the running task and the
          morning brief.
        </DemoClip>
      </article>
      <article class="leaf half" data-lay aria-labelledby="home-title">
        <p class="run-head"><span>Home</span><span>Catch up</span></p>
        <h2 id="home-title">Catch up in a minute.</h2>
        <p>
          What needs you, what moved since you last looked, and a brief whose lines point to their
          sources. The Feed behind the brief is still being finished.
        </p>
        <DemoClip name="home" :ratio="1600 / 1088" label="Psyche's Home: two items that need you, a catch-up list, and a morning brief with numbered sources">
          <b>Home.</b> Two things wait on you; the brief cites Calendar, Gmail and acme.com.
        </DemoClip>
      </article>
    </section>

    <!-- Approvals: the desk at night. -->
    <section class="night" aria-labelledby="approve-title">
      <div class="night-inner">
        <div class="copy" data-lay>
          <p class="run-head"><span>Permission Broker</span><span>Approvals</span></p>
          <h2 id="approve-title">Nothing changes until you say so.</h2>
          <p>
            Sending, buying, filling a password or running a command stops at an approval card
            that shows the exact action and binds to it. Text from a web page, an email or a file
            can never approve anything. Purchases and password fills ask for Touch ID.
          </p>
          <ul class="facts">
            <li>Approve from the app or a paired device; the first answer wins.</li>
            <li>Passwords and keys stay in an encrypted vault. The model only sees placeholders.</li>
            <li>A command sandbox with no network unless you allow a domain.</li>
          </ul>
          <a class="more" :href="withBase('/security/approvals-and-tiers')">Approvals and app tiers</a>
        </div>
        <div data-lay>
          <DemoClip name="approval" :ratio="1600 / 1000" label="An approval card for filling a saved login, then the next card, an email to send, after Allow">
            <b>Dentist booking.</b> Allow the vault fill, and the next card, the email to Jane, takes
            its place.
          </DemoClip>
        </div>
      </div>
    </section>

    <!-- Receipts. -->
    <section class="leaf receipts" data-lay aria-labelledby="receipt-title">
      <p class="run-head"><span>audit/</span><span>Receipts</span></p>
      <div class="split flip">
        <DemoClip name="chat" :ratio="1600 / 1088" label="A chat where Psyche plans a dentist booking, shows each step it ran, and records the email it sent">
          <b>Chat.</b> The plan, each step it ran, and what it sent, with the Gmail id and the time.
        </DemoClip>
        <div class="copy">
          <h2 id="receipt-title">Every write leaves a receipt.</h2>
          <p>
            When Psyche sends, books or saves something, it records what it did, where, and who
            allowed it. The audit log is hash-chained, so an edit after the fact shows.
          </p>
          <ol class="ledger-lines" aria-label="Example receipts (fictional)">
            <li><time>10:06</time> Sent email to jane.ortiz@example.com <span>Gmail · allowed once</span></li>
            <li><time>10:04</time> Held Tue Oct 20, 2:30 pm on acme.com <span>browser · task</span></li>
            <li><time>09:58</time> Read your calendar for Oct 19–23 <span>read · no approval</span></li>
          </ol>
          <a class="more" :href="withBase('/security/audit-log')">The audit log</a>
        </div>
      </div>
    </section>

    <!-- What stays on the Mac. -->
    <section class="leaf stays" data-lay aria-labelledby="stays-title">
      <p class="run-head"><span>security/on-device</span><span>Where your data lives</span></p>
      <h2 id="stays-title">What stays on your Mac.</h2>
      <p class="lede">
        Everything lives under <code>~/.psyche</code>, on hardware you control. No hosted service
        holds your threads, memory or skills.
      </p>
      <table class="stays-table">
        <thead>
          <tr><th scope="col">What</th><th scope="col">Where</th><th scope="col">How it is kept</th></tr>
        </thead>
        <tbody>
          <tr><th scope="row">Memory and persona</th><td><code>workspace/</code></td><td>Plain Markdown, by design</td></tr>
          <tr><th scope="row">Threads, tasks, receipts</th><td><code>state/psyche.sqlite</code></td><td>On your disk; turn on FileVault</td></tr>
          <tr><th scope="row">Passwords and keys</th><td><code>vault/</code></td><td>Encrypted (SQLCipher); filled at the last step</td></tr>
          <tr><th scope="row">Audit log</th><td><code>audit/</code></td><td>Hash-chained, so tampering shows</td></tr>
          <tr><th scope="row">Model calls</th><td>The Gateway only</td><td>Any provider, or none: Ollama, llama.cpp, LM Studio</td></tr>
          <tr><th scope="row">Telemetry</th><td>None</td><td>No analytics, crash reports or phone-home</td></tr>
        </tbody>
      </table>
      <a class="more" :href="withBase('/security/on-device')">What stays on your machine, in full</a>
    </section>

    <!-- Honest status. -->
    <section class="leaf status-page" data-lay aria-labelledby="status-title">
      <p class="run-head"><span>release-notes/0.3</span><span>Status</span></p>
      <h2 id="status-title">Alpha, and plain about it.</h2>
      <div class="columns">
        <div>
          <h3>Works today</h3>
          <ul>
            <li>One ongoing chat with side chats, and replies that carry files, mail and live artifacts</li>
            <li>Screen Ask: a hotkey panel over whatever you are looking at</li>
            <li>On-device Search across threads, files and memory</li>
            <li>Apple Notes, Reminders, Calendar and Mail; Gmail and Google Calendar with your own OAuth client; MCP servers</li>
            <li>Approval cards with receipts, a browser you can watch and take over, a no-network sandbox</li>
            <li>Dictation: hold a key, speak, and review the words before they go</li>
            <li>Any model: Anthropic, OpenAI, Ollama and other compatible providers</li>
          </ul>
        </div>
        <div>
          <h3>Not yet</h3>
          <ul class="not-yet">
            <li>A signed release. Today you build the Mac app from source</li>
            <li>Windows. Linux runs the Gateway in server mode, not the desktop app</li>
            <li>The Feed, background specialists and meeting capture are still being built</li>
          </ul>
          <p class="origin">
            Psyche began as an open-source take on Meta's Muse: one agent that knows your life,
            rebuilt to run on hardware you own, with the model you choose.
          </p>
        </div>
      </div>
    </section>

    <!-- Close. -->
    <section class="close" data-lay aria-labelledby="close-title">
      <h2 id="close-title">Clone it. Build it. Read every file.</h2>
      <div class="terminal">
        <div class="terminal-head">
          <span>Terminal · Node 24+, pnpm 12+</span>
          <button type="button" class="copy-btn" @click="copyInstall">
            {{ copied ? "Copied" : "Copy" }}
          </button>
          <span class="sr-only" aria-live="polite">{{ copied ? "Commands copied" : "" }}</span>
        </div>
        <pre><code>{{ install }}</code></pre>
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
  display: flex;
  justify-content: space-between;
  gap: 16px;
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
.run-head span:last-child {
  font-family: var(--font-text);
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
.night h2,
.close h2 {
  font-size: clamp(32px, 3.7vw, 54px);
  line-height: 1.04;
  letter-spacing: -0.022em;
  max-width: 17ch;
}
.copy p,
.half > p,
.lede {
  margin-top: 20px;
  font-size: 17.5px;
  line-height: 1.6;
  color: var(--paper-11);
  max-width: 36em;
}
.copy p + p {
  margin-top: 14px;
}
.more {
  display: inline-block;
  margin-top: 24px;
  font-weight: 550;
  font-size: 15.5px;
  color: var(--ink-text);
  text-decoration: underline;
  text-decoration-color: var(--ink-line);
  text-underline-offset: 4px;
  transition: text-decoration-color 0.15s;
}
.more::after {
  content: " →";
}
.more:hover {
  text-decoration-color: currentColor;
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: clamp(28px, 5vw, 88px);
  align-items: center;
}
.split.flip {
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
}

/* Two facing pages. */
.two-up {
  max-width: 1480px;
  margin: clamp(40px, 7vw, 112px) auto 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: clamp(16px, 2vw, 28px);
  align-items: start;
}
.two-up .leaf {
  margin: 0;
}
.two-up .half:nth-child(2) {
  margin-top: clamp(0px, 8vw, 120px);
}
.half h2 {
  font-size: clamp(30px, 3vw, 44px);
}
.half > p {
  margin-bottom: clamp(28px, 3vw, 44px);
}

/* ---------- Night ---------- */
.night {
  --paper-12: oklch(0.949 0.003 80);
  --paper-11: oklch(0.79 0.0045 80);
  --paper-9: oklch(0.62 0.005 80);
  --paper-6: oklch(0.348 0.004 80);
  --paper-5: oklch(0.313 0.0035 80);
  --paper-3: oklch(0.252 0.0025 80);
  --ink-text: oklch(0.8 0.077 258.67);
  --ink-line: oklch(0.55 0.0819 258.67);
  margin: clamp(56px, 9vw, 144px) calc(var(--gutter-x) * -1) 0;
  padding: clamp(64px, 9vw, 140px) var(--gutter-x);
  background: oklch(0.165 0.002 80);
  color: var(--paper-12);
  position: relative;
  overflow: hidden;
}
.night::before {
  /* One lamp, off to the upper left. */
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse 60% 70% at 18% 0%,
    oklch(0.95 0.02 85 / 0.07),
    transparent 70%
  );
  pointer-events: none;
}
.night-inner {
  position: relative;
  max-width: 1480px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: clamp(28px, 5vw, 88px);
  align-items: center;
}
.facts {
  list-style: none;
  padding: 0;
  margin: 28px 0 0;
  border-top: 1px solid var(--paper-5);
  max-width: 36em;
}
.facts li {
  padding: 12px 0;
  border-bottom: 1px solid var(--paper-5);
  font-size: 15.5px;
  line-height: 1.5;
  color: var(--paper-11);
}

/* ---------- Receipts ---------- */
.ledger-lines {
  list-style: none;
  padding: 0;
  margin: 28px 0 0;
  font-size: 14.5px;
  border-top: 1px solid var(--paper-5);
}
.ledger-lines li {
  display: grid;
  grid-template-columns: 4.2em 1fr;
  column-gap: 8px;
  padding: 10px 0;
  border-bottom: 1px dashed var(--paper-6);
  line-height: 1.45;
}
.ledger-lines time {
  font-family: var(--font-code);
  font-variant-numeric: tabular-nums;
  color: var(--paper-9);
  grid-row: span 2;
}
.ledger-lines span {
  color: var(--paper-9);
  font-size: 13px;
}

/* ---------- What stays ---------- */
.stays-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: clamp(28px, 3.5vw, 48px);
  font-size: 15.5px;
}
.stays-table th,
.stays-table td {
  text-align: left;
  padding: 16px 20px 16px 0;
  border-bottom: 1px solid var(--paper-5);
  vertical-align: baseline;
  line-height: 1.45;
}
.stays-table thead th {
  font-size: 13px;
  font-weight: 500;
  color: var(--paper-9);
  border-bottom-color: var(--paper-7);
  padding-top: 0;
}
.stays-table tbody th {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 500;
  width: 30%;
}
.stays-table td:nth-child(2) {
  width: 26%;
  color: var(--paper-11);
}
.stays-table td:last-child {
  color: var(--paper-11);
}
.stays-table code {
  background: none;
  border: none;
  padding: 0;
  color: var(--paper-12);
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

/* ---------- Laying sheets down ---------- */
.to-lay {
  transform: translateY(28px) rotate(-0.4deg);
  box-shadow: var(--shadow-lift);
  transition:
    transform 1s var(--ease-out),
    box-shadow 1.1s var(--ease-out);
}
.to-lay .run-head::after,
.to-lay.run-head::after {
  transform: scaleX(0);
  transition: transform 1.2s var(--ease-out) 0.25s;
}
.to-lay.laid {
  transform: none;
  box-shadow: var(--shadow-sheet);
}
.to-lay.laid .run-head::after {
  transform: none;
}
.night .to-lay,
.close.to-lay {
  box-shadow: none;
}
.night .to-lay.laid,
.close.to-lay.laid {
  box-shadow: none;
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
  .split,
  .split.flip,
  .night-inner,
  .two-up,
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
  .split.flip > .clip {
    order: 2;
  }
  .two-up .half:nth-child(2) {
    margin-top: 0;
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
  .run-head span:last-child {
    display: none;
  }
  .stays-table thead {
    display: none;
  }
  .stays-table,
  .stays-table tbody,
  .stays-table tr,
  .stays-table th,
  .stays-table td {
    display: block;
    width: auto !important;
  }
  .stays-table tr {
    padding: 14px 0;
    border-bottom: 1px solid var(--paper-5);
  }
  .stays-table th,
  .stays-table td {
    border: none;
    padding: 2px 0;
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
