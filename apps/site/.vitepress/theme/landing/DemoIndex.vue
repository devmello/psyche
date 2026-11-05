<script setup lang="ts">
import { withBase } from "vitepress";
import { onMounted, ref } from "vue";
import ScrubClip from "./ScrubClip.vue";

/**
 * The rest of what Psyche does, as a contents page: numbered entries (continuing the lead
 * stages' source numbers), each a line and a plate tipped in under it. A plate is a short
 * recording of the real app on fictional data, cropped to the part the line is about. With a
 * mouse it plays while hovered; its Play control takes keyboard focus and clicks. On a touch
 * screen it plays when it is in view, one at a time. With reduced motion it waits for Play.
 */
export interface IndexItem {
  n: number;
  clip: string;
  title: string;
  /** One line; `backticks` mark real paths and file names (set in mono). */
  line: string;
  label: string;
  ratio: number;
  /** Width / height of the phone-width take (`<clip>-phone.*`), if there is one. */
  phoneRatio?: number;
  /** Site path ("/using/memory") or a full URL. */
  href: string;
  /** What the plate is cropped to: a point in the recording (percent) and how far to zoom in. */
  focus: { x: number; y: number; zoom: number };
  phone?: boolean;
}
defineProps<{ items: IndexItem[] }>();

const hover = ref(false);
const players = ref<(InstanceType<typeof ScrubClip> | null)[]>([]);
onMounted(() => {
  hover.value = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
});
const start = (i: number) => hover.value && players.value[i]?.start();
const stop = (i: number) => hover.value && players.value[i]?.stop();
const link = (href: string) => (href.startsWith("http") ? href : withBase(href));
function parts(text: string): { code: boolean; text: string }[] {
  return text.split(/`([^`]+)`/).map((t, i) => ({ code: i % 2 === 1, text: t }));
}
</script>

<template>
  <ol class="contents">
    <li
      v-for="(it, i) in items"
      :key="it.clip"
      class="entry"
      :style="{ '--i': i }"
      @mouseenter="start(i)"
      @mouseleave="stop(i)"
    >
      <h3>
        <a :href="link(it.href)" :rel="it.href.startsWith('http') ? 'noopener' : undefined"
          ><span class="src">{{ it.n }}</span>{{ it.title }}</a
        >
      </h3>
      <p class="line">
        <template v-for="(t, j) in parts(it.line)" :key="j"
          ><code v-if="t.code">{{ t.text }}</code><template v-else>{{ t.text }}</template></template
        >
      </p>
      <div
        class="plate"
        :class="{ phone: it.phone }"
        :style="{
          '--fx': `${it.focus.x}%`,
          '--fy': `${it.focus.y}%`,
          '--zoom': String(it.focus.zoom),
        }"
      >
        <ScrubClip
          :ref="(el) => (players[i] = el as InstanceType<typeof ScrubClip> | null)"
          :name="it.clip"
          :label="it.label"
          :ratio="it.ratio"
          :phone-ratio="it.phoneRatio"
          :scrub="false"
          :progress="1"
          :manual="hover"
        />
      </div>
    </li>
  </ol>
</template>

<style scoped>
.contents {
  list-style: none;
  margin: clamp(24px, 3vw, 40px) 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(32px, 3.6vw, 56px) clamp(24px, 3vw, 48px);
}
.entry {
  min-width: 0;
  padding-top: 14px;
  border-top: 1px solid var(--paper-5);
  display: flex;
  flex-direction: column;
}
h3 {
  font-size: 21px;
  line-height: 1.2;
  letter-spacing: -0.01em;
}
h3 a {
  color: var(--paper-12);
  text-decoration: none;
}
h3 a:hover {
  text-decoration: underline;
  text-decoration-color: var(--ink-line);
  text-underline-offset: 4px;
}
h3 a:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
  border-radius: 4px;
}
/* The source number, continuing the lead stages' 1 to 4. */
.src {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  margin-right: 9px;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--ink-soft);
  font: 500 12px/1 var(--font-code);
  color: var(--ink-text);
  vertical-align: 3px;
}
.line {
  margin-top: 8px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--paper-11);
  max-width: 34em;
  flex: 1;
}
.line code {
  font-family: var(--font-code);
  font-size: 0.88em;
  padding: 0.05em 0.3em;
  border-radius: 4px;
  background: var(--paper-3);
  border: 1px solid var(--paper-5);
}
/* A plate tipped in under the line: the clip frame's print ring, cropped to what the line says. */
.plate {
  margin-top: 16px;
  aspect-ratio: 4 / 3;
  border-radius: 8px;
  overflow: hidden;
  background: oklch(0.985 0.0015 80);
  box-shadow:
    0 0 0 1px var(--paper-6),
    0 1px 2px oklch(0.2 0.01 80 / 0.08),
    0 14px 30px -20px oklch(0.2 0.01 80 / 0.4);
}
.plate > :deep(.clip) {
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
  border-radius: 0;
  box-shadow: none;
}
.plate > :deep(.clip video) {
  object-fit: cover;
  object-position: var(--fx) var(--fy);
  transform: scale(var(--zoom));
  transform-origin: var(--fx) var(--fy);
}
@media (max-width: 960px) {
  .contents {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .contents {
    grid-template-columns: minmax(0, 1fr);
  }
  /* Phones load the phone-width takes: show them whole from the top, in a taller plate. */
  .plate {
    aspect-ratio: 4 / 5;
  }
  .plate > :deep(.clip video) {
    object-position: 50% 0;
    transform: none;
  }
}
</style>
