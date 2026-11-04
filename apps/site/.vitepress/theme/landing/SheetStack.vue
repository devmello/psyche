<script setup lang="ts">
import { useData } from "vitepress";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SHEETS } from "./sheet-data";
import type { SheetScene } from "./sheet-scene";

/**
 * The hero's stack of sheets. The HTML stack paints first, carries the text for screen readers,
 * and stays as the picture with reduced motion or without WebGL. Otherwise three.js loads after
 * first paint and draws the same sheets in 3D over it.
 */
const props = defineProps<{ progress: number }>();
const { isDark } = useData();
const host = ref<HTMLElement | null>(null);
const live = ref(false);
let scene: SheetScene | null = null;
let cancelled = false;

function webglOk(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !webglOk()) return;
  const start = async () => {
    const { mountSheetScene } = await import("./sheet-scene");
    if (cancelled || !host.value) return;
    try {
      scene = mountSheetScene(host.value, SHEETS, isDark.value);
      scene.setScroll(props.progress);
      requestAnimationFrame(() => {
        live.value = true;
      });
    } catch {
      scene = null;
    }
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  if (idle) idle(() => void start(), { timeout: 1200 });
  else setTimeout(() => void start(), 300);
});

watch(
  () => props.progress,
  (p) => scene?.setScroll(p),
);
watch(isDark, (d) => scene?.setDark(d));

onBeforeUnmount(() => {
  cancelled = true;
  scene?.destroy();
  scene = null;
});
</script>

<template>
  <div class="stack" :class="{ live }">
    <ol class="paper" aria-label="What Psyche keeps on paper: three files and a record, all plain text">
      <li
        v-for="(s, i) in SHEETS"
        :key="s.id"
        class="sheet"
        :class="[`sheet-${i}`, `kind-${s.kind}`]"
        :style="{ '--i': i }"
      >
        <p class="head">{{ s.file }}</p>
        <template v-for="(l, j) in s.lines" :key="j">
          <p v-if="l.t === 'h1'" class="h1">{{ l.text }}</p>
          <p v-else-if="l.t === 'h2'" class="h2">{{ l.text }}</p>
          <p v-else-if="l.t === 'li'" class="li">
            {{ l.text }} <span v-if="l.cite" class="cite">{{ l.cite }}</span>
          </p>
          <p v-else-if="l.t === 'p'" class="p">{{ l.text }}</p>
          <p v-else-if="l.t === 'kv'" class="kv"><span>{{ l.k }}</span> {{ l.v }}</p>
          <p v-else-if="l.t === 'meta'" class="meta">{{ l.text }}</p>
          <p v-else-if="l.t === 'actions'" class="actions" aria-hidden="true">
            <span class="deny">{{ l.deny }}</span><span class="allow">{{ l.allow }}</span>
          </p>
        </template>
      </li>
    </ol>
    <div ref="host" class="gl" />
  </div>
</template>

<style scoped>
.stack {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;
}
.gl {
  position: absolute;
  inset: -8% -10% 3%;
  pointer-events: none;
}
.gl :deep(canvas) {
  width: 100%;
  height: 100%;
  display: block;
  opacity: 0;
  transition: opacity 0.6s var(--ease-out);
}
.live .gl :deep(canvas) {
  opacity: 1;
}

/* The HTML stack: the same sheets, laid flat. */
.paper {
  list-style: none;
  margin: 0;
  padding: 0;
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  transition: opacity 0.5s var(--ease-out);
}
/* Once the 3D stack draws, the HTML sheets stay only for screen readers. */
.live .paper {
  position: absolute;
  width: 1px;
  height: 1px;
  inset: auto;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.sheet {
  grid-area: 1 / 1;
  height: min(84%, 520px);
  max-width: 80%;
  aspect-ratio: 1 / 1.32;
  background: oklch(0.993 0.001 80);
  color: #2b2c2e;
  border-radius: 3px;
  padding: 7% 8% 6% 9%;
  box-shadow: var(--shadow-sheet);
  overflow: hidden;
  font-size: clamp(10px, 1vw, 13px);
  line-height: 1.45;
  position: relative;
  transform: translate(calc((var(--i) - 1.5) * 3%), calc((1.5 - var(--i)) * 2%))
    rotate(calc((var(--i) - 1.5) * -2.2deg));
}
.sheet::before {
  content: "";
  position: absolute;
  left: 6%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #e4e3df;
}
.kind-approval {
  box-shadow:
    inset 0 0 0 2px #f3c34a,
    var(--shadow-sheet);
}
.head {
  font-family: var(--font-code);
  font-size: 0.95em;
  color: #55575b;
  border-bottom: 1px solid #e4e3df;
  padding-bottom: 0.6em;
  margin: 0 0 1.4em;
}
.kind-approval .head {
  color: #8a5300;
}
.h1 {
  font-family: var(--font-display);
  font-size: 2.2em;
  line-height: 1.05;
  margin: 0 0 0.5em;
}
.kind-receipt .h1,
.kind-approval .h1 {
  font-family: var(--font-text);
  font-size: 1.5em;
  font-weight: 500;
}
.h2 {
  font-weight: 600;
  margin: 1em 0 0.3em;
}
.li {
  margin: 0 0 0.45em;
  padding-left: 1em;
  text-indent: -1em;
}
.li::before {
  content: "– ";
  color: #6f7074;
}
.cite {
  font-family: var(--font-code);
  font-size: 0.8em;
  color: #2c5aa0;
  background: #e3eaf5;
  border-radius: 4px;
  padding: 0.05em 0.4em;
  white-space: nowrap;
}
.kv {
  margin: 0;
  padding: 0.45em 0;
  border-bottom: 1px solid #e4e3df;
}
.kv span {
  display: inline-block;
  width: 5.5em;
  color: #6f7074;
}
.meta {
  color: #6f7074;
  font-size: 0.85em;
  margin: 0.8em 0 0;
}
.actions {
  position: absolute;
  right: 8%;
  bottom: 6%;
  display: flex;
  gap: 0.6em;
  margin: 0;
}
.actions span {
  padding: 0.5em 1.1em;
  border-radius: 6px;
  border: 1px solid #cfcfcb;
}
.actions .allow {
  background: #2c5aa0;
  border-color: #2c5aa0;
  color: #fff;
}
</style>
