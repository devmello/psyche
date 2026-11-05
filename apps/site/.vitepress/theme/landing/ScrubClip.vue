<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

/**
 * A recording of the real app (Storybook stories on fictional fixture data).
 *
 * - `scrub`: the parent stage is pinned, and the scroll is the playhead. `progress` (0 to 1) sets
 *   the frame; scrolling back runs it backwards. The clip never plays on its own.
 * - Otherwise (phones, short screens): it plays muted while in view, one clip at a time across
 *   the page, and holds still while the page is scrolling.
 * - Reduced motion: the still at the clip's key moment, and it plays only when asked.
 *
 * Nothing loads until the clip nears the viewport. `time` reports the current second, so the
 * stage can light the step being shown.
 */
const props = defineProps<{
  name: string;
  label: string;
  /** Width / height of the recording. */
  ratio: number;
  /** Width / height of the phone take (`<name>-phone.*`), shown at 560 px and below; absent = none. */
  phoneRatio?: number;
  scrub: boolean;
  progress: number;
  /** A phone recording: the screen's own rounded corners, no window ring. */
  phone?: boolean;
  /** Plays only when asked (`play()`), e.g. on hover in a grid; never when scrolled into view. */
  manual?: boolean;
}>();
const emit = defineEmits<{ time: [seconds: number]; duration: [seconds: number] }>();

const PHONE = "(max-width: 560px)";
const video = ref<HTMLVideoElement | null>(null);
const box = ref<HTMLElement | null>(null);
const near = ref(false);
const playing = ref(false);
const reduced = ref(false);
const phone = ref(false);
const userPaused = ref(false);
const take = computed(() => (phone.value && props.phoneRatio ? "-phone" : ""));
// Scrubbed, the clip starts from its first frame; playing or still, the poster is its key moment.
const poster = computed(() =>
  withBase(`/demos/${props.name}${take.value}${props.scrub ? "-start" : ""}.webp`),
);
const src = computed(() => withBase(`/demos/${props.name}${take.value}.mp4`));

// --- Scrubbing ---------------------------------------------------------------------------------
// The clip holds its first frame for the first 4% of the scroll and its last for the final 8%.
const FROM = 0.04;
const SPAN = 0.88;
let pendingTime = -1;
function target(p: number, duration: number): number {
  const k = Math.min(1, Math.max(0, (p - FROM) / SPAN));
  return k * Math.max(0, duration - 0.05);
}
/** Seeks to the latest wanted frame; while a seek is in flight, only the newest target is kept. */
function seek() {
  const v = video.value;
  if (!v || pendingTime < 0 || v.readyState < 1) return;
  if (v.seeking) return;
  if (Math.abs(v.currentTime - pendingTime) > 1 / 48) v.currentTime = pendingTime;
  pendingTime = -1;
}
function onSeeked() {
  if (props.scrub) seek();
}
watch(
  () => [props.progress, props.scrub] as const,
  ([p, scrub]) => {
    if (!scrub) return;
    const v = video.value;
    const d = v && Number.isFinite(v.duration) ? v.duration : 0;
    if (!v || d === 0) {
      emit("time", -1);
      return;
    }
    pendingTime = target(p, d);
    emit("time", pendingTime);
    seek();
  },
);
function onMeta() {
  const v = video.value;
  if (!v) return;
  emit("duration", v.duration);
  if (props.scrub) {
    // Always seek once: a browser keeps showing the poster until the video seeks or plays.
    v.currentTime = Math.max(target(props.progress, v.duration), 0.001);
    emit("time", v.currentTime);
  }
}

// --- Playing (unpinned) ------------------------------------------------------------------------
type Live = { current: HTMLVideoElement | null };
const shared = globalThis as { __psycheClip?: Live };
shared.__psycheClip ??= { current: null };
const live: Live = shared.__psycheClip;
let wantPlay = false;
let holding = false;
let resumeTimer = 0;

function play() {
  const v = video.value;
  if (!v || props.scrub) return;
  wantPlay = true;
  if (!near.value) return;
  if (live.current && live.current !== v) live.current.pause();
  live.current = v;
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
  holding = false;
  clearTimeout(resumeTimer);
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
function onScroll() {
  const v = video.value;
  if (props.scrub || !v || live.current !== v || !playing.value) return;
  if (!holding) {
    holding = true;
    v.pause();
  }
  clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => {
    holding = false;
    if (wantPlay && live.current === v) v.play().catch(() => {});
  }, 180);
}
function onPause() {
  if (!holding) playing.value = false;
}
function onTime() {
  const v = video.value;
  if (v && !props.scrub) emit("time", v.currentTime);
}

