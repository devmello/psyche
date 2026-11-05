/**
 * The hero's real-time stack of paper (three.js). Each sheet is a canvas texture of a real file or
 * record (sheet-data.ts) lying on the notebook's right page under one lamp. The pointer tilts the
 * stack; scrolling the hero away fans the sheets apart so each one reads as its own file. The loop
 * renders only while something is moving, and stops when the stack is off screen.
 */
import {
  AmbientLight,
  CanvasTexture,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from "three";
import type { Line, Sheet } from "./sheet-data";

const SHEET_W = 1;
const SHEET_H = 1.32;
const TEX_W = 1024;
const TEX_H = Math.round(TEX_W * (SHEET_H / SHEET_W));

const SERIF =
  'ui-serif, "New York", "Iowan Old Style", "Source Serif 4 Variable", Charter, Georgia, serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const C = {
  paper: "#fcfcfb",
  rule: "#e4e3df",
  text: "#2b2c2e",
  muted: "#6f7074",
  faint: "#9a9b9e",
  ink: "#2c5aa0",
  inkSoft: "#e3eaf5",
  amber: "#f3c34a",
  amberText: "#8a5300",
};

/** Words wrapped to `width`, drawn from `y`; returns the next baseline. */
function wrap(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  lh: number,
): number {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > width && line) {
      g.fillText(line, x, y);
      line = w;
      y += lh;
    } else line = next;
  }
  if (line) g.fillText(line, x, y);
  return y + lh;
}

function drawSheet(sheet: Sheet): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = TEX_W;
  cv.height = TEX_H;
  const g = cv.getContext("2d");
  if (!g) return cv;
  const pad = 84;
  const inner = TEX_W - pad * 2;

  g.fillStyle = C.paper;
  g.fillRect(0, 0, TEX_W, TEX_H);
  // A faint margin rule, like the notebook's.
  g.fillStyle = C.rule;
  g.fillRect(pad - 28, 0, 2, TEX_H);

  if (sheet.kind === "approval") {
    g.strokeStyle = C.amber;
    g.lineWidth = 6;
    g.strokeRect(14, 14, TEX_W - 28, TEX_H - 28);
  }

  // Running head: the file this is.
  g.textBaseline = "alphabetic";
  // The file name is the sheet's label when the stack fans open, so it is set large.
  g.font = `500 44px ${MONO}`;
  g.fillStyle = sheet.kind === "approval" ? C.amberText : "#55575b";
  g.fillText(sheet.file, pad, 112, inner);
  g.fillStyle = C.rule;
  g.fillRect(pad, 142, inner, 2);

  let y = 232;
  const lines: Line[] = sheet.lines;
  for (const l of lines) {
    switch (l.t) {
      case "h1":
        g.font = `500 ${sheet.kind === "md" ? 96 : 64}px ${sheet.kind === "md" ? SERIF : SANS}`;
        g.fillStyle = C.text;
        y = wrap(g, l.text, pad, y, inner, sheet.kind === "md" ? 104 : 74) + 22;
        break;
      case "h2":
        g.font = `600 44px ${SANS}`;
        g.fillStyle = C.text;
        y += 16;
        g.fillText(l.text, pad, y);
        y += 66;
        break;
      case "li": {
        g.font = `400 40px ${SANS}`;
        g.fillStyle = C.muted;
        g.fillText("–", pad, y);
        g.fillStyle = C.text;
        y = wrap(g, l.text, pad + 42, y, inner - 42, 54);
        if (l.cite) {
          g.font = `400 29px ${MONO}`;
          const w = g.measureText(l.cite).width + 28;
          g.fillStyle = C.inkSoft;
          g.beginPath();
          g.roundRect(pad + 42, y - 36, w, 46, 9);
          g.fill();
          g.fillStyle = C.ink;
          g.fillText(l.cite, pad + 56, y - 4);
          y += 38;
        }
        y += 12;
        break;
      }
      case "p":
        g.font = `400 32px ${SANS}`;
        g.fillStyle = C.text;
        y = wrap(g, l.text, pad, y, inner, 44) + 10;
        break;
      case "kv":
        g.font = `400 38px ${SANS}`;
        g.fillStyle = C.muted;
        g.fillText(l.k, pad, y);
        g.fillStyle = C.text;
        g.fillText(l.v, pad + 230, y);
        g.fillStyle = C.rule;
        g.fillRect(pad, y + 26, inner, 2);
        y += 80;
        break;
      case "meta":
        g.font = `400 32px ${SANS}`;
        g.fillStyle = C.muted;
        y = wrap(g, l.text, pad, y, inner, 44) + 16;
        break;
      case "actions": {
        const bh = 74;
        const by = TEX_H - 150;
        g.font = `500 30px ${SANS}`;
        const aw = 160;
        const dw = 150;
        g.fillStyle = C.ink;
        g.beginPath();
        g.roundRect(TEX_W - pad - aw, by, aw, bh, 12);
        g.fill();
        g.fillStyle = "#fff";
        g.fillText(l.allow, TEX_W - pad - aw + 42, by + 48);
        g.strokeStyle = "#cfcfcb";
        g.lineWidth = 3;
        g.beginPath();
        g.roundRect(TEX_W - pad - aw - dw - 20, by, dw, bh, 12);
        g.stroke();
        g.fillStyle = C.text;
        g.fillText(l.deny, TEX_W - pad - aw - dw + 22, by + 48);
        break;
      }
      case "gap":
        y += 26;
        break;
    }
  }
  return cv;
}

