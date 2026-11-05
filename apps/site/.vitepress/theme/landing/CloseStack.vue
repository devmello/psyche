<script setup lang="ts">
import { SHEETS } from "./sheet-data";

/**
 * The hero's stack, back at the close: the four files arrive fanned, the way the hero left them,
 * and settle into one squared pile as the close arrives (the parent scene's eased `--q`).
 */
</script>

<template>
  <div class="pile" aria-hidden="true">
    <div
      v-for="(s, i) in SHEETS"
      :key="s.id"
      class="leafy"
      :class="`kind-${s.kind}`"
      :style="{ '--i': i, '--o': i - (SHEETS.length - 1) / 2 }"
    >
      <span class="head">{{ s.file }}</span>
      <span class="title">{{ s.lines.find((l) => l.t === "h1")?.text }}</span>
      <span v-for="(l, j) in s.lines.filter((x) => x.t === 'li').slice(0, 3)" :key="j" class="li">
        – {{ l.t === "li" ? l.text : "" }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.pile {
  --s: var(--q, 1);
  position: relative;
  width: 200px;
  height: 230px;
  margin: 0 auto clamp(28px, 4vw, 48px);
}
.leafy {
  position: absolute;
  inset: 0;
  width: 172px;
  height: 222px;
  margin: 0 auto;
  padding: 16px 16px 0 22px;
  border-radius: 3px;
  background: var(--sheet);
  box-shadow: var(--shadow-sheet);
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  /* Fanned (s = 0) → squared, with a hair of offset so it still reads as four sheets. */
  transform: translateX(calc((1 - var(--s)) * var(--o) * 118px + var(--o) * 1.5px))
    translateY(calc((1 - var(--s)) * (var(--o) * var(--o)) * 9px - var(--i) * 1.5px))
    rotate(calc((1 - var(--s)) * var(--o) * 9deg + var(--o) * 0.6deg));
}
.leafy::before {
  content: "";
  position: absolute;
  left: 11px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--paper-5);
}
.kind-approval {
  box-shadow:
    inset 0 0 0 1.5px var(--amber-line),
    var(--shadow-sheet);
}
.head {
  font: 500 10.5px/1.3 var(--font-code);
  color: var(--paper-11);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--paper-5);
}
.title {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font: 500 17px/1.15 var(--font-display);
  color: var(--paper-12);
  text-align: left;
}
.li {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--paper-12);
  text-align: left;
  margin-top: -4px;
}
@media (max-width: 560px) {
  .leafy {
    transform: translateX(calc((1 - var(--s)) * var(--o) * 64px + var(--o) * 1.5px))
      translateY(calc((1 - var(--s)) * (var(--o) * var(--o)) * 7px - var(--i) * 1.5px))
      rotate(calc((1 - var(--s)) * var(--o) * 7deg + var(--o) * 0.6deg));
  }
}
</style>