/** Shows second `t` of the clip (a step was chosen while the clip plays on its own). */
function seekTo(t: number) {
  const v = video.value;
  near.value = true;
  if (!v) return;
  const go = () => {
    v.currentTime = t;
    emit("time", t);
  };
  if (v.readyState >= 1) go();
  else v.addEventListener("loadedmetadata", go, { once: true });
}
/** For a manual clip: start or stop it (a grid card's hover); reduced motion still waits for Play. */
function start() {
  if (reduced.value || userPaused.value) return;
  near.value = true;
  play();
}
function stop() {
  if (playing.value || wantPlay) pause();
}
defineExpose({ seekTo, start, stop });

watch(near, async (n) => {
  if (!n) return;
  await nextTick();
  video.value?.load();
  if (wantPlay) play();
});
watch(
  () => props.scrub,
  (scrub) => {
    if (scrub) pause();
  },
);

let io: IntersectionObserver | null = null;
let media: MediaQueryList | null = null;
function onMedia() {
  phone.value = !!media?.matches;
  if (near.value) nextTick(() => video.value?.load());
}
onMounted(() => {
  reduced.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  media = window.matchMedia(PHONE);
  phone.value = media.matches;
  media.addEventListener("change", onMedia);
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) near.value = true;
        if (props.scrub || props.manual || reduced.value || userPaused.value) continue;
        if (e.intersectionRatio >= 0.45) play();
        else if (playing.value) pause();
      }
    },
    // A scrubbed clip has to be loaded before its stage pins, so look further ahead.
    { rootMargin: "120% 0px", threshold: [0, 0.45] },
  );
  if (box.value) io.observe(box.value);
  window.addEventListener("scroll", onScroll, { passive: true });
});
onBeforeUnmount(() => {
  io?.disconnect();
  media?.removeEventListener("change", onMedia);
  window.removeEventListener("scroll", onScroll);
  clearTimeout(resumeTimer);
});
</script>

<template>
  <div
    ref="box"
    class="clip"
    :class="{ scrub, phone, manual: manual && !reduced }"
    :style="{ '--ratio': String(ratio), '--ratio-phone': String(phoneRatio ?? ratio) }"
  >
    <video
      ref="video"
      :poster="near ? poster : undefined"
      muted
      playsinline
      disablepictureinpicture
      :loop="!scrub"
      :preload="near ? (scrub ? 'auto' : 'metadata') : 'none'"
      :aria-label="label"
      @loadedmetadata="onMeta"
      @seeked="onSeeked"
      @timeupdate="onTime"
      @pause="onPause"
      @play="playing = true"
    >
      <source v-if="near" :src="src" type="video/mp4" />
    </video>
    <button
      v-if="!scrub"
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
</template>

<style scoped>
.clip {
  position: relative;
  aspect-ratio: var(--ratio);
  border-radius: 10px;
  overflow: hidden;
  /* The app's own window background, so the frame never flashes desk color while loading. */
  background: oklch(0.985 0.0015 80);
  box-shadow:
    0 0 0 1px var(--paper-6),
    0 1px 2px oklch(0.2 0.01 80 / 0.08),
    0 18px 40px -24px oklch(0.2 0.01 80 / 0.45);
}
video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
@media (max-width: 560px) {
  .clip {
    aspect-ratio: var(--ratio-phone);
  }
}
/* A phone's screen, as captured: its own corner radius and a dark hairline, no window frame. */
.clip.phone {
  border-radius: 13% / 6%;
  background: #f9f8f6;
  box-shadow:
    0 0 0 1.5px oklch(0.25 0.004 80),
    0 1px 2px oklch(0.2 0.01 80 / 0.1),
    0 22px 44px -26px oklch(0.2 0.01 80 / 0.55);
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
  background: oklch(0.991 0.0013 80 / 0.94);
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
.clip:hover .control,
.control:focus-visible,
.control[aria-label^="Play"] {
  opacity: 1;
  transform: none;
}
.control:hover {
  background: #fff;
}
/* Played by hover: the control stays out of the way until the plate is hovered or focused. */
.clip.manual .control {
  opacity: 0;
}
.clip.manual:hover .control,
.clip.manual .control:focus-visible {
  opacity: 1;
  transform: none;
}
@media (hover: none) {
  .control {
    opacity: 1;
    transform: none;
  }
}
</style>
