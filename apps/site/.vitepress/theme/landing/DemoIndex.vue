<script setup lang="ts">
import { onMounted, ref } from "vue";
import ScrubClip from "./ScrubClip.vue";

/**
 * A sheet of smaller demos: the rest of what Psyche does, each a short recording of the real app
 * on fictional data. With a mouse a clip plays while it is hovered or focused; on a touch screen
 * it plays when it is in view, one at a time. With reduced motion each shows its still and plays
 * only when asked.
 */
export interface IndexItem {
  clip: string;
  title: string;
  line: string;
  label: string;
  where: string;
  ratio: number;
  phone?: boolean;
  href?: string;
}
defineProps<{ items: IndexItem[] }>();

const hover = ref(false);
const players = ref<(InstanceType<typeof ScrubClip> | null)[]>([]);
onMounted(() => {
  hover.value = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
});
const start = (i: number) => hover.value && players.value[i]?.start();
const stop = (i: number) => hover.value && players.value[i]?.stop();
</script>

<template>
  <ul class="index-sheet">
    <li
      v-for="(it, i) in items"
      :key="it.clip"
      class="card"
      :style="{ '--i': i }"
      @mouseenter="start(i)"
      @mouseleave="stop(i)"
      @focusin="start(i)"
      @focusout="stop(i)"
    >
      <div class="well" :class="{ phone: it.phone }">
        <ScrubClip
          :ref="(el) => (players[i] = el as InstanceType<typeof ScrubClip> | null)"
          :name="it.clip"
          :label="it.label"
          :ratio="it.ratio"
          :scrub="false"
          :progress="1"
          :phone="it.phone"
          :manual="hover"
        />
      </div>
      <h3>{{ it.title }}</h3>
      <p>{{ it.line }}</p>
      <p class="where">{{ it.where }}</p>
    </li>
  </ul>
</template>

<style scoped>
.index-sheet {
  list-style: none;
  margin: clamp(28px, 3.5vw, 48px) 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(28px, 3.4vw, 52px) clamp(20px, 2.6vw, 40px);
}
.card {
  min-width: 0;
}
/* Every recording sits in the same well, so the sheet keeps one rhythm whatever its shape. */
.well {
  aspect-ratio: 16 / 11;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--paper-2);
  box-shadow: inset 0 0 0 1px var(--paper-5);
  overflow: hidden;
}
.well > :deep(.clip) {
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
  border-radius: 0;
  box-shadow: none;
}
.well > :deep(.clip video) {
  object-fit: contain;
  object-position: 50% 0;
}
.well.phone {
  padding-top: 18px;
  align-items: start;
}
.well.phone > :deep(.clip) {
  width: auto;
  height: 160%;
  aspect-ratio: var(--ratio);
  border-radius: 13% / 6%;
  box-shadow: 0 0 0 1.5px oklch(0.25 0.004 80);
}
.well.phone > :deep(.clip video) {
  object-fit: contain;
}
h3 {
  margin-top: 16px;
  font-size: 21px;
  line-height: 1.2;
  letter-spacing: -0.01em;
}
.card p {
  margin-top: 6px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--paper-11);
  max-width: 34em;
}
.card .where {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--paper-9);
}
@media (max-width: 960px) {
  .index-sheet {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .index-sheet {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