/** A gently curled sheet: one edge lifts a little, so light reads it as paper. */
function sheetGeometry(curl: number): PlaneGeometry {
  const geo = new PlaneGeometry(SHEET_W, SHEET_H, 24, 6);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / SHEET_W + 0.5; // 0..1
    const y = pos.getY(i) / SHEET_H + 0.5;
    pos.setZ(i, curl * (x ** 3 * 0.035 + (1 - y) ** 4 * 0.012));
  }
  geo.computeVertexNormals();
  return geo;
}

interface Placement {
  x: number;
  y: number;
  z: number;
  rz: number;
}

/** Resting layout of the stack, bottom to top. */
const REST: Placement[] = [
  { x: 0.2, y: 0.12, z: 0.0, rz: 0.1 },
  { x: -0.16, y: 0.06, z: 0.07, rz: -0.07 },
  { x: 0.12, y: -0.04, z: 0.14, rz: 0.045 },
  { x: -0.04, y: -0.1, z: 0.21, rz: -0.02 },
];
/** Fanned layout: the stack opens like a hand of cards, so each file name shows. */
const FAN: Placement[] = [
  { x: -0.64, y: 0.33, z: 0.0, rz: 0.07 },
  { x: -0.21, y: 0.11, z: 0.08, rz: 0.025 },
  { x: 0.22, y: -0.11, z: 0.16, rz: -0.02 },
  { x: 0.65, y: -0.33, z: 0.24, rz: -0.05 },
];

export interface SheetScene {
  setScroll(p: number): void;
  setDark(dark: boolean): void;
  destroy(): void;
}

