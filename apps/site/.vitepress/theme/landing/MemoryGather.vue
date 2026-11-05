<script setup lang="ts">
/**
 * Memory being gathered: scraps of mail, a chat message and a calendar entry travel into
 * MEMORY.md, and each becomes a line that keeps its source. Driven by the parent scene's `--p`.
 * Fictional data, the same people and events as the app's fixtures.
 */
const ITEMS = [
  {
    kind: "Mail",
    from: "Sam Lee · Oct 12",
    body: "Heads up, I'm moving to Berlin in the spring.",
    line: "Sam Lee is moving to Berlin in the spring.",
    cite: "mail · Oct 12",
  },
  {
    kind: "Chat",
    from: "You · 10:02",
    body: "Book the dentist next week. Mornings are bad.",
    line: "Mornings are bad for appointments.",
    cite: "chat · Oct 18",
  },
  {
    kind: "Calendar",
    from: "Tue Oct 20",
    body: "2:30 pm · Dr. Ortiz · on hold",
    line: "Dentist hold: Tue Oct 20, 2:30 pm.",
    cite: "calendar · Oct 18",
  },
];
</script>

<template>
  <figure class="gather" aria-label="Illustration: three scraps (an email from Sam Lee, your chat message, a calendar hold) become lines in MEMORY.md, each with its source">
    <ol class="scraps" aria-hidden="true">
      <li v-for="(it, i) in ITEMS" :key="it.kind" class="scrap" :class="`s${i}`" :style="{ '--i': i }">
        <span class="scrap-head"><b>{{ it.kind }}</b> {{ it.from }}</span>
        <span class="scrap-body">{{ it.body }}</span>
      </li>
    </ol>
    <div class="sheet" aria-hidden="true">
      <p class="file">workspace/MEMORY.md</p>
      <p class="title">Memory</p>
      <p class="h">People and plans</p>
      <div class="lines">
        <p v-for="(it, i) in ITEMS" :key="it.line" class="line" :class="`l${i}`" :style="{ '--i': i }">
          <span class="text">– {{ it.line }}</span>
          <span class="chip">{{ it.cite }}</span>
        </p>
      </div>
      <div class="kept">
        <p class="h">Open loops</p>
        <p class="old">– Send Sam the revised budget, due Oct 21.</p>
      </div>
    </div>
    <figcaption>Illustration with fictional data. The real Memory page is below.</figcaption>
  </figure>
</template>

<style scoped>
/*
 * Timeline per item i (as a share of the scene's --p):
 *   move   a .. a + .22    the scrap travels to its line and shrinks away
 *   write  a + .12 .. +.14 the line is written in from the left
 *   cite   a + .22 .. +.06 the source chip snaps on
 * with a = .06 + i × .26.
 */
.gather {
  --a: calc(0.06 + var(--i, 0) * 0.26);
  margin: 0;
  position: relative;
  font-size: clamp(11.5px, 0.98vw, 15px);
  width: 46em;
  max-width: 100%;
  height: 33em;
}
.scraps {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
  z-index: 2;
}
.scrap {
  --a: calc(0.06 + var(--i) * 0.26);
  --m: clamp(0, calc((var(--p, 1) - var(--a)) / 0.22), 1);
  /* Eased: 1 - (1 - m)^2. */
  --e: calc(1 - (1 - var(--m)) * (1 - var(--m)));
  position: absolute;
  left: 0;
  width: 16em;
  padding: 0.8em 1em 0.9em;
  border-radius: 0.5em;
  background: var(--sheet);
  box-shadow:
    0 0 0 1px var(--paper-5),
    0 0.5em 1.2em -0.6em oklch(0.2 0.01 80 / 0.25);
  display: flex;
  flex-direction: column;
  gap: 0.3em;
  transform: translate(calc(var(--e) * var(--tx)), calc(var(--e) * var(--ty)))
    rotate(calc((1 - var(--e)) * var(--r)))
    scale(calc(1 - var(--e) * 0.55));
  transform-origin: left center;
  opacity: calc(1 - clamp(0, calc((var(--m) - 0.7) / 0.3), 1));
  will-change: transform;
}
.s0 {
  top: 6.4em;
  --tx: 22.6em;
  --ty: 2.5em;
  --r: -3deg;
}
.s1 {
  top: 14.4em;
  --tx: 22.6em;
  --ty: -0.5em;
  --r: 2.5deg;
}
.s2 {
  top: 22.4em;
  --tx: 22.6em;
  --ty: -3.5em;
  --r: -1.5deg;
}
.scrap-head {
  font-size: 0.82em;
  color: var(--paper-11);
}
.scrap-head b {
  color: var(--paper-12);
  font-weight: 600;
}
.scrap-body {
  font-size: 0.95em;
  line-height: 1.4;
  color: var(--paper-12);
}

