/**
 * A small force layout for the memory map: Barnes-Hut repulsion, spring links, a weak pull to the
 * middle, cooling. About 150 lines and no dependency. Typed arrays, a pooled quadtree and a
 * deterministic start (a sunflower spiral, most important first), so the same data always settles
 * to the same picture and a few thousand nodes stay light on memory.
 */

export interface LayoutLink {
  a: number;
  b: number;
  /** 0..1 */
  weight: number;
}

export interface LayoutOptions {
  /** Radius per node, for spacing. */
  radii: ArrayLike<number>;
  links: readonly LayoutLink[];
}

const THETA2 = 0.81; // Barnes-Hut opening angle squared
const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 1 - 0.002 ** (1 / 300);
const VELOCITY_KEEP = 0.58;
const REPULSION = 46;
const GRAVITY = 0.035;
const GOLDEN = 2.399963229728653;

export class ForceLayout {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  #vx: Float64Array;
  #vy: Float64Array;
  #r: Float64Array;
  #links: LayoutLink[];
  #rest: Float64Array;
  #pull: Float64Array;
  alpha = 1;

  // Quadtree pool.
  #cap: number;
  #cx: Float64Array;
  #cy: Float64Array;
  #mass: Float64Array;
  #half: Float64Array;
  #mid: Float64Array; // x,y of the cell centre: two per cell
  #child: Int32Array; // four per cell, -1 none
  #leaf: Int32Array; // body index in a leaf, -1 otherwise
  #count = 0;
  #stack = new Int32Array(256);

