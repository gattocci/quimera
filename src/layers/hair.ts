/**
 * Capa de pelo sobre la cabeza del rig: materia hecha de luz.
 *
 * Un solo `LineSegments` dibuja cuatro clases de trazo, todas finas y aditivas:
 *   1) guías (30..70): definen la caída y la onda de cada región del cuero cabelludo;
 *   2) hijas (600..3000): raíz propia repartida por el scalp, forma transportada desde las 2 o 3
 *      guías más cercanas, más onda, largo y brillo individuales;
 *   3) contorno (4 líneas suavizadas con spline, 18 puntos): nacimiento, laterales y nuca;
 *   4) núcleo de masa por guía, con `uBodyAlpha` muy bajo (0,03), sin cintas duras.
 *
 * Las raíces salen de la malla que `wearHead()` añade al rig. El cono delantero, la mandíbula y el
 * cuello quedan fuera por dos filtros: una restricción de ángulo/altura al elegir raíces y un
 * `frontLimit(y)` que prohíbe cualquier trazo por delante de la cara. Las cápsulas del torso empujan el
 * pelo hacia atrás, no hacia delante, para que el lip-sync quede despejado. Todo se reconstruye cada
 * frame desde vértices skinneados y la rotación del hueso `head`, sin tocar la cabeza.
 *
 * Determinista: mulberry32 con (seed del JSON + hash del id). El panel cambia uniforms, alphas y el
 * `drawRange` de buffers reservados una sola vez; no reconstruye la escena.
 */

import * as THREE from "three";
import {
  LAYER_UTILS_GLSL,
  hexToLinear,
  seedFromId,
} from "./common.ts";
import {
  HAIR_COLOR_HIGH,
  HAIR_COLOR_LOW,
  HAIR_TUNING_DEFAULTS,
  type HairDebugView,
  type HairTuning,
} from "./hairTuning.ts";

const MIN_GUIDES = 30;
const MAX_GUIDES = 70;
const MIN_DAUGHTERS = 600;
const MAX_DAUGHTERS = 3000;
/** Puntos por guía/hija: 8 bastan para 1–2 ondas y mantienen bajo el coste por frame. */
const POINTS = 8;
const SEGMENTS = POINTS - 1;
/** Los contornos usan más muestras para que la spline no se vea angular. */
const CONTOUR_POINTS = 18;
const CONTOUR_SEGMENTS = CONTOUR_POINTS - 1;
const CONTOURS = 4;
const ROOT_MIN_GAP = 0.6; // cm entre raíces de hijas vecinas
const ROOT_SAMPLES = 120000;
/** Centro aproximado de la cabeza en x (medido en el rig); delantero = +x. */
const HEAD_CENTER_X = 5.4;
const CONTOUR_NOMINAL_LONG = 46;

/** Marcas de `aKind`: contorno -1..-8, guía -10..-99, núcleo <= -100, hija >= 0. */
const GUIDE_MARK = -10;
const TINT_MARK = -100;

const HAIR_VERT = /* glsl */ `
attribute float aAlpha;
attribute float aTone;
attribute float aGain;
attribute float aKind;
uniform vec3 uColorLow;
uniform vec3 uColorHigh;
uniform vec3 uDefaultColor;
uniform vec3 uColor;
uniform vec3 uContourColor;
uniform float uStrandAlpha;
uniform float uContourAlpha;
uniform float uBodyAlpha;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float contour = step(aKind, -0.5) * (1.0 - step(aKind, -9.5));
  float guide = step(aKind, -9.5) * (1.0 - step(aKind, -99.5));
  float tint = step(aKind, -99.5);
  vec3 grad = mix(uColorLow, uColorHigh, clamp(aTone, 0.0, 1.0));
  grad *= uColor / max(uDefaultColor, vec3(0.001));
  vColor = mix(grad * aGain, uContourColor, contour) * (1.0 - 0.55 * tint);
  float base = mix(mix(uStrandAlpha, uContourAlpha, contour), uBodyAlpha, tint);
  base = mix(base, uContourAlpha * 0.85, guide);
  vAlpha = aAlpha * base;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HAIR_FRAG = /* glsl */ `
