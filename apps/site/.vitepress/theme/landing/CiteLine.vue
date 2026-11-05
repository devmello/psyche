<script setup lang="ts">
/**
 * A claim getting its source chip: Home's morning brief (fixture text), read in by the scroll.
 * Each clause inks in word by word; when a clause is complete, its numbered source chip snaps on
 * and a hairline underlines the claim. The sources line lands last.
 */
const CLAUSES = [
  { text: "Your dentist hold for Tuesday 2:30 still needs a confirmation.", n: 1, src: "Calendar" },
  { text: "Jane at the front desk replies within the hour on weekdays.", n: 2, src: "Gmail" },
  { text: "acme.com closes online booking for next week at 6 pm today.", n: 3, src: "acme.com" },
];

// Global word positions, so the read-in runs across all three clauses in order.
let index = 0;
const words = CLAUSES.map((c) => {
  const list = c.text.split(" ").map((w) => ({ w, i: index++ }));
  return { ...c, list, end: index };
});
const total = index;
</script>

<template>
  <figure class="cite" :style="{ '--n': total }">
    <blockquote>
      <p class="brief">
        <template v-for="c in words" :key="c.n">
          <span class="clause" :style="{ '--end': c.end }"><template v-for="w in c.list" :key="w.i"><span class="w" :style="{ '--i': w.i }">{{ w.w }}</span>{{ " " }}</template></span><sup class="chip" :style="{ '--end': c.end }"
            ><span class="sr-only">Source {{ c.n }}, {{ c.src }}: </span>{{ c.n }}</sup
          >{{ " " }}
        </template>
      </p>
    </blockquote>
    <figcaption>
      <span class="sources">Sources (3) · Calendar · Gmail · acme.com</span>
      <span class="note">From the morning brief on Home. Fictional data.</span>
    </figcaption>
  </figure>
</template>

<style scoped>
/* --r is the read-in position, in words: it runs a little past the end so the last chip lands. */
.cite {
  --r: calc(var(--p, 1) * (var(--n) + 6) - 2);
  margin: 0;
  max-width: 1120px;
}
.brief {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 450;
  font-size: clamp(28px, 3.9vw, 58px);
  line-height: 1.22;
  letter-spacing: -0.018em;
  color: var(--paper-12);
  text-wrap: pretty;
}
.w {
  opacity: clamp(0.16, calc(var(--r) - var(--i)), 1);
}
.clause {
  /* Underline the claim once it is complete and cited. */
  --u: clamp(0, calc((var(--r) - var(--end)) / 1.5), 1);
  background-image: linear-gradient(var(--ink-line), var(--ink-line));
  background-repeat: no-repeat;
  background-size: calc(var(--u) * 100%) 1px;
  background-position: 0 92%;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.chip {
  --c: clamp(0, calc((var(--r) - var(--end)) / 0.8), 1);
  display: inline-grid;
  place-items: center;
  vertical-align: 0.5em;
  position: relative;
  min-width: 1.15em;
  height: 1.15em;
  margin-left: 0.12em;
  padding: 0 0.22em;
  border-radius: 0.2em;
  background: var(--ink-soft);
  color: var(--ink-text);
  font: 500 0.36em/1 var(--font-code);
  text-decoration: none;
  opacity: var(--c);
  transform: translateY(calc((1 - var(--c)) * -0.6em)) scale(calc(0.6 + var(--c) * 0.4));
}
figcaption {
  --s: clamp(0, calc((var(--r) - var(--n) - 2) / 2), 1);
  margin-top: clamp(24px, 3vw, 40px);
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  font-size: 14px;
  color: var(--paper-11);
  opacity: var(--s);
  transform: translateY(calc((1 - var(--s)) * 10px));
}
.sources {
  font-family: var(--font-code);
  font-size: 13px;
  color: var(--paper-12);
}
</style>