  constructor(opts: LayoutOptions) {
    const n = opts.radii.length;
    this.n = n;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.#vx = new Float64Array(n);
    this.#vy = new Float64Array(n);
    this.#r = Float64Array.from(opts.radii as ArrayLike<number>);
    this.#links = opts.links.filter((l) => l.a !== l.b && l.a < n && l.b < n);
    this.#rest = new Float64Array(this.#links.length);
    this.#pull = new Float64Array(this.#links.length);
    const degree = new Float64Array(n);
    for (const l of this.#links) {
      degree[l.a] = (degree[l.a] ?? 0) + 1;
      degree[l.b] = (degree[l.b] ?? 0) + 1;
    }
    this.#links.forEach((l, i) => {
      this.#rest[i] = (this.#r[l.a] ?? 4) + (this.#r[l.b] ?? 4) + 26 - 14 * Math.min(1, l.weight);
      // Hubs would otherwise be pulled apart by their many links.
      this.#pull[i] = 0.3 / Math.sqrt(Math.min(degree[l.a] ?? 1, degree[l.b] ?? 1) || 1);
    });
    // Sunflower start: the array is already ordered by importance, so the heavy nodes sit inside.
    const spread = 9;
    for (let i = 0; i < n; i++) {
      const rr = spread * Math.sqrt(i + 0.5) * 1.4;
      this.x[i] = rr * Math.cos(i * GOLDEN);
      this.y[i] = rr * Math.sin(i * GOLDEN);
    }
    this.#cap = Math.max(16, n * 4 + 8);
    this.#cx = new Float64Array(this.#cap);
    this.#cy = new Float64Array(this.#cap);
    this.#mass = new Float64Array(this.#cap);
    this.#half = new Float64Array(this.#cap);
    this.#mid = new Float64Array(this.#cap * 2);
    this.#child = new Int32Array(this.#cap * 4);
    this.#leaf = new Int32Array(this.#cap);
  }

  get settled(): boolean {
    return this.alpha < ALPHA_MIN || this.n === 0;
  }

  /** Warm the layout again, e.g. after a focus change. */
  reheat(alpha = 0.6): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  tick(): void {
    if (this.settled) return;
    const { n, x, y } = this;
    if (n > 1) this.#repel();
    const vx = this.#vx;
    const vy = this.#vy;
    const a = this.alpha;
    for (let i = 0; i < this.#links.length; i++) {
      const l = this.#links[i] as LayoutLink;
      let dx = (x[l.b] ?? 0) + (vx[l.b] ?? 0) - (x[l.a] ?? 0) - (vx[l.a] ?? 0);
      let dy = (y[l.b] ?? 0) + (vy[l.b] ?? 0) - (y[l.a] ?? 0) - (vy[l.a] ?? 0);
      if (dx === 0 && dy === 0) {
        dx = 0.01;
        dy = 0.01;
      }
      const d = Math.hypot(dx, dy);
      const f = ((d - (this.#rest[i] ?? 30)) / d) * (this.#pull[i] ?? 0.1) * a;
      const fx = dx * f;
      const fy = dy * f;
      vx[l.b] = (vx[l.b] ?? 0) - fx;
      vy[l.b] = (vy[l.b] ?? 0) - fy;
      vx[l.a] = (vx[l.a] ?? 0) + fx;
      vy[l.a] = (vy[l.a] ?? 0) + fy;
    }
    for (let i = 0; i < n; i++) {
      vx[i] = ((vx[i] ?? 0) - (x[i] ?? 0) * GRAVITY * a) * VELOCITY_KEEP;
      vy[i] = ((vy[i] ?? 0) - (y[i] ?? 0) * GRAVITY * a) * VELOCITY_KEEP;
      x[i] = (x[i] ?? 0) + (vx[i] ?? 0);
      y[i] = (y[i] ?? 0) + (vy[i] ?? 0);
    }
    this.alpha -= this.alpha * ALPHA_DECAY;
  }

  /** Run until settled or `budgetMs` has passed. Returns whether it settled. */
  run(budgetMs: number, now: () => number = () => performance.now()): boolean {
    const end = now() + budgetMs;
    while (!this.settled) {
      this.tick();
      if (now() >= end) break;
    }
    return this.settled;
  }

  // --- Barnes-Hut ----------------------------------------------------------------------------

  #grow(): void {
    const cap = this.#cap * 2;
    const f = (old: Float64Array, k = 1) => {
      const next = new Float64Array(cap * k);
      next.set(old);
      return next;
    };
    this.#cx = f(this.#cx);
    this.#cy = f(this.#cy);
    this.#mass = f(this.#mass);
    this.#half = f(this.#half);
    this.#mid = f(this.#mid, 2);
    const child = new Int32Array(cap * 4);
    child.set(this.#child);
    this.#child = child;
    const leaf = new Int32Array(cap);
    leaf.set(this.#leaf);
    this.#leaf = leaf;
    this.#cap = cap;
  }

  #newCell(mx: number, my: number, half: number): number {
    if (this.#count >= this.#cap) this.#grow();
    const c = this.#count++;
    this.#mid[c * 2] = mx;
    this.#mid[c * 2 + 1] = my;
    this.#half[c] = half;
    this.#mass[c] = 0;
    this.#cx[c] = 0;
    this.#cy[c] = 0;
    this.#leaf[c] = -1;
    this.#child.fill(-1, c * 4, c * 4 + 4);
    return c;
  }

  /** A child of `cell` in the quadrant of (px, py), holding `body` alone. */
  #leafChild(cell: number, body: number, px: number, py: number): number {
    const mx = this.#mid[cell * 2] ?? 0;
    const my = this.#mid[cell * 2 + 1] ?? 0;
    const h = (this.#half[cell] ?? 1) / 2;
    const q = (px >= mx ? 1 : 0) + (py >= my ? 2 : 0);
    const child = this.#newCell(mx + (q & 1 ? h : -h), my + (q & 2 ? h : -h), h);
    this.#child[cell * 4 + q] = child;
    this.#mass[child] = 1;
    this.#cx[child] = px;
    this.#cy[child] = py;
    this.#leaf[child] = body;
    return child;
  }

  #insert(root: number, body: number): void {
    const { x, y } = this;
    let cell = root;
    for (let depth = 0; depth < 40; depth++) {
      const before = this.#mass[cell] ?? 0;
      const resident = this.#leaf[cell] ?? -1;
      if (before > 0 && resident !== -1) {
        // Two points at the very same spot would never separate: nudge the newcomer.
        if (x[resident] === x[body] && y[resident] === y[body]) {
          x[body] = (x[body] ?? 0) + ((body % 5) + 1) * 1e-3;
          y[body] = (y[body] ?? 0) + ((body % 3) + 1) * 1e-3;
        }
      }
      const bx = x[body] ?? 0;
      const by = y[body] ?? 0;
      this.#mass[cell] = before + 1;
      this.#cx[cell] = (this.#cx[cell] ?? 0) + bx;
      this.#cy[cell] = (this.#cy[cell] ?? 0) + by;
      if (before === 0) {
        this.#leaf[cell] = body;
        return;
      }
      if (resident !== -1) {
        this.#leaf[cell] = -1;
        this.#leafChild(cell, resident, x[resident] ?? 0, y[resident] ?? 0);
      }
      const mx = this.#mid[cell * 2] ?? 0;
      const my = this.#mid[cell * 2 + 1] ?? 0;
      const q = (bx >= mx ? 1 : 0) + (by >= my ? 2 : 0);
      const next = this.#child[cell * 4 + q] ?? -1;
      if (next === -1) {
        this.#leafChild(cell, body, bx, by);
        return;
      }
      cell = next;
    }
  }

  #repel(): void {
    const { n, x, y } = this;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = x[i] ?? 0;
      const py = y[i] ?? 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const half = Math.max(maxX - minX, maxY - minY, 1) / 2 + 1;
    this.#count = 0;
    const root = this.#newCell((minX + maxX) / 2, (minY + maxY) / 2, half);
    for (let i = 0; i < n; i++) this.#insert(root, i);

    const vx = this.#vx;
    const vy = this.#vy;
    const k = REPULSION * this.alpha;
    for (let i = 0; i < n; i++) {
      const px = x[i] ?? 0;
      const py = y[i] ?? 0;
      const ri = this.#r[i] ?? 4;
      let sp = 0;
      this.#stack[sp++] = root;
      while (sp > 0) {
        const c = this.#stack[--sp] as number;
        const m = this.#mass[c] ?? 0;
        if (m === 0) continue;
        const leaf = this.#leaf[c] ?? -1;
        if (leaf === i) continue;
        const dx = (this.#cx[c] ?? 0) / m - px;
        const dy = (this.#cy[c] ?? 0) / m - py;
        const d2 = dx * dx + dy * dy;
        const size = (this.#half[c] ?? 1) * 2;
        if (leaf !== -1 || (size * size) / (d2 || 1) < THETA2) {
          const rr = leaf !== -1 ? ri + (this.#r[leaf] ?? 4) : ri * 2;
          const soft = Math.max(d2, rr * rr * 0.6) + 1;
          const f = (k * m * (1 + rr * 0.08)) / soft;
          vx[i] = (vx[i] ?? 0) - dx * f;
          vy[i] = (vy[i] ?? 0) - dy * f;
          continue;
        }
        for (let q = 0; q < 4; q++) {
          const ch = this.#child[c * 4 + q] ?? -1;
          if (ch !== -1) {
            if (sp >= this.#stack.length) {
              const bigger = new Int32Array(this.#stack.length * 2);
              bigger.set(this.#stack);
              this.#stack = bigger;
            }
            this.#stack[sp++] = ch;
          }
        }
      }
    }
  }

  /** Bounding box of the nodes, padded by their radii. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const r = this.#r[i] ?? 4;
      x0 = Math.min(x0, (this.x[i] ?? 0) - r);
      x1 = Math.max(x1, (this.x[i] ?? 0) + r);
      y0 = Math.min(y0, (this.y[i] ?? 0) - r);
      y1 = Math.max(y1, (this.y[i] ?? 0) + r);
    }
    return this.n === 0 ? { x0: -1, y0: -1, x1: 1, y1: 1 } : { x0, y0, x1, y1 };
  }
}