.sheet {
  position: absolute;
  left: 20em;
  top: 0;
  width: 26em;
  height: 33em;
  padding: 2em 2.2em 2em 2.6em;
  background: var(--sheet);
  color: var(--paper-12);
  border-radius: 0.25em;
  box-shadow: var(--shadow-sheet);
}
.sheet::before {
  content: "";
  position: absolute;
  left: 1.5em;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--paper-5);
}
.file {
  margin: 0 0 1.4em;
  padding-bottom: 0.7em;
  border-bottom: 1px solid var(--paper-5);
  font: 500 0.92em/1 var(--font-code);
  color: var(--paper-11);
}
.title {
  margin: 0;
  font: 500 2.6em/1 var(--font-display);
}
.h {
  margin: 0;
  font-weight: 600;
  position: absolute;
  top: 8em;
}
/* Fixed line slots, so each scrap knows where its line is written. */
.lines {
  position: absolute;
  left: 2.6em;
  right: 2.2em;
  top: 9.6em;
}
.kept {
  position: absolute;
  left: 2.6em;
  right: 2.2em;
  top: 26em;
}
.kept .h {
  position: static;
  margin-bottom: 0.4em;
}
.old {
  margin: 0;
  color: var(--paper-11);
  line-height: 1.45;
}
.line {
  --a: calc(0.06 + var(--i) * 0.26);
  --w: clamp(0, calc((var(--p, 1) - var(--a) - 0.12) / 0.14), 1);
  --c: clamp(0, calc((var(--p, 1) - var(--a) - 0.22) / 0.06), 1);
  margin: 0;
  height: 5em;
  line-height: 1.45;
}
.text {
  display: block;
  font-size: 1.06em;
  clip-path: inset(0 calc((1 - var(--w)) * 100%) 0 0);
}
.chip {
  display: inline-block;
  margin: 0.35em 0 0 0.9em;
  padding: 0.1em 0.5em;
  border-radius: 0.3em;
  background: var(--ink-soft);
  color: var(--ink-text);
  font: 400 0.82em/1.5 var(--font-code);
  opacity: var(--c);
  transform: scale(calc(0.7 + var(--c) * 0.3));
  transform-origin: left center;
}
figcaption {
  position: absolute;
  left: 20em;
  bottom: -2.2em;
  font-size: 0.85em;
  color: var(--paper-11);
}

/* Phone: the scraps sit above the sheet and drop into it. */
@media (max-width: 700px) {
  .gather {
    font-size: 13px;
    width: 100%;
    height: 47em;
  }
  .scrap {
    width: calc(100% - 2em);
    left: 1em;
  }
  .s0 {
    top: 0;
    --tx: 0em;
    --ty: 25.4em;
  }
  .s1 {
    top: 4.6em;
    --tx: 0em;
    --ty: 25.4em;
  }
  .s2 {
    top: 9.2em;
    --tx: 0em;
    --ty: 25.4em;
  }
  .sheet {
    left: 0;
    top: 14.5em;
    width: 100%;
    height: 30em;
  }
  figcaption {
    left: 0;
    bottom: -0.5em;
  }
}
</style>
