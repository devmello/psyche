<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ScrubClip from "./ScrubClip.vue";

/**
 * One use case: the real app doing it, with a few short steps beside it.
 *
 * On a wide, tall screen the stage pins and the scroll is the clip's playhead (the track below
 * the clip shows where it is, and each step lights as the clip reaches it). Elsewhere the clip
 * plays when it is in view and the steps follow it. A step is a button: it shows that moment.
 * The stage is laid onto the desk as it arrives (`--e`) and set aside as it leaves (`--x`).
 */
export interface Beat {
  /** Second of the clip where this step starts. */
  at: number;
  text: string;
}

const props = defineProps<{
  id: string;
  title: string;
  /** Where in the app this is, named in the caption under the clip. */
  where: string;
  clip: string;
  label: string;
  ratio: number;
  phoneRatio?: number;
  /** Length of the recording, in seconds. */
  duration: number;
  beats: Beat[];
  /** The stage pins and the scroll scrubs the clip. */
  scrub: boolean;
  /** Scroll scenes are running (false with reduced motion). */
  motion: boolean;
  /** Which side the sheet is dealt from. */
  from?: "left" | "right";
  /** `center`: the recording centred, the copy under it (unused on the page today). */
  layout?: "side" | "center";
  /** A lamp hangs over this stage (the night band). */
  lamp?: boolean;
  /** The recording is a phone's screen. */
  phone?: boolean;
}>();