export function mountSheetScene(host: HTMLElement, sheets: Sheet[], dark: boolean): SheetScene {
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.className = "sheet-canvas";
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, -0.45, 3.35);
  camera.lookAt(0, 0, 0);

  const ambient = new AmbientLight(0xffffff, 2.05);
  scene.add(ambient);
  // The lamp: up and to the left, warm, casting soft shadows.
  const lamp = new DirectionalLight(0xfff8ee, 1.1);
  lamp.position.set(-2.2, 2.6, 4.2);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.camera.left = -2.5;
  lamp.shadow.camera.right = 2.5;
  lamp.shadow.camera.top = 2.5;
  lamp.shadow.camera.bottom = -2.5;
  lamp.shadow.radius = 6;
  lamp.shadow.blurSamples = 16;
  lamp.shadow.bias = -0.0004;
  scene.add(lamp);

  const stack = new Group();
  stack.rotation.x = -0.12;
  scene.add(stack);

  // Catches the sheets' shadows on the page behind (the page itself is the DOM).
  const catcher = new Mesh(
    new PlaneGeometry(8, 8),
    new ShadowMaterial({ opacity: dark ? 0.5 : 0.16 }),
  );
  catcher.position.z = -0.02;
  catcher.receiveShadow = true;
  stack.add(catcher);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const meshes: Mesh[] = sheets.map((s, i) => {
    const tex = new CanvasTexture(drawSheet(s));
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = maxAniso;
    const mat = new MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 });
    const mesh = new Mesh(sheetGeometry(i % 2 === 0 ? 1 : -0.6), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.index = i;
    stack.add(mesh);
    return mesh;
  });

  // Animated state.
  let scroll = 0;
  const pointer = new Vector2(0, 0);
  const pointerTarget = new Vector2(0, 0);
  const lift = meshes.map(() => 0);
  let hovered = -1;
  const t0 = performance.now();
  const INTRO = 1400;
  let frame = 0;
  let visible = true;
  let baseZ = 3.35;

  function setDark(d: boolean) {
    (catcher.material as ShadowMaterial).opacity = d ? 0.26 : 0.16;
    ambient.intensity = d ? 1.45 : 2.05;
    lamp.intensity = d ? 1.4 : 1.1;
    kick();
  }
  setDark(dark);

  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the whole stack in view on tall, narrow hosts.
    baseZ = w / h < 0.9 ? 4.3 : 3.35;
    camera.position.z = baseZ + scroll * baseZ * 0.72;
    camera.updateProjectionMatrix();
    kick();
  }

  const ease = (k: number) => 1 - (1 - k) ** 4;

  function tick(now: number) {
    frame = 0;
    const intro = Math.min(1, (now - t0) / INTRO);
    pointer.lerp(pointerTarget, 0.08);
    let moving = intro < 1 || pointer.distanceTo(pointerTarget) > 0.0005;

    const p = scroll;
    meshes.forEach((m, i) => {
      const r = REST[i % REST.length] as Placement;
      const f = FAN[i % FAN.length] as Placement;
      // Each sheet is laid down in turn on load.
      const k = ease(MathUtils.clamp((intro * INTRO - i * 140) / 800, 0, 1));
      const liftTarget = hovered === i ? 1 : 0;
      lift[i] = MathUtils.lerp(lift[i] ?? 0, liftTarget, 0.14);
      if (Math.abs((lift[i] ?? 0) - liftTarget) > 0.001) moving = true;
      const l = lift[i] ?? 0;
      m.position.set(
        MathUtils.lerp(r.x, f.x, p),
        MathUtils.lerp(r.y, f.y, p) + (1 - k) * 0.25 + l * 0.04,
        MathUtils.lerp(r.z, f.z, p) + (1 - k) * 1.2 + l * 0.12,
      );
      m.rotation.z = MathUtils.lerp(r.rz, f.rz, p) + (1 - k) * (i % 2 ? -0.12 : 0.12);
      m.rotation.x = (1 - k) * -0.25;
      m.rotation.y = p * 0.12 * (i - 1.5);
    });
    stack.rotation.y = pointer.x * 0.16;
    stack.rotation.x = -0.12 - pointer.y * 0.08 - p * 0.1;
    // Pull back as the hand opens, so every sheet stays in frame.
    camera.position.z = baseZ + p * baseZ * 0.72;
    renderer.render(scene, camera);
    if (moving && visible) frame = requestAnimationFrame(tick);
  }

  function kick() {
    if (!frame && visible) frame = requestAnimationFrame(tick);
  }

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  function onPointer(e: PointerEvent) {
    const rect = host.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    pointerTarget.set(MathUtils.clamp(nx, -1, 1), MathUtils.clamp(ny, -1, 1));
    if (e.pointerType === "mouse") {
      ndc.set(nx, -ny);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(meshes, false)[0];
      hovered = hit ? (hit.object.userData.index as number) : -1;
    }
    kick();
  }
  function onLeave() {
    pointerTarget.set(0, 0);
    hovered = -1;
    kick();
  }
  const area = host.parentElement ?? host;
  area.addEventListener("pointermove", onPointer, { passive: true });
  area.addEventListener("pointerleave", onLeave);

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  const io = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) kick();
  });
  io.observe(host);
  resize();
  kick();

  return {
    setScroll(p: number) {
      const next = MathUtils.clamp(p, 0, 1);
      if (Math.abs(next - scroll) < 0.0005) return;
      scroll = next;
      kick();
    },
    setDark,
    destroy() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      area.removeEventListener("pointermove", onPointer);
      area.removeEventListener("pointerleave", onLeave);
      for (const m of meshes) {
        m.geometry.dispose();
        const mat = m.material as MeshStandardMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
      catcher.geometry.dispose();
      (catcher.material as ShadowMaterial).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
