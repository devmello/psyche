<script setup lang="ts">
/**
 * An approval card stopping an action, scrubbed by the parent scene's `--p`:
 *   .04–.32  the "send email" step runs along the rail toward the broker;
 *   .26–.40  the approval card drops in and the step stops, waiting on you;
 *   .52–.60  Allow once is pressed;
 *   .60–.80  the gate lifts and the step runs to the end, now Sent;
 *   .80–.96  a receipt prints.
 * Fictional data from the app's fixtures.
 */
</script>

<template>
  <figure
    class="gate"
    role="img"
    aria-label="Illustration: a step that sends an email to jane.ortiz@example.com stops at an approval card. Once you allow it, the email is sent and a receipt is recorded."
  >
    <div class="rail" aria-hidden="true">
      <span class="node start">Wren · Dentist booking</span>
      <span class="track"><span class="fill" /></span>
      <span class="node end">Gmail</span>
    </div>
    <div class="step" aria-hidden="true">
      <span class="step-status">
        <span class="s-run">Running</span>
        <span class="s-wait">Waiting for your approval</span>
        <span class="s-ok">Allowed · sending</span>
        <span class="s-done">Sent</span>
      </span>
      <span class="step-title">Send “Confirming Tuesday 2:30” to jane.ortiz@example.com</span>
    </div>
    <div class="bar" aria-hidden="true" />
    <div class="card" aria-hidden="true">
      <p class="c-head">Approval needed · expires in 28:41</p>
      <p class="c-title">Send an email to jane.ortiz@example.com</p>
      <p class="c-row"><span>To</span>jane.ortiz@example.com (exact recipient)</p>
      <p class="c-row"><span>Subject</span>Confirming Tuesday 2:30</p>
      <p class="c-actions">
        <span class="deny">Deny</span><span class="allow">Allow once</span>
      </p>
      <p class="c-done">Allowed once by you · 10:06</p>
    </div>
    <div class="receipt" aria-hidden="true">
      <p class="r-head">audit/2026-10.jsonl</p>
      <p>Sent email to jane.ortiz@example.com</p>
      <p class="r-meta">Gmail · id 18c4… · allowed once · 10:06</p>
    </div>
  </figure>
</template>