${LAYER_UTILS_GLSL}
varying float vAlpha;
varying vec3 vColor;
void main() {
  if (vAlpha < 0.002) discard;
  // Mezcla aditiva: el alpha es la intensidad de la hebra; color en luz lineal codificada.
  gl_FragColor = vec4(layerEncode(vColor), vAlpha);
}
`;

export interface HairSpec {
  variant?: "short" | "long";
  enabled?: boolean;
  color?: string;
  length?: number;
  density?: number;
  seed?: number;
  sweep?: number;
  strandAlpha?: number;
  contourAlpha?: number;
  bodyAlpha?: number;
  sway?: number;
  spread?: number;
  clump?: number;
  guideCount?: number;
}

export interface HairLayerHandle {
  setVisible(visible: boolean): void;
  setSpec(spec: HairSpec | undefined): void;
  setTuning(tuning: HairTuning): void;
  setDebug(view: HairDebugView): void;
  /** Reconstruye las polilíneas desde `skinned` (vértices del rig ya posados). */
  update(skinned: Float32Array, dt: number, time: number): void;
  stats(): { guides: number; daughters: number; placedDaughters: number; contours: number; vertices: number };
  dispose(): void;
}

interface GuideTemplate {
  vertex: number;
  rootX: number;
  rootY: number;
  rootZ: number;
  /** Caída larga y corta en unidades de "largo total = 1", relativas a la raíz. */
  offsets: Float32Array;
  shortOffsets: Float32Array;
  radialX: number;
  radialZ: number;
  tangentX: number;
  tangentZ: number;
  phase: number;
  waveAmp: number;
  waveFreq: number;
  lengthScale: number;
}

interface DaughterTemplate {
  rootX: number;
  rootY: number;
  rootZ: number;
  anchor: number;
  tangentX: number;
  tangentZ: number;
  /** Magnitud con signo de la separación lateral respecto de la guía, en cm. */
  spread: number;
  waveAmp: number;
  waveFreq: number;
  wavePhase: number;
  lengthScale: number;
  gain: number;
  tone: number;
  guide: Int16Array;
  weight: Float32Array;
}

interface ContourTemplate {
  vertex: number;
  points: Float32Array;
  /** false = puntos en cm sobre el scalp; true = offsets unitarios que escalan con el largo. */
  unit: boolean;
}

interface Capsule {
  a: number;
  b: number;
  radius: number;
  /** Empuja hacia −x (detrás del cuerpo) en vez de hacia la cámara. */
  backBias?: boolean;
}

interface RootPoint { v: number; x: number; y: number; z: number; u: number }

/** Generador determinista pequeño, sin dependencias. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotación de un vector por un quaternion, sobre arrays planos y sin asignaciones. */
function rotateInto(q: THREE.Quaternion, x: number, y: number, z: number, out: Float32Array, o: number): void {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out[o] = x + q.w * tx + q.y * tz - q.z * ty;
  out[o + 1] = y + q.w * ty + q.z * tx - q.x * tz;
  out[o + 2] = z + q.w * tz + q.x * ty - q.y * tx;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Caída del alpha en el último 20 %: la punta se desvanece, no acaba en corte seco. */
function tipFade(t: number): number {
  if (t <= 0.8) return 1;
  return Math.pow((1 - t) / 0.2, 1.5);
}

/**
 * Frente máximo permitido por altura, en coordenadas de reposo de la cabeza. Por encima de los
 * 86 cm el cráneo puede avanzar; por debajo del cuello el pelo queda claramente detrás del torso.
 * Es una pared en el marco de la cabeza: gira con ella y no depende de la cámara.
 */
const FRONT_Y = new Float32Array([60, 70, 78, 82, 86, 90, 100]);
const FRONT_X = new Float32Array([0, 2, 6, 9, 11, 12, 12]);

function frontLimit(y: number): number {
  if (y <= 60) return 0;
  if (y >= 100) return 12;
  for (let i = 1; i < FRONT_Y.length; i++) {
    if (y <= FRONT_Y[i]) {
      return FRONT_X[i - 1] + ((FRONT_X[i] - FRONT_X[i - 1]) * (y - FRONT_Y[i - 1])) / (FRONT_Y[i] - FRONT_Y[i - 1]);
    }
  }
  return 12;
}

/** Cuero cabelludo permitido: nuca, laterales y coronilla, nunca cara ni mandíbula. */
function isScalp(rig: any, v: number): boolean {
  const rest = rig.rest as Float32Array;
  const x = rest[3 * v], y = rest[3 * v + 1], z = rest[3 * v + 2];
  if (y < 78 || y > 94) return false;
  if (Math.abs(Math.atan2(z, x - HEAD_CENTER_X)) < 0.75) return false;
  if (x > frontLimit(y) + 0.4) return false;
  const tone = rig.tone?.[v] ?? 1;
  return tone < 0.85 || (y > 78 && tone < 0.98);
}

function rootU(rig: any, v: number): number {
  const rest = rig.rest as Float32Array;
  const theta = Math.atan2(rest[3 * v + 2], rest[3 * v] - HEAD_CENTER_X);
  return theta < 0 ? theta + 2 * Math.PI : theta;
}

function pickRootCandidates(rig: any): RootPoint[] {
  const rest = rig.rest as Float32Array;
  const out: RootPoint[] = [];
  for (let v = rig.bodyVertices; v < rig.n; v++) {
    if (!isScalp(rig, v)) continue;
    out.push({ v, x: rest[3 * v], y: rest[3 * v + 1], z: rest[3 * v + 2], u: rootU(rig, v) });
  }
  return out;
}

/** Reparte guías entre cubos (ángulo × altura) para que cualquier prefijo esté bien distribuido. */
function spreadRoots(candidates: RootPoint[], rng: () => number): RootPoint[] {
  if (candidates.length <= MAX_GUIDES) return [...candidates];
  let minY = Infinity, maxY = -Infinity;
  for (const c of candidates) {
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  const ANGLE_BUCKETS = 14, HEIGHT_BUCKETS = 5;
  const buckets: RootPoint[][] = Array.from({ length: ANGLE_BUCKETS * HEIGHT_BUCKETS }, () => []);
  for (const c of candidates) {
    const a = Math.min(ANGLE_BUCKETS - 1, Math.floor((c.u / (2 * Math.PI)) * ANGLE_BUCKETS));
    const h = Math.min(HEIGHT_BUCKETS - 1, Math.floor(((c.y - minY) / (maxY - minY + 1e-6)) * HEIGHT_BUCKETS));
    buckets[h * ANGLE_BUCKETS + a].push(c);
  }
  const order = buckets.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const picked: RootPoint[] = [];
  for (let round = 0; picked.length < MAX_GUIDES; round++) {
    let added = false;
    for (const b of order) {
      const list = buckets[b];
      if (!list.length) continue;
      const i = Math.floor(rng() * list.length);
      picked.push(list[i]);
      list[i] = list[list.length - 1];
      list.pop();
      added = true;
      if (picked.length >= MAX_GUIDES) break;
    }
    if (!added) break;
  }
  return picked.length >= MIN_GUIDES ? picked : candidates.slice(0, MAX_GUIDES);
}

/** Un mechón degenerado si un rig raro no ofrece ningún vértice de scalp. */
function fallbackCandidate(rig: any): RootPoint {
  const rest = rig.rest as Float32Array;
  const v = Math.min(rig.n - 1, rig.bodyVertices);
  return { v, x: rest[3 * v], y: rest[3 * v + 1], z: rest[3 * v + 2], u: Math.PI };
}

/** Cuadrículas de la malla de la cabeza enteramente dentro del scalp permitido. */
function scalpQuads(rig: any): number[] {
  const quads = rig.quads as Int32Array | number[];
  const out: number[] = [];
  for (let f = 0; f < quads.length / 4; f++) {
    const i0 = quads[4 * f], i1 = quads[4 * f + 1], i2 = quads[4 * f + 2], i3 = quads[4 * f + 3];
    if (isScalp(rig, i0) && isScalp(rig, i1) && isScalp(rig, i2) && isScalp(rig, i3)) out.push(f);
  }
  return out;
}

/**
 * Raíces de hijas repartidas por la superficie del scalp con separación mínima de 0,6 cm. Si no
 * caben 3000, se entregan menos: el panel baja la cuenta antes que acercar hebras.
 */
function sampleDaughterRoots(rig: any, candidates: RootPoint[], rng: () => number): DaughterTemplate[] {
  const rest = rig.rest as Float32Array;
  const quads = scalpQuads(rig);
  const out: DaughterTemplate[] = [];
  if (!quads.length || !candidates.length) return out;
  const cell = ROOT_MIN_GAP;
  const occupied = new Map<string, number[]>();
  const key = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;
  for (let attempt = 0; attempt < ROOT_SAMPLES && out.length < MAX_DAUGHTERS; attempt++) {
    const f = quads[Math.floor(rng() * quads.length)];
    const s = rng(), t = rng();
    const i0 = (rig.quads as Int32Array)[4 * f], i1 = (rig.quads as Int32Array)[4 * f + 1];
    const i2 = (rig.quads as Int32Array)[4 * f + 2], i3 = (rig.quads as Int32Array)[4 * f + 3];
    const p: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = rest[3 * i0 + c], b = rest[3 * i1 + c], d = rest[3 * i2 + c], e = rest[3 * i3 + c];
      p[c] = (1 - s) * ((1 - t) * a + t * e) + s * ((1 - t) * b + t * d);
    }
    const [x, y, z] = p;
    if (y < 78 || y > 94 || x > frontLimit(y) + 0.25) continue;
    if (Math.abs(Math.atan2(z, x - HEAD_CENTER_X)) < 0.75) continue;
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell), iz = Math.floor(z / cell);
    let tooClose = false;
    for (let dx = -1; dx <= 1 && !tooClose; dx++) {
      for (let dy = -1; dy <= 1 && !tooClose; dy++) {
        for (let dz = -1; dz <= 1 && !tooClose; dz++) {
          for (const j of occupied.get(key(ix + dx, iy + dy, iz + dz)) ?? []) {
            const q = out[j];
            if (Math.hypot(q.rootX - x, q.rootY - y, q.rootZ - z) < ROOT_MIN_GAP) { tooClose = true; break; }
          }
        }
      }
    }
    if (tooClose) continue;
    let anchor = candidates[0];
    let best = Infinity;
    for (const c of candidates) {
      const d = (c.x - x) ** 2 + (c.y - y) ** 2 + (c.z - z) ** 2;
      if (d < best) { best = d; anchor = c; }
    }
    const rx = x - HEAD_CENTER_X;
    const len = Math.hypot(rx, z) || 1;
    const radialX = rx / len, radialZ = z / len;
    // Tangente horizontal alrededor del cráneo: en la vista frontal es la dirección visible.
    const tl = Math.hypot(radialZ, radialX) || 1;
    const sign = rng() < 0.5 ? -1 : 1;
    out.push({
      rootX: x, rootY: y, rootZ: z,
      anchor: anchor.v,
      tangentX: (-radialZ / tl) * sign,
      tangentZ: (radialX / tl) * sign,
      spread: 0.5 + rng() * 0.5,
      waveAmp: 0.5 + rng(), // 0.5..1.5 cm
      waveFreq: 1 + rng(), // 1..2 ondas por hebra
      wavePhase: rng() * Math.PI * 2,
      lengthScale: 0.88 + rng() * 0.24, // ±12 %
      gain: 0.65 + rng() * 0.7, // ±35 %
      tone: rng(),
      guide: new Int16Array(3),
      weight: new Float32Array(3),
    });
    const k = key(ix, iy, iz);
    const list = occupied.get(k) ?? [];
    list.push(out.length - 1);
    occupied.set(k, list);
  }
  return out;
}

/** Asigna a cada hija sus 3 guías más cercanas y pesos por distancia inversa. */
function bindGuides(daughters: DaughterTemplate[], guides: GuideTemplate[]): void {
  if (!guides.length) return;
  for (const d of daughters) {
    let best: number[] = [];
    let bestD = [Infinity, Infinity, Infinity];
    for (let g = 0; g < guides.length; g++) {
      const s = guides[g];
      const dx = s.rootX - d.rootX, dy = (s.rootY - d.rootY) * 0.75, dz = (s.rootZ - d.rootZ) * 0.7;
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist >= bestD[2]) continue;
      let i = 0;
      while (i < 3 && dist >= bestD[i]) i++;
      if (i >= 3) continue;
      for (let j = 2; j > i; j--) { bestD[j] = bestD[j - 1]; best[j] = best[j - 1]; }
      bestD[i] = dist; best[i] = g;
    }
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      const g = best[i] ?? 0;
      const w = 1 / Math.sqrt(bestD[i] + 1);
      d.guide[i] = g;
      d.weight[i] = w;
      sum += w;
    }
    for (let i = 0; i < 3; i++) d.weight[i] /= sum || 1;
  }
}

/** Muestreo lineal de la plantilla unitaria de una guía en el parámetro t. */
function guideOffset(s: GuideTemplate, t: number, short: boolean, out: Float32Array, o: number): void {
  const src = short ? s.shortOffsets : s.offsets;
  const u = t * SEGMENTS;
  const i = Math.min(SEGMENTS - 1, Math.floor(u));
  const f = u - i;
  for (let c = 0; c < 3; c++) {
    out[o + c] = src[3 * i + c] * (1 - f) + src[3 * (i + 1) + c] * f;
  }
}

/** Catmull-Rom uniforme: suaviza el arco de nacimiento y las guías de contorno a 18 puntos. */
function resampleSpline(points: THREE.Vector3[], count: number): Float32Array {
  const n = points.length;
  const out = new Float32Array(count * 3);
  const at = (i: number, c: number) => points[clamp(i, 0, n - 1)].getComponent(c);
  for (let i = 0; i < count; i++) {
    const u = (i / (count - 1)) * (n - 1);
    const p1 = Math.min(n - 1, Math.floor(u));
    const f = u - p1;
    const p0 = p1 - 1, p2 = p1 + 1, p3 = p1 + 2;
    for (let c = 0; c < 3; c++) {
      const a = at(p0, c), b = at(p1, c), d = at(p2, c), e = at(p3, c);
      out[3 * i + c] = 0.5 * ((2 * b) + (-a + d) * f + (2 * a - 5 * b + 4 * d - e) * f * f + (-a + 3 * b - 3 * d + e) * f * f * f);
    }
  }
  return out;
}

/** Escribe una polilínea como segmentos de `LineSegments`. */
function writePolyline(positions: Float32Array, points: Float32Array, count: number, start: number): void {
  let o = start * 3;
  for (let seg = 0; seg < count - 1; seg++) {
    for (let k = 0; k < 2; k++) {
      const p = 3 * (seg + k);
      positions[o++] = points[p];
      positions[o++] = points[p + 1];
      positions[o++] = points[p + 2];
    }
  }
}

export function createHairLayer(
  parent: THREE.Group,
  rig: any,
  id: string,
  spec: HairSpec | undefined
): HairLayerHandle {
  const seed = (spec?.seed ?? 0) + seedFromId(id) * 7 + 17;
  const rng = mulberry32(seed);
  const rest = rig.rest as Float32Array;
  const candidates = pickRootCandidates(rig);
  const selected = spreadRoots(candidates.length ? candidates : [fallbackCandidate(rig)], rng);

  // ── Guías: una plantilla de caída larga y otra que sigue el cráneo para `short` ──
  const guides: GuideTemplate[] = [];
  for (const root of selected) {
    const origin = new THREE.Vector3(root.x, root.y, root.z);
    const radial = new THREE.Vector3(root.x - HEAD_CENTER_X, 0, root.z);
    if (radial.lengthSq() < 1e-4) radial.set(0, 0, root.z >= 0 ? 1 : -1);
    radial.normalize();
    // Nunca empujar hacia delante: el frente del cráneo se deja a la cara.
    radial.x = Math.min(radial.x, 0.05);
    const tangentX = -radial.z, tangentZ = radial.x;
    const build = (skull: boolean) => {
      const offsets = new Float32Array(POINTS * 3);
      const cursor = origin.clone();
      for (let i = 0; i < POINTS; i++) {
        const t = i / SEGMENTS;
        const dir = radial.clone().multiplyScalar((skull ? 0.95 : 0.6) * (1 - t));
        dir.x -= 0.22 * (1 - t);
        dir.y -= skull ? 0.35 + 0.65 * t : 1;
        dir.normalize();
        cursor.addScaledVector(dir, 1 / SEGMENTS);
        offsets[3 * i] = cursor.x - origin.x;
        offsets[3 * i + 1] = cursor.y - origin.y;
        offsets[3 * i + 2] = cursor.z - origin.z;
      }
      return offsets;
    };
    guides.push({
      vertex: root.v,
      rootX: root.x, rootY: root.y, rootZ: root.z,
      offsets: build(false),
      shortOffsets: build(true),
      radialX: radial.x, radialZ: radial.z,
      tangentX, tangentZ,
      phase: rng() * Math.PI * 2,
      waveAmp: 0.5 + rng() * 0.6,
      waveFreq: 1 + rng() * 0.35,
      lengthScale: 0.94 + rng() * 0.12,
    });
  }
  const guideCount = guides.length;

  // ── Hijas con separación mínima y transporte desde sus guías ──
  const daughters = sampleDaughterRoots(rig, candidates, rng);
  bindGuides(daughters, guides);
  const daughterCount = daughters.length;

  // ── Contornos: spline sobre el nacimiento y tres guías de volumen ──
  const contours: ContourTemplate[] = [];
  const addContour = (points: THREE.Vector3[], anchor: number, unit: boolean) => {
    if (points.length < 3 || contours.length >= CONTOURS) return;
    const resampled = resampleSpline(points, CONTOUR_POINTS);
    for (let i = 0; i < CONTOUR_POINTS; i++) {
      resampled[3 * i] -= rest[3 * anchor];
      resampled[3 * i + 1] -= rest[3 * anchor + 1];
      resampled[3 * i + 2] -= rest[3 * anchor + 2];
    }
    contours.push({ vertex: anchor, points: resampled, unit });
  };
  const byAngle = guides.slice().sort((a, b) => rootU(rig, a.vertex) - rootU(rig, b.vertex));
  const arc: THREE.Vector3[] = [];
  for (const s of byAngle) {
    const u = rootU(rig, s.vertex);
    if (u < 0.75 || u > 2 * Math.PI - 0.75) continue;
    const x = Math.min(s.rootX + s.radialX * 1.2, frontLimit(s.rootY) + 0.2);
    arc.push(new THREE.Vector3(x, s.rootY + 0.4, s.rootZ + s.radialZ * 1.2));
  }
  if (arc.length >= 3) addContour(arc, byAngle.find((s) => rootU(rig, s.vertex) >= 0.75)?.vertex ?? guides[0].vertex, false);
  const extremes = [
    guides.reduce((b, s) => (s.rootZ > b.rootZ ? s : b), guides[0]),
    guides.reduce((b, s) => (s.rootZ < b.rootZ ? s : b), guides[0]),
    guides.reduce((b, s) => (Math.abs(rootU(rig, s.vertex) - Math.PI) < Math.abs(rootU(rig, b.vertex) - Math.PI) ? s : b), guides[0]),
  ];
  const scratch = new Float32Array(3);
  for (const s of extremes) {
    if (contours.length >= CONTOURS) break;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < POINTS; i++) {
      const t = i / SEGMENTS;
      guideOffset(s, t, false, scratch, 0);
      const push = 1.3 + 0.8 * t;
      pts.push(new THREE.Vector3(
        s.rootX + scratch[0] * CONTOUR_NOMINAL_LONG + s.radialX * push,
        s.rootY + scratch[1] * CONTOUR_NOMINAL_LONG,
        s.rootZ + scratch[2] * CONTOUR_NOMINAL_LONG + s.radialZ * push
      ));
    }
    addContour(pts, s.vertex, true);
  }
  while (contours.length < CONTOURS && guides.length) addContour(
    [0, 0.5, 1].map((t) => new THREE.Vector3(
      guides[0].rootX + guides[0].radialX * t,
      guides[0].rootY - CONTOUR_NOMINAL_LONG * t,
      guides[0].rootZ + guides[0].radialZ * t)),
    guides[0].vertex, true
  );

  // ── Geometría: contornos, después pares (guía + núcleo), después hijas ──
  const contourVerts = contours.length * CONTOUR_SEGMENTS * 2;
  const perGuideVerts = 2 * SEGMENTS * 2;
  const perDaughterVerts = SEGMENTS * 2;
  const totalVerts = contourVerts + MAX_GUIDES * perGuideVerts + daughterCount * perDaughterVerts;
  const positions = new Float32Array(totalVerts * 3);
  const alphaBase = new Float32Array(totalVerts);
  const alphaTemplate = new Float32Array(totalVerts);
  const toneAttr = new Float32Array(totalVerts);
  const gainAttr = new Float32Array(totalVerts);
  const kindAttr = new Float32Array(totalVerts);
  let w = 0;
  const pushVertex = (alpha: number, tone: number, gain: number, kind: number) => {
    alphaBase[w] = alpha; toneAttr[w] = tone; gainAttr[w] = gain; kindAttr[w] = kind; w++;
  };
  for (let c = 0; c < contours.length; c++) {
    for (let seg = 0; seg < CONTOUR_SEGMENTS; seg++) {
      for (let k = 0; k < 2; k++) {
        const t = (seg + k) / CONTOUR_SEGMENTS;
        pushVertex(1 - 0.35 * t, 0.8, 1, -1 - c);
      }
    }
  }
  for (let g = 0; g < MAX_GUIDES; g++) {
    for (let seg = 0; seg < SEGMENTS; seg++) {
      for (let k = 0; k < 2; k++) pushVertex(tipFade((seg + k) / SEGMENTS), 0.5, 1, GUIDE_MARK - g);
    }
    for (let seg = 0; seg < SEGMENTS; seg++) {
      for (let k = 0; k < 2; k++) pushVertex(1, 0.5, 1, TINT_MARK - g);
    }
  }
  for (let d = 0; d < daughterCount; d++) {
    const s = daughters[d];
    for (let seg = 0; seg < SEGMENTS; seg++) {
      for (let k = 0; k < 2; k++) pushVertex(tipFade((seg + k) / SEGMENTS) * s.gain, s.tone, s.gain, d);
    }
  }
  alphaTemplate.set(alphaBase);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphaBase, 1);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("aAlpha", alphaAttr);
  geometry.setAttribute("aTone", new THREE.BufferAttribute(toneAttr, 1));
  geometry.setAttribute("aGain", new THREE.BufferAttribute(gainAttr, 1));
  geometry.setAttribute("aKind", new THREE.BufferAttribute(kindAttr, 1));
  geometry.setDrawRange(0, totalVerts);

  const material = new THREE.ShaderMaterial({
    vertexShader: HAIR_VERT,
    fragmentShader: HAIR_FRAG,
    uniforms: {
      uColorLow: { value: hexToLinear(HAIR_COLOR_LOW) },
      uColorHigh: { value: hexToLinear(HAIR_COLOR_HIGH) },
      uDefaultColor: { value: hexToLinear(HAIR_TUNING_DEFAULTS.color) },
      uColor: { value: hexToLinear(HAIR_TUNING_DEFAULTS.color) },
      uContourColor: { value: hexToLinear("#f3e2b8") },
      uStrandAlpha: { value: HAIR_TUNING_DEFAULTS.strandAlpha },
      uContourAlpha: { value: HAIR_TUNING_DEFAULTS.contourAlpha },
      uBodyAlpha: { value: HAIR_TUNING_DEFAULTS.bodyAlpha },
      uPx: { value: 1.4 },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 2;
  lines.frustumCulled = false;
  lines.visible = false;
  parent.add(lines);

  // Cápsulas ancladas a huesos posados. Torso y cuello empujan hacia detrás, nunca hacia la cámara.
  const capsules: Capsule[] = [
    { a: rig.bone("hips"), b: rig.bone("upperchest"), radius: 12, backBias: true },
    { a: rig.bone("upperchest"), b: rig.bone("neck"), radius: 8, backBias: true },
    { a: rig.bone("clavicle.R"), b: rig.bone("upperarm.R"), radius: 6 },
    { a: rig.bone("upperarm.R"), b: rig.bone("upperarm2.R"), radius: 5 },
    { a: rig.bone("clavicle.L"), b: rig.bone("upperarm.L"), radius: 6 },
    { a: rig.bone("upperarm.L"), b: rig.bone("upperarm2.L"), radius: 5 },
  ];
  const headBone = rig.bone("head");
  const hipBone = rig.bone("hips");
  const prevHead = rig.S[headBone].clone();
  const prevHip = rig.S[hipBone].clone();

  let tuning: HairTuning = { ...HAIR_TUNING_DEFAULTS };
  let variant: "short" | "long" = "long";
  let visible = false;
  let debugView: HairDebugView = "all";
  let lastDensity = -1;
  let lastGuideCount = -1;
  let lastDebug: HairDebugView | "" = "";
  let activeGuides = 0;
  let activeDaughters = 0;
  /** Guías calculadas: las hijas transportan desde cualquiera, aunque solo se dibujen unas pocas. */
  let computeGuides = 0;

  /** Empuja un punto fuera de las cápsulas con 1 cm de separación. */
  const collideInto = (x: number, y: number, z: number, out: Float32Array, o: number) => {
    let px = x, py = y, pz = z;
    const posed = rig.P;
    for (const cap of capsules) {
      const A = posed[cap.a], B = posed[cap.b];
      const min = cap.radius + 1;
      if (py > Math.max(A.y, B.y) + min || py < Math.min(A.y, B.y) - min) continue;
      const abx = B.x - A.x, aby = B.y - A.y, abz = B.z - A.z;
      const len2 = abx * abx + aby * aby + abz * abz || 1;
      const t = clamp(((px - A.x) * abx + (py - A.y) * aby + (pz - A.z) * abz) / len2, 0, 1);
      let dx = px - (A.x + abx * t), dy = py - (A.y + aby * t), dz = pz - (A.z + abz * t);
      if (cap.backBias && dx > 0) dx = -Math.abs(dx) * 0.35;
      const d = Math.hypot(dx, dy, dz);
      if (d >= min) continue;
      if (d < 1e-4) { pz += min; continue; }
      const push = (min - d) / d;
      px += dx * push; py += dy * push; pz += dz * push;
    }
    out[o] = px; out[o + 1] = py; out[o + 2] = pz;
  };

  /** Recalcula alphas visibles y drawRange al mover density/guideCount o cambiar el diagnóstico. */
  const refreshAlpha = () => {
    const density = clamp(tuning.density, 0, 1);
    // El diagnóstico no solo oculta trazos: evita calcular lo que no se va a dibujar.
    activeGuides = debugView === "all" || debugView === "guides"
      ? Math.min(guideCount, Math.round(THREE.MathUtils.lerp(MIN_GUIDES, tuning.guideCount, density)))
      : 0;
    activeGuides = clamp(activeGuides, 0, guideCount);
    activeDaughters = debugView === "all" || debugView === "daughters"
      ? Math.min(daughterCount, Math.round(THREE.MathUtils.lerp(MIN_DAUGHTERS, MAX_DAUGHTERS, density)))
      : 0;
    computeGuides = debugView === "contour" ? 0 : guideCount;
    lastDensity = density;
    lastGuideCount = tuning.guideCount;
    lastDebug = debugView;
    let v = 0;
    const paint = (count: number, on: number) => {
      for (let i = 0; i < count; i++) alphaBase[v + i] = alphaTemplate[v + i] * on;
      v += count;
    };
    for (let c = 0; c < contours.length; c++) paint(CONTOUR_SEGMENTS * 2, debugView === "all" || debugView === "contour" ? 1 : 0);
    for (let g = 0; g < MAX_GUIDES; g++) {
      const active = g < activeGuides && (debugView === "all" || debugView === "guides") ? 1 : 0;
      paint(SEGMENTS * 2, active);
      paint(SEGMENTS * 2, g < activeGuides && debugView === "all" ? 1 : 0);
    }
    for (let d = 0; d < daughterCount; d++) {
      paint(SEGMENTS * 2, d < activeDaughters && (debugView === "all" || debugView === "daughters") ? 1 : 0);
    }
    alphaAttr.needsUpdate = true;
    geometry.setDrawRange(0, contourVerts + activeGuides * perGuideVerts + activeDaughters * perDaughterVerts);
  };
  refreshAlpha();

  const applyTuning = (t: HairTuning) => {
    tuning = t;
    material.uniforms.uStrandAlpha.value = t.strandAlpha;
    material.uniforms.uContourAlpha.value = t.contourAlpha;
    material.uniforms.uBodyAlpha.value = t.bodyAlpha;
    material.uniforms.uColor.value.copy(hexToLinear(t.color));
  };
  applyTuning(tuning);

  const guideDelta = new Float32Array(MAX_GUIDES * POINTS * 3);
  /** Corrección de colisión acumulada por guía: la heredan las hijas sin repetir cápsulas. */
  const guideCollision = new Float32Array(MAX_GUIDES * POINTS * 3);
  const localPoint = new Float32Array(POINTS * 3);
  const worldPoint = new Float32Array(POINTS * 3);
  const contourPoint = new Float32Array(CONTOUR_POINTS * 3);
  const point3 = new Float32Array(3);
  const qInv = new THREE.Quaternion();

  const update = (skinned: Float32Array, dt: number, time: number) => {
    if (!visible) return;
    if (tuning.density !== lastDensity || tuning.guideCount !== lastGuideCount || debugView !== lastDebug) refreshAlpha();

    // Velocidad angular de cabeza y torso, leída de los huesos ya posados.
    const qHead = rig.S[headBone] as THREE.Quaternion;
    const qHip = rig.S[hipBone] as THREE.Quaternion;
    qInv.copy(qHead).invert();
    const safeDt = Math.max(1 / 240, Math.min(0.1, dt));
    const headSpeed = 2 * Math.acos(Math.min(1, Math.abs(prevHead.dot(qHead)))) / safeDt;
    const hipSpeed = 2 * Math.acos(Math.min(1, Math.abs(prevHip.dot(qHip)))) / safeDt;
    prevHead.copy(qHead);
    prevHip.copy(qHip);
    const drive = THREE.MathUtils.clamp(headSpeed * 0.5 + hipSpeed * 0.9, 0, 3) * tuning.sway;

    const baseLength = variant === "short"
      ? THREE.MathUtils.lerp(8, 22, tuning.length)
      : THREE.MathUtils.lerp(26, 66, tuning.length);
    const sweep = THREE.MathUtils.clamp(tuning.sweep, -1, 1) * 17;
    const short = variant === "short";
    const gd = guideDelta, gc = guideCollision, ds = daughters, pos = positions, lp = localPoint;

    // ── Guías: delta local por punto, con onda y balanceo susceptibles al movimiento ──
    for (let g = 0; g < computeGuides; g++) {
      const s = guides[g];
      const len = baseLength * s.lengthScale;
      const base = g * POINTS * 3;
      for (let i = 0; i < POINTS; i++) {
        const t = i / SEGMENTS;
        guideOffset(s, t, short, guideDelta, base + 3 * i);
        gc[base + 3 * i] = 0;
        gc[base + 3 * i + 1] = 0;
        gc[base + 3 * i + 2] = 0;
        const o = base + 3 * i;
        for (let c = 0; c < 3; c++) gd[o + c] *= len;
        const wave = s.waveAmp * Math.sin(time * 0.9 + s.phase + 2 * Math.PI * s.waveFreq * t) * t;
        const sway = (0.1 + drive * 0.7) * t * t * Math.sin(time * 1.4 + s.phase * 0.7);
        gd[o] += s.tangentX * (wave + sway) - 0.1 * t;
        gd[o + 2] += s.tangentZ * (wave + sway) + sweep * t * t;
      }
    }

    let v = 0;
    // ── Contornos ──
    for (const c of contours) {
      const o = 3 * c.vertex;
      const ax = rest[o], ay = rest[o + 1], az = rest[o + 2];
      const scale = c.unit ? baseLength / CONTOUR_NOMINAL_LONG : 1;
      for (let i = 0; i < CONTOUR_POINTS; i++) {
        const p = 3 * i;
        const lx = ax + c.points[p] * scale;
        const ly = ay + c.points[p + 1] * scale;
        const lz = az + c.points[p + 2] * scale;
        const gx = Math.min(lx, frontLimit(ly));
        rotateInto(qHead, gx - ax, ly - ay, lz - az, point3, 0);
        collideInto(skinned[o] + point3[0], skinned[o + 1] + point3[1], skinned[o + 2] + point3[2], contourPoint, p);
      }
      writePolyline(positions, contourPoint, CONTOUR_POINTS, v);
      v += CONTOUR_SEGMENTS * 2;
    }

    // ── Guías y su núcleo de masa ──
    // La colisión se resuelve en las guías y su corrección se guarda aparte: las hijas la heredan
    // sin repetir 6 cápsulas por punto (era el coste dominante). Así `guideDelta` sigue siendo la
    // forma base de la guía y no acumula correcciones entre frames.
    for (let g = 0; g < computeGuides; g++) {
      const s = guides[g];
      const o = 3 * s.vertex;
      const base = g * POINTS * 3;
      for (let i = 0; i < POINTS; i++) {
        const p = 3 * i;
        const lx = s.rootX + gd[base + p];
        const ly = s.rootY + gd[base + p + 1];
        const lz = s.rootZ + gd[base + p + 2];
        const gx = Math.min(lx, frontLimit(ly));
        rotateInto(qHead, gx - rest[o], ly - rest[o + 1], lz - rest[o + 2], point3, 0);
        const wx = skinned[o] + point3[0], wy = skinned[o + 1] + point3[1], wz = skinned[o + 2] + point3[2];
        collideInto(wx, wy, wz, worldPoint, p);
        rotateInto(qInv, worldPoint[p] - wx, worldPoint[p + 1] - wy, worldPoint[p + 2] - wz, point3, 0);
        gc[base + p] = point3[0];
        gc[base + p + 1] = point3[1];
        gc[base + p + 2] = point3[2];
      }
      if (g < activeGuides) {
        writePolyline(positions, worldPoint, POINTS, v);
        v += SEGMENTS * 2;
        writePolyline(positions, worldPoint, POINTS, v); // núcleo de masa
        v += SEGMENTS * 2;
      }
    }
    // Las guías calculadas pero no dibujadas siguen alimentando el transporte de las hijas.

    // ── Hijas: transporte desde 3 guías + separación, onda y brillo propios ──
    const clumpStrength = 0.3 + 0.3 * clamp(tuning.clump, 0, 1);
    const spread = tuning.spread;
    for (let d = 0; d < activeDaughters; d++) {
      const s = ds[d];
      const o = 3 * s.anchor;
      const ax = rest[o], ay = rest[o + 1], az = rest[o + 2];
      const dx0 = s.rootX - ax, dy0 = s.rootY - ay, dz0 = s.rootZ - az;
      const w0 = s.weight[0] + (1 - s.weight[0]) * clumpStrength;
      const w1 = s.weight[1] * (1 - clumpStrength);
      const w2 = s.weight[2] * (1 - clumpStrength);
      const g0 = s.guide[0] * POINTS * 3, g1 = s.guide[1] * POINTS * 3, g2 = s.guide[2] * POINTS * 3;
      // Onda por recurrencia: 4 trigonometrics por hija en vez de 1 por punto (era el coste dominante).
      const step = (2 * Math.PI * s.waveFreq) / SEGMENTS;
      const sinStep = Math.sin(step), cosStep = Math.cos(step);
      const phase = time * 0.9 + s.wavePhase;
      let sinT = Math.sin(phase), cosT = Math.cos(phase);
      for (let i = 0; i < POINTS; i++) {
        const t = i / SEGMENTS;
        const p = 3 * i;
        const lateral = s.spread * spread * (0.25 + 0.75 * t);
        const wave = s.waveAmp * sinT * t;
        const nextSin = sinT * cosStep + cosT * sinStep;
        cosT = cosT * cosStep - sinT * sinStep;
        sinT = nextSin;
        const side = lateral + wave;
        let lx = dx0;
        let ly = dy0;
        let lz = dz0;
        const ls = s.lengthScale;
        lx += w0 * (gd[g0 + p] * ls + gc[g0 + p]);
        ly += w0 * (gd[g0 + p + 1] * ls + gc[g0 + p + 1]);
        lz += w0 * (gd[g0 + p + 2] * ls + gc[g0 + p + 2]);
        lx += w1 * (gd[g1 + p] * ls + gc[g1 + p]);
        ly += w1 * (gd[g1 + p + 1] * ls + gc[g1 + p + 1]);
        lz += w1 * (gd[g1 + p + 2] * ls + gc[g1 + p + 2]);
        lx += w2 * (gd[g2 + p] * ls + gc[g2 + p]);
        ly += w2 * (gd[g2 + p + 1] * ls + gc[g2 + p + 1]);
        lz += w2 * (gd[g2 + p + 2] * ls + gc[g2 + p + 2]);
        lx += s.tangentX * side;
        lz += s.tangentZ * side;
        const absX = ax + lx, absY = ay + ly, absZ = az + lz;
        const gx = Math.min(absX, frontLimit(absY));
        rotateInto(qHead, gx - ax, ly, lz, lp, p);
        // Sin colisión por hija: el desplazamiento de sus guías ya las saca del torso.
      }
      writePolyline(pos, lp, POINTS, v);
      v += SEGMENTS * 2;
    }
    posAttr.needsUpdate = true;
  };

  const setSpec = (next: HairSpec | undefined) => {
    variant = next?.variant === "short" ? "short" : "long";
  };

  return {
    setVisible(next: boolean) { visible = next; lines.visible = next; },
    setSpec,
    setTuning: applyTuning,
    setDebug(next: HairDebugView) {
      if (next === debugView) return;
      debugView = next;
      refreshAlpha();
    },
    update,
    stats() {
      return {
        guides: activeGuides,
        daughters: activeDaughters,
        placedDaughters: daughterCount,
        contours: contours.length,
        vertices: geometry.drawRange.count,
      };
    },
    dispose() {
      parent.remove(lines);
      geometry.dispose();
      material.dispose();
    },
  };
}
