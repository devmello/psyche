<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

/**
 * A short recording of the real app (Storybook stories on fictional fixture data). Nothing loads
 * until the clip nears the viewport; it plays muted while in view and pauses when it leaves. With
 * reduced motion it shows the still and plays only when asked. The button pauses it at any time.
 */
const props = defineProps<{
  name: string;
  label: string;
  /** Width / height of the recording. */
  ratio: number;
}>();

const video = ref<HTMLVideoElement | null>(null);
const box = ref<HTMLElement | null>(null);
const near = ref(false);
const playing = ref(false);
const userPaused = ref(false);
const reduced = ref(false);
const poster = computed(() => withBase(`/demos/${props.name}.webp`));
const src = (ext: string) => withBase(`/demos/${props.name}.${ext}`);

let io: IntersectionObserver | null = null;
let wantPlay = false;

// Sources are added once the clip nears the viewport; the element then has to be told to load them.
watch(near, async (n) => {
  if (!n) return;
  await nextTick();
  video.value?.load();
  if (wantPlay) play();
});

function play() {
  const v = video.value;
  if (!v) return;
  wantPlay = true;
  if (!near.value) return;
  v.play().then(
    () => {
      playing.value = true;
    },
    () => {
      playing.value = false;
    },
  );
}
function pause() {
  wantPlay = false;
  video.value?.pause();
  playing.value = false;
}
function toggle() {
  if (playing.value) {
    userPaused.value = true;
    pause();
  } else {
    userPaused.value = false;
    near.value = true;
    play();
  }
}

onMounted(() => {
  reduced.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio > 0) near.value = true;
        if (reduced.value || userPaused.value) continue;
        if (e.intersectionRatio >= 0.45) play();
        else if (playing.value) pause();
      }
    },
    { rootMargin: "200px 0px", threshold: [0, 0.45] },
  );
  if (box.value) io.observe(box.value);
});
onBeforeUnmount(() => io?.disconnect());
</script>

<template>
  <figure ref="box" class="clip" :style="{ '--ratio': String(ratio) }">
    <div class="frame">
      <video
        ref="video"
        :poster="near ? poster : undefined"
        muted
        loop
        playsinline
        disablepictureinpicture
        :preload="near ? 'metadata' : 'none'"
        :aria-label="label"
        @pause="playing = false"
        @play="playing = true"
      >
        <template v-if="near">
          <source :src="src('webm')" type="video/webm" />
          <source :src="src('mp4')" type="video/mp4" />
        </template>
      </video>
      <button
        class="control"
        type="button"
        :aria-label="playing ? `Pause: ${label}` : `Play: ${label}`"
        @click="toggle"
      >
        <svg v-if="playing" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="4" y="3" width="2.6" height="10" rx="0.8" />
          <rect x="9.4" y="3" width="2.6" height="10" rx="0.8" />
        </svg>
        <svg v-else viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5Z" />
        </svg>
        <span>{{ playing ? "Pause" : "Play" }}</span>
      </button>
    </div>
    <figcaption><slot /></figcaption>
  </figure>
</template>

<style scoped>
.clip {
  margin: 0;
}
.frame {
  position: relative;
  aspect-ratio: var(--ratio);
  border-radius: 12px;
  overflow: hidden;
  background: oklch(0.985 0.0015 80);
  box-shadow:
    0 0 0 1px var(--paper-6),
    var(--shadow-sheet);
}
video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.control {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px 0 10px;
  border-radius: 999px;
  border: 1px solid oklch(0.85 0.0045 80);
  background: oklch(0.991 0.0013 80 / 0.92);
  color: oklch(0.244 0.003 80);
  font: 500 13px/1 var(--font-text);
  cursor: pointer;
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity 0.2s var(--ease-out),
    transform 0.2s var(--ease-out),
    background 0.15s;
}
.control svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
}
.frame:hover .control,
.control:focus-visible,
.control[aria-label^="Play"] {
  opacity: 1;
  transform: none;
}
.control:hover {
  background: #fff;
}
@media (hover: none) {
  .control {
    opacity: 1;
    transform: none;
  }
}
figcaption {
  margin-top: 14px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--paper-11);
  max-width: 62ch;
}
figcaption :deep(b) {
  color: var(--paper-12);
  font-weight: 550;
}
</style>