<style scoped>
.gate {
  --p0: var(--p, 1);
  --run: clamp(0, calc((var(--p0) - 0.04) / 0.28), 1);
  --stop: clamp(0, calc((var(--p0) - 0.26) / 0.14), 1);
  --press: clamp(0, calc((var(--p0) - 0.52) / 0.08), 1);
  --go: clamp(0, calc((var(--p0) - 0.6) / 0.2), 1);
  --print: clamp(0, calc((var(--p0) - 0.8) / 0.16), 1);
  --fold: clamp(0, calc((var(--p0) - 0.68) / 0.12), 1);
  /* Phase flags (0 or 1) for the step's status line. */
  --waiting: clamp(0, calc((var(--stop) - 0.5) * 100), 1);
  --sent: clamp(0, calc((var(--go) - 0.6) * 100), 1);
  --allowed: clamp(0, calc((var(--press) - 0.5) * 100), 1);
  margin: 0;
  position: relative;
  font-size: clamp(11.5px, 0.95vw, 14.5px);
  width: 44em;
  max-width: 100%;
  height: 25em;
}
.rail {
  position: absolute;
  left: 0;
  right: 0;
  top: 1.2em;
  display: flex;
  align-items: center;
  gap: 0.8em;
  font-size: 0.85em;
  color: var(--paper-11);
}
.track {
  flex: 1;
  height: 2px;
  background: var(--paper-5);
  position: relative;
  overflow: hidden;
}
.fill {
  position: absolute;
  inset: 0;
  background: var(--ink);
  transform-origin: left;
  transform: scaleX(calc(var(--run) * 0.55 + var(--go) * 0.45));
}
.step {
  position: absolute;
  top: 3.4em;
  left: 0;
  width: 19em;
  padding: 0.8em 1em;
  border-radius: 0.5em;
  background: var(--sheet);
  box-shadow:
    0 0 0 1px var(--paper-6),
    0 0.5em 1.2em -0.7em oklch(0.2 0.01 80 / 0.3);
  /* Runs to the gate (x 13em), waits, then carries on to x 25em. */
  transform: translateX(calc(var(--run) * 13em + var(--go) * 12em));
}
.step-status {
  display: grid;
  font-size: 0.82em;
  margin-bottom: 0.3em;
}
.step-status > span {
  grid-area: 1 / 1;
}
.s-run {
  color: var(--paper-11);
  opacity: calc(1 - var(--waiting));
}
.s-wait {
  color: var(--amber-text);
  font-weight: 600;
  opacity: calc(var(--waiting) - var(--allowed));
}
.s-ok {
  color: var(--ink-text);
  opacity: calc(var(--allowed) - var(--sent));
}
.s-done {
  color: var(--ink-text);
  font-weight: 600;
  opacity: var(--sent);
}
.step-title {
  font-size: 0.95em;
  line-height: 1.4;
  color: var(--paper-12);
}
/* The broker's line across the rail: the action cannot pass until you answer. */
.bar {
  position: absolute;
  left: 33em;
  top: 0;
  width: 3px;
  height: 9em;
  border-radius: 2px;
  background: var(--amber);
  transform-origin: top;
  transform: scaleY(calc(var(--stop) * (1 - var(--go))));
}
.card {
  position: absolute;
  left: 15em;
  top: 11.2em;
  width: 24em;
  padding: 1.1em 1.3em 1.2em;
  border-radius: 0.6em;
  background: var(--sheet);
  box-shadow:
    inset 0 0 0 1px var(--amber-line),
    0 1em 2em -1em oklch(0.2 0.01 80 / 0.35);
  /* Drops in when the step arrives; folds away once allowed, and the receipt takes its place. */
  clip-path: inset(0 0 calc(max(1 - var(--stop), var(--fold)) * 100%) 0 round 0.6em);
  transform: translateY(calc((1 - var(--stop)) * -1.2em - var(--fold) * 1em));
}
.card p {
  margin: 0;
}
.c-head {
  font-size: 0.8em;
  color: var(--amber-text);
  margin-bottom: 0.4em !important;
}
.c-title {
  font-weight: 600;
  font-size: 1.05em;
  margin-bottom: 0.7em !important;
}
.c-row {
  display: flex;
  gap: 1em;
  font-size: 0.88em;
  padding: 0.35em 0;
  border-top: 1px solid var(--paper-5);
}
.c-row span {
  width: 4.6em;
  color: var(--paper-11);
}
.c-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5em;
  margin-top: 0.8em !important;
  font-size: 0.88em;
  font-weight: 550;
}
.c-actions span {
  padding: 0.45em 0.9em;
  border-radius: 0.45em;
  border: 1px solid var(--paper-7);
}
.allow {
  background: var(--ink);
  border-color: var(--ink) !important;
  color: #fff;
  /* Pressed: a short dip and a darker fill. */
  transform: scale(calc(1 - var(--press) * (1 - var(--press)) * 0.24));
  box-shadow: 0 0 0 calc(var(--press) * (1 - var(--go)) * 4px) var(--ink-soft-2);
}
.c-done {
  margin-top: 0.6em !important;
  font-size: 0.82em;
  color: var(--ink-text);
  opacity: var(--press);
}
.receipt {
  position: absolute;
  left: 15em;
  top: 11.2em;
  width: 24em;
  padding: 0.9em 1.1em;
  border-radius: 0.3em;
  background: var(--sheet);
  color: var(--paper-12);
  box-shadow: var(--shadow-sheet);
  font-size: 0.9em;
  clip-path: inset(0 0 calc((1 - var(--print)) * 100%) 0);
  transform: translateY(calc((1 - var(--print)) * -0.8em));
}
.receipt p {
  margin: 0 0 0.25em;
}
.r-head {
  font: 500 0.85em/1.4 var(--font-code);
  color: var(--paper-11);
  border-bottom: 1px solid var(--paper-5);
  padding-bottom: 0.4em;
  margin-bottom: 0.5em !important;
}
.r-meta {
  font: 400 0.85em/1.4 var(--font-code);
  color: var(--paper-11);
}

@media (max-width: 700px) {
  .gate {
    font-size: 12.5px;
    width: 100%;
    height: 30em;
  }
  .step {
    width: 17em;
    transform: translateX(calc(var(--run) * 3em + var(--go) * 6em));
  }
  .bar {
    left: auto;
    right: 3.5em;
  }
  .card {
    left: 0;
    width: 100%;
    top: 13em;
  }
  .receipt {
    left: 0;
    top: 13em;
    width: 100%;
  }
}
</style>