/** A step's text, with `backticks` around real paths and file names (set in mono). */
function parts(text: string): { code: boolean; text: string }[] {
  return text.split(/`([^`]+)`/).map((t, i) => ({ code: i % 2 === 1, text: t }));
}

const track = ref<HTMLElement | null>(null);
const player = ref<InstanceType<typeof ScrubClip> | null>(null);
const progress = ref(1);
const playTime = ref(-1);
/** Length of the take that loaded (the phone take may differ by a frame). */
const loaded = ref(0);

// Same mapping as the clip: the first 4% and the last 8% of the scroll hold still.
const FROM = 0.04;
const SPAN = 0.88;
const time = computed(() => {
  if (props.scrub) {
    const k = Math.min(1, Math.max(0, (progress.value - FROM) / SPAN));
    return k * props.duration;
  }
  return playTime.value;
});
/** The step being shown; -1 before the clip starts, and with reduced motion (no step leads). */
const active = computed(() => {
  if (!props.motion && playTime.value < 0) return -1;
  let n = -1;
  props.beats.forEach((b, i) => {
    if (time.value >= b.at - 0.05) n = i;
  });
  return n;
});
const head = computed(() => {
  const d = props.scrub ? props.duration : loaded.value || props.duration;
  return time.value < 0 ? 0 : Math.min(1, Math.max(0, time.value / d));
});

function onScene(e: Event) {
  progress.value = (e as CustomEvent<{ p: number }>).detail.p;
}
function show(i: number) {
  const b = props.beats[i];
  if (!b) return;
  const el = track.value;
  if (props.scrub && el) {
    const p = FROM + (b.at / props.duration) * SPAN + 0.004;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const travel = el.offsetHeight - window.innerHeight;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: top + p * travel, behavior: reduce ? "auto" : "smooth" });
  } else {
    player.value?.seekTo(b.at + 0.05);
  }
}

onMounted(() => track.value?.addEventListener("scene", onScene));
onBeforeUnmount(() => track.value?.removeEventListener("scene", onScene));
</script>

<template>
  <section
    ref="track"
    class="stage-track"
    :class="[`from-${from ?? 'right'}`, `layout-${layout ?? 'side'}`, { 'has-phone': phone }]"
    data-scene="pin"
    data-enter
    data-exit
    data-emit
    :style="{ '--dur': duration }"
    :aria-labelledby="id"
  >
    <div class="stage-sticky">
      <div v-if="lamp" class="lamp" aria-hidden="true" />
      <div class="stage leaf lit" :style="{ '--head': head.toFixed(4) }">
        <div class="body">
          <div class="copy">
            <h2 :id="id">{{ title }}</h2>
            <div class="deck"><slot /></div>
            <ol class="beats" :aria-label="`What the recording shows`">
              <li
                v-for="(b, i) in beats"
                :key="i"
                :class="{ reached: active >= 0 && i < active, now: i === active }"
              >
                <button type="button" :aria-current="i === active ? 'step' : undefined" @click="show(i)">
                  <span class="tick" aria-hidden="true" /><span
                    ><span class="sr-only">Show in the recording: </span
                    ><template v-for="(t, j) in parts(b.text)" :key="j"
                      ><code v-if="t.code">{{ t.text }}</code
                      ><template v-else>{{ t.text }}</template></template
                    ></span
                  >
                </button>
              </li>
            </ol>
            <div class="foot"><slot name="foot" /></div>
          </div>
          <div class="screen" :style="{ '--ratio': String(ratio) }">
            <ScrubClip
              ref="player"
              :name="clip"
              :label="label"
              :ratio="ratio"
              :phone-ratio="phoneRatio"
              :scrub="scrub"
              :progress="progress"
              :phone="phone"
              @time="(t) => (playTime = t)"
              @duration="(d) => (loaded = d)"
            />
            <div class="timeline" aria-hidden="true">
              <span class="fill" />
              <span
                v-for="(b, i) in beats"
                :key="i"
                class="mark"
                :class="{ on: active >= i }"
                :style="{ left: `${(b.at / duration) * 100}%` }"
              />
            </div>
            <p class="fixture">{{ where }}, recorded from Psyche's own UI on fictional data.</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stage-sticky {
  position: relative;
}
.stage-track {
  --nav: var(--vp-nav-height, 64px);
  position: relative;
  max-width: 1480px;
  margin: clamp(40px, 7vw, 112px) auto 0;
}
.stage {
  position: relative;
  margin: 0;
  background: var(--sheet);
  color: var(--paper-12);
  border-radius: 6px;
  box-shadow: var(--shadow-sheet);
  padding: clamp(20px, 2.6vw, 40px) clamp(22px, 3.6vw, 64px) clamp(22px, 2.6vw, 40px);
}
/* Margin rule, as on every sheet. */
.stage::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: clamp(10px, 1.4vw, 24px);
  width: 1px;
  background: var(--paper-4);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.beats code {
  font-family: var(--font-code);
  font-size: 0.88em;
  padding: 0.05em 0.3em;
  border-radius: 4px;
  background: var(--paper-3);
  border: 1px solid var(--paper-5);
}
.body {
  display: grid;
  grid-template-columns: minmax(280px, 4fr) minmax(0, 8fr);
  gap: clamp(28px, 4vw, 72px);
  align-items: center;
}
.copy {
  min-width: 0;
}
/* Sheets dealt from the left carry their recording on the left, so the stages alternate. */
@media (min-width: 961px) {
  .from-left .body {
    grid-template-columns: minmax(0, 8fr) minmax(280px, 4fr);
  }
  .from-left .screen {
    order: -1;
  }
}
h2 {
  font-size: clamp(30px, 3.2vw, 48px);
  line-height: 1.05;
  letter-spacing: -0.022em;
  max-width: 14ch;
}
.deck {
  margin-top: 16px;
  font-size: 16.5px;
  line-height: 1.55;
  color: var(--paper-11);
  max-width: 34em;
}
.deck :deep(p + p) {
  margin-top: 10px;
}
.beats {
  list-style: none;
  padding: 0;
  margin: clamp(20px, 2.4vw, 32px) 0 0;
  border-top: 1px solid var(--paper-5);
}
.beats li {
  border-bottom: 1px solid var(--paper-5);
}
.beats button {
  display: grid;
  grid-template-columns: 18px 1fr;
  align-items: baseline;
  width: 100%;
  padding: 10px 0;
  border: 0;
  background: none;
  text-align: left;
  font: inherit;
  font-size: 15px;
  line-height: 1.45;
  color: var(--paper-9);
  cursor: pointer;
  transition: color 0.25s var(--ease-out);
}
.beats button:hover {
  color: var(--paper-12);
}
.beats button:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
  border-radius: 4px;
}
.tick {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  border: 1.5px solid currentColor;
  transform: translateY(-1px);
  transition:
    background 0.25s var(--ease-out),
    border-color 0.25s var(--ease-out),
    transform 0.25s var(--ease-out);
}
.beats .reached button {
  color: var(--paper-11);
}
.beats .reached .tick {
  background: var(--paper-11);
  border-color: var(--paper-11);
}
.beats .now button {
  color: var(--paper-12);
}
.beats .now .tick {
  background: var(--ink);
  border-color: var(--ink);
  transform: translateY(-1px) scale(1.25);
}
/* Reduced motion: nothing leads, so every step reads at full strength. */
.landing:not(.motion) .beats button {
  color: var(--paper-12);
}
.foot {
  margin-top: 18px;
}
.foot:empty {
  display: none;
}
.screen {
  min-width: 0;
}
.timeline {
  position: relative;
  height: 2px;
  margin-top: 14px;
  background: var(--paper-5);
  border-radius: 1px;
}
.fill {
  position: absolute;
  inset: 0;
  background: var(--paper-12);
  transform-origin: left;
  transform: scaleX(var(--head, 0));
  border-radius: 1px;
}
.mark {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 8px;
  margin-left: -1px;
  background: var(--paper-7);
  border-radius: 1px;
}
.mark.on {
  background: var(--paper-12);
}
/* With reduced motion nothing plays along the track, so it is not drawn. */
.landing:not(.motion) .timeline {
  display: none;
}
.fixture {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--paper-11);
}

/* ---------- Pinned: the stage fills the screen under the nav while the clip scrubs ---------- */
.pin .stage-track {
  /* About 12 screen-hundredths of scroll per second of recording, plus the time to arrive. */
  height: calc(100svh + var(--dur) * 6svh + 20svh);
}
.pin .stage-sticky {
  position: sticky;
  top: calc(var(--nav) + 14px);
}
.pin .stage {
  box-sizing: border-box;
  height: calc(100svh - var(--nav) - 28px);
  display: flex;
  flex-direction: column;
}
.pin .body {
  flex: 1;
  min-height: 0;
  grid-template-columns: minmax(260px, 1fr) auto;
}
.pin .from-left .body {
  grid-template-columns: auto minmax(260px, 1fr);
}
/* The clip as large as the sheet allows, never taller than it; the copy takes what is left. */
.pin .screen {
  /* At most 62% of the page, never more than the copy column leaves, never taller than the sheet. */
  width: min(
    calc(min(100vw, 1480px) * 0.62),
    calc(min(100vw, 1480px) - 19vw - 310px),
    calc((100svh - var(--nav) - 236px) * var(--ratio, 1.56))
  );
}
.pin .screen :deep(.clip) {
  width: 100%;
}

/* A phone's screen is narrow: the copy and the phone sit together in the middle of the sheet. */
.pin .has-phone .body {
  grid-template-columns: minmax(260px, 500px) auto;
  justify-content: center;
  column-gap: clamp(56px, 9vw, 160px);
}
.pin .has-phone.from-left .body {
  grid-template-columns: auto minmax(260px, 500px);
}
.has-phone .fixture {
  max-width: 24em;
}
/* Unpinned (short windows, phones, reduced motion), a phone's screen keeps a phone's size. */
.has-phone .screen {
  width: min(320px, 100%);
  justify-self: center;
  margin-inline: auto;
}
.pin .has-phone .screen {
  width: min(360px, calc((100svh - var(--nav) - 190px) * var(--ratio, 0.46)));
}

/* ---------- Centred: the recording under the lamp, the copy beneath it ---------- */
@media (min-width: 961px) {
  .layout-center .body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: clamp(18px, 2.4svh, 28px);
  }
  .layout-center .screen {
    order: -1;
  }
  .layout-center .copy {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 4fr) minmax(0, 7fr);
    column-gap: clamp(28px, 4vw, 64px);
    align-items: start;
  }
  .layout-center h2 {
    grid-column: 1;
    max-width: 16ch;
    font-size: clamp(28px, 2.5vw, 38px);
  }
  .layout-center .deck {
    grid-column: 1;
  }
  .layout-center .beats {
    grid-column: 2;
    grid-row: 1 / span 3;
    margin-top: 4px;
  }
  .layout-center .foot {
    grid-column: 1;
  }
  .pin .layout-center .body {
    grid-template-columns: none;
  }
  .pin .layout-center .screen {
    width: min(100%, calc((92svh - var(--nav) - 350px) * var(--ratio, 1.56)));
  }
  .pin .layout-center .deck {
    font-size: 15px;
  }
}
/* The lamp hangs with the pinned sheet: a warm pool over its upper left. */
.lamp {
  position: absolute;
  inset: -14svh -8vw -6svh;
  background: radial-gradient(
    ellipse 46% 58% at 28% 6%,
    oklch(0.97 0.03 85 / 0.16),
    transparent 70%
  );
  pointer-events: none;
}
.lamp ~ .stage {
  isolation: isolate;
}

/* Shorter screens: the same copy, set tighter, so the column fits beside the clip. */
@media (min-width: 961px) and (max-height: 900px) {
  .pin h2 {
    font-size: clamp(28px, 4.6svh, 40px);
  }
  .pin .deck {
    margin-top: 12px;
    font-size: 15.5px;
    line-height: 1.5;
  }
  .pin .beats {
    margin-top: 16px;
  }
  .pin .beats button {
    padding: 7px 0;
    font-size: 14.5px;
  }
  .pin .foot {
    margin-top: 12px;
  }
}

/* Laid down as it arrives: rises and straightens from the side it is dealt from. */
.motion .stage {
  --in: calc(1 - var(--e, 1));
  --k: calc(1 - var(--in) * var(--in) * var(--in));
  transform: translate(calc(var(--side) * (1 - var(--k)) * 6%), calc((1 - var(--k)) * 14svh))
    rotate(calc(var(--side) * (1 - var(--k)) * 2.2deg))
    scale(calc(1 - var(--x, 0) * 0.05));
  transform-origin: 50% 0;
}
.from-left {
  --side: -1;
}
.from-right {
  --side: 1;
}
/* The copy settles a beat after the sheet. */
.motion .copy {
  --c: clamp(0, calc((var(--e, 1) - 0.45) / 0.45), 1);
  opacity: calc(0.15 + var(--c) * 0.85);
  transform: translateY(calc((1 - var(--c)) * 18px));
}

/* One column: heading, a line, the recording, then its steps. */
@media (max-width: 960px) {
  .body {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }
  .copy {
    display: contents;
  }
  h2 {
    order: 1;
  }
  .deck {
    order: 2;
  }
  .screen {
    order: 3;
    margin-top: 22px;
  }
  .beats {
    order: 4;
  }
  .foot {
    order: 5;
  }
}
@media (max-width: 560px) {
  .stage {
    border-radius: 4px;
    padding: 16px 14px 20px;
  }
  .stage::before {
    display: none;
  }
}
</style>
