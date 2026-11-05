/**
 * Scroll scenes for the landing page. Every element marked `data-scene` gets a `--p` custom
 * property from 0 to 1 that tracks the scroll, and the CSS of each scene derives its motion from
 * it, so the motion is scrubbed by the scroll rather than played on arrival.
 *
 * - `data-scene="pin"`: a tall track whose child is `position: sticky`. `--p` runs across the
 *   track's extra height while the child is pinned. Pinning only happens on wide, tall screens
 *   (`.landing.pin`); elsewhere a pin scene behaves like a flow scene over its own height.
 * - `data-scene="flow"`: `--p` runs while the element rises from the bottom of the viewport to
 *   `data-end` (a fraction of the viewport height, default 0.4).
 *
 * The CSS default is `--p: 1`, the finished state, so without JavaScript or with reduced motion
 * the page shows every scene complete and nothing waits on a script.
 */
export interface SceneEngine {
  update(): void;
  destroy(): void;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function startScenes(root: HTMLElement, pinned: () => boolean): SceneEngine {
  const scenes = [...root.querySelectorAll<HTMLElement>("[data-scene]")];
  const last = new Map<HTMLElement, number>();
  let raf = 0;

  function measure() {
    raf = 0;
    const vh = window.innerHeight;
    const pin = pinned();
    // Read every rectangle first, then write, so the browser lays out once per frame.
    const rects = scenes.map((el) => el.getBoundingClientRect());
    scenes.forEach((el, i) => {
      const r = rects[i] as DOMRect;
      let p: number;
      if (el.dataset.scene === "pin" && pin) {
        const travel = r.height - vh;
        p = travel > 1 ? clamp01(-r.top / travel) : r.top <= 0 ? 1 : 0;
      } else if (el.dataset.scene === "pin") {
        // Unpinned: run the sequence while the scene crosses the screen.
        p = clamp01((vh * 0.85 - r.top) / Math.max(1, r.height * 0.75));
      } else {
        const end = Number(el.dataset.end ?? 0.4);
        const start = vh * 0.98;
        p = clamp01((start - r.top) / Math.max(1, start - vh * end));
      }
      const prev = last.get(el);
      if (prev === undefined || Math.abs(prev - p) > 0.0008) {
        el.style.setProperty("--p", p.toFixed(4));
        last.set(el, p);
      }
    });
  }

  function update() {
    if (!raf) raf = requestAnimationFrame(measure);
  }

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update, { passive: true });
  measure();

  return {
    update,
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      for (const el of scenes) el.style.removeProperty("--p");
    },
  };
}
