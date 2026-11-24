/**
 * Capa de pelo sobre la cabeza del rig: materia hecha de luz.
 *
 * Un solo `Mesh` indexed dibuja cuatro clases de trazo, todas finas y aditivas. Cada trazo es una
 * CINTA orientada a cámara (quad de 4 vértices por segmento, ancho constante en píxeles), no una
 * línea nativa: las líneas de WebGL miden siempre 1 px y titilan.
 *   1) guías (30..70): definen la caída y la onda de cada región del cuero cabelludo;
 *   2) hijas (1500..3000 según el techo físico del scalp): raíz propia repartida por el scalp,
 *      forma transportada desde las 3 guías más cercanas, más onda, largo y brillo individuales;
 *   3) contorno (4 líneas suavizadas con spline, 18 puntos): nacimiento, laterales y nuca;
 *   4) núcleo de masa por guía, con `uBodyAlpha` muy bajo (0,03).
 *
 * Contrato visual (§1–§6) implementado aquí:
 *   - §3 zona prohibida en tiempo de ejecución: cápsula analítica boca/mandíbula en el marco de la
 *     cabeza; el alpha de cada vértice cae a cero al entrar (uniform `uMouthA/uMouthB/uMouthR`),
 *     sin empuje posicional: protege el lip-sync aunque el pelo se mueva.
 *   - §4 movimiento: las guías se integran con Verlet (amortiguación + gravedad suave + empuje
 *     proporcional a la velocidad angular de cabeza y torso) con restricción de longitud y la
 *     raíz clavada al cuero cabelludo. Las hijas heredan el movimiento por interpolación, así que
 *     el costo no depende de la cantidad de hebras.
 *   - §6 dibujado: mezcla aditiva sin escritura de profundidad, alpha por hebra (slider), alpha a
 *     lo largo de la hebra (sube suave desde la raíz, cae a 0 en el último 20 %), gradiente por
 *     hebra entre un tono oscuro y uno claro del color base con ±35 % de brillo (`aGain`), y
 *     brillo en bandas Kajiya-Kay (término anisotrópico barato con luz fija en espacio de vista).
 *     El prepass opcional de profundidad sigue pendiente; no se necesita para el look actual.
 *
 * Pendiente documentado (contrato §5, migración a GPU): las posiciones de las guías subirían cada
 * frame como una DataTexture (~12 × 60 texels) y cada vértice de las hijas llevaría ids de guías,
 * pesos, índice de punto, desplazamiento y aleatorios; la CPU actualizaría solo unas cientos de
 * posiciones por personaje. No se migra hasta que la densidad lo justifique.
 *
 * Las raíces salen de la malla que `wearHead()` añade al rig. El cono delantero, la mandíbula y el
 * cuello quedan fuera por dos filtros: una restricción de ángulo/altura al elegir raíces y un
 * `frontLimit(y)` que prohíbe cualquier trazo por delante de la cara. Las cápsulas del torso empujan
 * el pelo hacia atrás, no hacia delante, para que el lip-sync quede despejado.
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
  HAIR_TUNING_DEFAULTS,
  type HairDebugView,
  type HairTuning,
} from "./hairTuning.ts";

const MIN_GUIDES = 30;
const MAX_GUIDES = 70;
/** Contrato §2: las hijas empiezan en 1500; el techo físico del scalp (separación 0,6 cm) manda. */
const MIN_DAUGHTERS = 1500;
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
/** Por encima de esta altura ya no hay cara: la coronilla también puede dar raíz. */
const CROWN_Y = 86;
const CONTOUR_NOMINAL_LONG = 46;

/** Cinta: ancho objetivo en píxeles de pantalla (contrato §6: 1–1,5 px). */
const RIBBON_WIDTH_PX = 1.35;
/** Rampa de alpha desde la raíz: sube suave hasta este t antes de la caída de la punta. */
const ROOT_RAMP = 0.18;

/** Verlet (contrato §4): gravedad suave, amortiguación y rigidez hacia la plantilla del estilo. */
const GRAVITY = 260; // cm/s²
const VERLET_DAMP = 0.9;
const SHAPE_LONG = 4; // el pelo largo cuelga: la plantilla frena poco
const SHAPE_SHORT = 10; // el corto abraza el cráneo: la plantilla manda más
const SWAY_FORCE = 45; // cm/s² por unidad de drive (velocidad angular × sway)
const CONSTRAINT_ITERS = 3;

/**
 * Zona prohibida boca/mandíbula (contrato §3), en el marco de reposo de la cabeza (+x delantero).
 * Valores estimados sobre el rig; calibrar a ojo con el botón de diagnóstico si la anatomía exacta
 * del head mount lo pide. El alpha cae a 0 dentro y sube suave en un radio `MOUTH_RADIUS`.
 */
const MOUTH_A: [number, number, number] = [12.5, 76.5, 0]; // labio superior
const MOUTH_B: [number, number, number] = [10.5, 71.0, 0]; // mentón/mandíbula
const MOUTH_RADIUS = 5.5; // cm

/** Marcas de `aKind`: contorno -1..-8, guía -10..-99, núcleo <= -100, hija >= 0. */
const GUIDE_MARK = -10;
const TINT_MARK = -100;

const HAIR_VERT = /* glsl */ `
attribute vec3 aOther;
attribute float aAlpha;
attribute float aTone;
attribute float aGain;
attribute float aKind;
attribute float aSide;
uniform vec2 uViewport;
uniform float uWidthPx;
uniform vec3 uContourColor;
uniform float uStrandAlpha;
uniform float uContourAlpha;
uniform float uBodyAlpha;
uniform vec3 uColorLow;
uniform vec3 uColorHigh;
uniform vec3 uLightDir;
uniform float uSpecGain;
uniform vec3 uMouthA;
uniform vec3 uMouthB;
uniform float uMouthR;
varying float vAlpha;
varying vec3 vColor;

// Distancia de un punto al segmento ab (cápsula boca/mandíbula).
float segDist(vec3 p, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float l2 = max(dot(ab, ab), 1e-4);
  float t = clamp(dot(p - a, ab) / l2, 0.0, 1.0);
  return distance(p, a + ab * t);
}

void main() {
  float contour = step(aKind, -0.5) * (1.0 - step(aKind, -9.5));
  float guide = step(aKind, -9.5) * (1.0 - step(aKind, -99.5));
  float tint = step(aKind, -99.5);
  vec3 grad = mix(uColorLow, uColorHigh, clamp(aTone, 0.0, 1.0));
  vColor = mix(grad * aGain, uContourColor, contour) * (1.0 - 0.55 * tint);
  float base = mix(mix(uStrandAlpha, uContourAlpha, contour), uBodyAlpha, tint);
  base = mix(base, uContourAlpha * 0.85, guide);
  vAlpha = aAlpha * base;

  // Zona prohibida boca/mandíbula: el alpha cae a cero al entrar (contrato §3).
  float ex = smoothstep(0.0, 1.0, segDist(position, uMouthA, uMouthB) / uMouthR);
  vAlpha *= ex;

  // Brillo en bandas Kajiya-Kay solo en hijas: luz fija en espacio de vista (contrato §6).
  float strand = step(-0.5, aKind);
  if (strand > 0.5) {
    vec3 mv0 = (modelViewMatrix * vec4(position, 1.0)).xyz;
    vec3 mv1 = (modelViewMatrix * vec4(aOther, 1.0)).xyz;
    vec3 T = normalize(mv1 - mv0);
    float TdotL = dot(T, uLightDir);
    float band = sqrt(max(0.0, 1.0 - TdotL * TdotL));
    float spec = pow(band, 40.0);
    vColor *= (0.72 + 0.5 * band) + uSpecGain * spec;
  }

  // Cinta orientada a cámara: perpendicular a la dirección del segmento EN PANTALLA, con ancho
  // constante en píxeles (contrato §6). El offset vive en NDC y escala con w.
  vec4 clip0 = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 clip1 = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
  vec2 vp = max(uViewport, vec2(1.0));
  vec2 s0 = clip0.xy / max(clip0.w, 1e-4);
  vec2 s1 = clip1.xy / max(clip1.w, 1e-4);
  vec2 dirPx = (s1 - s0) * vp * 0.5;
  float dl = length(dirPx);
  vec2 perp = vec2(1.0, 0.0);
  if (dl > 1e-5) perp = vec2(-dirPx.y, dirPx.x) / dl;
  vec2 offsetNdc = perp * (uWidthPx * aSide * 0.5 * 2.0 / vp);
  clip0.xy += offsetNdc * clip0.w;
  if (clip0.w < 0.001) vAlpha = 0.0; // detrás de la cámara
  gl_Position = clip0;
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

function smooth01(x: number): number {
  const s = clamp(x, 0, 1);
  return s * s * (3 - 2 * s);
}

/** Caída del alpha en el último 20 %: la punta se desvanece, no acaba en corte seco. */
function tipFade(t: number): number {
  if (t <= 0.8) return 1;
  return Math.pow((1 - t) / 0.2, 1.5);
}

/**
 * Alpha a lo largo de la hebra (contrato §6): sube suave desde la raíz y cae a 0 en el último 20 %.
 */
function strandProfile(t: number): number {
  return smooth01(t / ROOT_RAMP) * tipFade(t);
}

/** Tono oscuro del gradiente por hebra: derivado del color base (contrato §6). */
function gradientLow(hex: string): THREE.Vector3 {
  return hexToLinear(hex).multiplyScalar(0.7);
}

/** Tono claro del gradiente por hebra: derivado del color base, acotado. */
function gradientHigh(hex: string): THREE.Vector3 {
  // `hexToLinear` entrega un Vector3 en luz lineal, igual que los demás uniforms vec3 del repo.
  const c = hexToLinear(hex).multiplyScalar(1.35);
  c.x = Math.min(1.5, c.x);
  c.y = Math.min(1.5, c.y);
  c.z = Math.min(1.5, c.z);
  return c;
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

/**
 * El cono delantero se prohíbe solo por debajo de la coronilla. El ángulo alrededor de
 * `HEAD_CENTER_X` es casi 0 justo en el vértice superior, así que usarlo sin distinción dejaba
 * un claro sin raíces en lo más alto de la cabeza.
 */
function faceSafe(y: number, x: number, z: number): boolean {
  return y >= CROWN_Y || Math.abs(Math.atan2(z, x - HEAD_CENTER_X)) >= 0.75;
}

/** Cuero cabelludo permitido: nuca, laterales y coronilla, nunca cara ni mandíbula. */
function isScalp(rig: any, v: number): boolean {
  const rest = rig.rest as Float32Array;
  const x = rest[3 * v], y = rest[3 * v + 1], z = rest[3 * v + 2];
  if (y < 78 || y > 94) return false;
  if (!faceSafe(y, x, z)) return false;
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
  const rq = rig.quads as Int32Array;
  // La coronilla es una superficie pequeña: el muestreo uniforme por área casi no la toca.
  const crownQuads = quads.filter((f) => {
    const a = 4 * f;
    return (rest[3 * rq[a] + 1] + rest[3 * rq[a + 1] + 1] + rest[3 * rq[a + 2] + 1] + rest[3 * rq[a + 3] + 1]) / 4 >= CROWN_Y;
  });
  const out: DaughterTemplate[] = [];
  if (!quads.length || !candidates.length) return out;
  const cell = ROOT_MIN_GAP;
  const occupied = new Map<string, number[]>();
  const key = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;
  for (let attempt = 0; attempt < ROOT_SAMPLES && out.length < MAX_DAUGHTERS; attempt++) {
    const pool = crownQuads.length && rng() < 0.35 ? crownQuads : quads;
    const f = pool[Math.floor(rng() * pool.length)];
    const s = rng(), t = rng();
    const i0 = rq[4 * f], i1 = rq[4 * f + 1];
    const i2 = rq[4 * f + 2], i3 = rq[4 * f + 3];
    const p: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = rest[3 * i0 + c], b = rest[3 * i1 + c], d = rest[3 * i2 + c], e = rest[3 * i3 + c];
      p[c] = (1 - s) * ((1 - t) * a + t * e) + s * ((1 - t) * b + t * d);
    }
    const [x, y, z] = p;
    if (y < 78 || y > 94 || x > frontLimit(y) + 0.25) continue;
    if (!faceSafe(y, x, z)) continue;
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

/**
 * Escribe UN segmento de una polilínea como quad de cinta: 4 vértices (dos en cada extremo) con
 * `aOther` apuntando al otro extremo para que el shader calcule la dirección en pantalla. Los
 * atributos estáticos (alpha, tono, gain, kind, side) ya están en las plantillas; aquí solo se
 * actualizan posición y `aOther`, que son lo único dinámico por frame.
 */
function writeRibbonSegment(pos: Float32Array, oth: Float32Array, pts: Float32Array, seg: number, v: number): void {
  const a = 3 * seg, b = a + 3;
  const o = v * 3;
  // v0 y v1 en A, mirando hacia B
  pos[o] = pts[a]; pos[o + 1] = pts[a + 1]; pos[o + 2] = pts[a + 2];
  oth[o] = pts[b]; oth[o + 1] = pts[b + 1]; oth[o + 2] = pts[b + 2];
  pos[o + 3] = pts[a]; pos[o + 4] = pts[a + 1]; pos[o + 5] = pts[a + 2];
  oth[o + 3] = pts[b]; oth[o + 4] = pts[b + 1]; oth[o + 5] = pts[b + 2];
  // v2 y v3 en B, mirando hacia A
  pos[o + 6] = pts[b]; pos[o + 7] = pts[b + 1]; pos[o + 8] = pts[b + 2];
  oth[o + 6] = pts[a]; oth[o + 7] = pts[a + 1]; oth[o + 8] = pts[a + 2];
  pos[o + 9] = pts[b]; pos[o + 10] = pts[b + 1]; pos[o + 11] = pts[b + 2];
  oth[o + 9] = pts[a]; oth[o + 10] = pts[a + 1]; oth[o + 11] = pts[a + 2];
}

/** Vértice de la malla de la cabeza más cercano a un punto de reposo (anclas de la cápsula boca). */
function nearestHeadVertex(rig: any, x: number, y: number, z: number): number {
  const rest = rig.rest as Float32Array;
  let best = Math.max(0, rig.n - 1);
  let bestD = Infinity;
  for (let v = rig.bodyVertices ?? 0; v < rig.n; v++) {
    const dx = rest[3 * v] - x, dy = rest[3 * v + 1] - y, dz = rest[3 * v + 2] - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
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
      // El punto 0 tiene que ser la raíz exacta. Si se escribe después del primer `addScaledVector`,
      // la guía nace un segmento por debajo del scalp y la coronilla queda descubierta.
      const offsets = new Float32Array(POINTS * 3);
      const cursor = origin.clone();
      for (let i = 1; i < POINTS; i++) {
        const t = (i - 1) / SEGMENTS;
        // El pelo largo debe recorrer primero la coronilla (como el corto) antes de caer: si el
        // primer segmento ya apunta abajo, las raíces altas dejan el vértice de la cabeza al aire.
        const cap = skull ? 1 : smooth01((0.45 - t) / 0.45);
        const radialGain = skull ? 0.95 : THREE.MathUtils.lerp(0.6, 0.95, cap);
        const down = skull ? 0.35 + 0.65 * t : THREE.MathUtils.lerp(1, 0.35, cap);
        const dir = radial.clone().multiplyScalar(radialGain * (1 - t));
        dir.x -= 0.22 * (1 - t);
        dir.y -= down;
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

  // ── Geometría de cintas: 4 vértices + 6 índices por segmento ──
  // Orden de los quads: contornos, luego pares (guía + núcleo de masa), luego hijas. El drawRange
  // corta por prefijo, así que density y el diagnóstico no reconstruyen nada.
  const contourVerts = contours.length * CONTOUR_SEGMENTS * 4;
  const perGuideVerts = SEGMENTS * 4 * 2;
  const perDaughterVerts = SEGMENTS * 4;
  /** Las hijas empiezan DESPUÉS de los 70 bloques reservados, aunque solo se dibujen 50 guías. */
  const daughterBase = contourVerts + MAX_GUIDES * perGuideVerts;
  const totalVerts = daughterBase + daughterCount * perDaughterVerts;
  const positions = new Float32Array(totalVerts * 3);
  const others = new Float32Array(totalVerts * 3);
  const alphaBase = new Float32Array(totalVerts);
  const alphaTemplate = new Float32Array(totalVerts);
  const toneAttr = new Float32Array(totalVerts);
  const gainAttr = new Float32Array(totalVerts);
  const kindAttr = new Float32Array(totalVerts);
  const sideAttr = new Float32Array(totalVerts);
  let w = 0;
  const pushVertex = (alpha: number, tone: number, gain: number, kind: number, side: number) => {
    alphaBase[w] = alpha; toneAttr[w] = tone; gainAttr[w] = gain; kindAttr[w] = kind; sideAttr[w] = side; w++;
  };
  for (let c = 0; c < contours.length; c++) {
    for (let seg = 0; seg < CONTOUR_SEGMENTS; seg++) {
      const tA = seg / CONTOUR_SEGMENTS, tB = (seg + 1) / CONTOUR_SEGMENTS;
      pushVertex(1 - 0.35 * tA, 0.8, 1, -1 - c, -1);
      pushVertex(1 - 0.35 * tA, 0.8, 1, -1 - c, 1);
      pushVertex(1 - 0.35 * tB, 0.8, 1, -1 - c, -1);
      pushVertex(1 - 0.35 * tB, 0.8, 1, -1 - c, 1);
    }
  }
  for (let g = 0; g < MAX_GUIDES; g++) {
    for (let seg = 0; seg < SEGMENTS; seg++) {
      const tA = seg / SEGMENTS, tB = (seg + 1) / SEGMENTS;
      pushVertex(strandProfile(tA), 0.5, 1, GUIDE_MARK - g, -1);
      pushVertex(strandProfile(tA), 0.5, 1, GUIDE_MARK - g, 1);
      pushVertex(strandProfile(tB), 0.5, 1, GUIDE_MARK - g, -1);
      pushVertex(strandProfile(tB), 0.5, 1, GUIDE_MARK - g, 1);
    }
    for (let seg = 0; seg < SEGMENTS; seg++) {
      pushVertex(1, 0.5, 1, TINT_MARK - g, -1);
      pushVertex(1, 0.5, 1, TINT_MARK - g, 1);
      pushVertex(1, 0.5, 1, TINT_MARK - g, -1);
      pushVertex(1, 0.5, 1, TINT_MARK - g, 1);
    }
  }
  for (let d = 0; d < daughterCount; d++) {
    const s = daughters[d];
    for (let seg = 0; seg < SEGMENTS; seg++) {
      const tA = seg / SEGMENTS, tB = (seg + 1) / SEGMENTS;
      pushVertex(strandProfile(tA) * s.gain, s.tone, s.gain, d, -1);
      pushVertex(strandProfile(tA) * s.gain, s.tone, s.gain, d, 1);
      pushVertex(strandProfile(tB) * s.gain, s.tone, s.gain, d, -1);
      pushVertex(strandProfile(tB) * s.gain, s.tone, s.gain, d, 1);
    }
  }
  alphaTemplate.set(alphaBase);

  const quadCount = totalVerts / 4;
  const indices = new Uint32Array(quadCount * 6);
  for (let q = 0; q < quadCount; q++) {
    const b = q * 4, o = q * 6;
    indices[o] = b; indices[o + 1] = b + 1; indices[o + 2] = b + 2;
    indices[o + 3] = b + 1; indices[o + 4] = b + 3; indices[o + 5] = b + 2;
  }

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const othAttr = new THREE.BufferAttribute(others, 3).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphaBase, 1);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("aOther", othAttr);
  geometry.setAttribute("aAlpha", alphaAttr);
  geometry.setAttribute("aTone", new THREE.BufferAttribute(toneAttr, 1));
  geometry.setAttribute("aGain", new THREE.BufferAttribute(gainAttr, 1));
  geometry.setAttribute("aKind", new THREE.BufferAttribute(kindAttr, 1));
  geometry.setAttribute("aSide", new THREE.BufferAttribute(sideAttr, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, quadCount * 6);

  const material = new THREE.ShaderMaterial({
    vertexShader: HAIR_VERT,
    fragmentShader: HAIR_FRAG,
    uniforms: {
      uViewport: { value: new THREE.Vector2(1280, 720) },
      uWidthPx: { value: RIBBON_WIDTH_PX },
      uColorLow: { value: gradientLow(HAIR_TUNING_DEFAULTS.color) },
      uColorHigh: { value: gradientHigh(HAIR_TUNING_DEFAULTS.color) },
      uContourColor: { value: hexToLinear("#f3e2b8") },
      uStrandAlpha: { value: HAIR_TUNING_DEFAULTS.strandAlpha },
      uContourAlpha: { value: HAIR_TUNING_DEFAULTS.contourAlpha },
      uBodyAlpha: { value: HAIR_TUNING_DEFAULTS.bodyAlpha },
      uLightDir: { value: new THREE.Vector3(0.4, 0.55, 0.73).normalize() },
      uSpecGain: { value: 0.5 },
      uMouthA: { value: new THREE.Vector3(MOUTH_A[0], MOUTH_A[1], MOUTH_A[2]) },
      uMouthB: { value: new THREE.Vector3(MOUTH_B[0], MOUTH_B[1], MOUTH_B[2]) },
      uMouthR: { value: MOUTH_RADIUS },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  mesh.visible = false;
  parent.add(mesh);

  // Ancho en píxeles reales: el buffer de dibujo es client × pixelRatio. Observamos el canvas de la
  // escena (único en el DOM de la app) para mantener el grosor constante al redimensionar.
  const canvasEl = typeof document !== "undefined" ? document.querySelector("canvas") : null;
  const syncViewport = () => {
    if (!canvasEl) return;
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const cw = Math.max(1, Math.round(canvasEl.clientWidth * dpr));
    const ch = Math.max(1, Math.round(canvasEl.clientHeight * dpr));
    (material.uniforms.uViewport.value as THREE.Vector2).set(cw, ch);
    material.uniforms.uWidthPx.value = Math.min(3, RIBBON_WIDTH_PX * dpr);
  };
  const viewportRo = canvasEl ? new ResizeObserver(syncViewport) : null;
  if (canvasEl && viewportRo) viewportRo.observe(canvasEl);
  syncViewport();

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

  // Anclas de la cápsula boca/mandíbula: vértices de la cabeza más cercanos a los puntos de reposo.
  const mouthAnchorA = nearestHeadVertex(rig, MOUTH_A[0], MOUTH_A[1], MOUTH_A[2]);
  const mouthAnchorB = nearestHeadVertex(rig, MOUTH_B[0], MOUTH_B[1], MOUTH_B[2]);

  let tuning: HairTuning = { ...HAIR_TUNING_DEFAULTS };
  let variant: "short" | "long" = spec?.variant === "short" ? "short" : "long";
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
      ? clamp(Math.round(THREE.MathUtils.lerp(MIN_GUIDES, tuning.guideCount, density)), 0, guideCount)
      : 0;
    // Contrato §2: mínimo 1500 hijas con density 0; el techo físico del scalp manda por arriba.
    const floorDaughters = Math.min(MIN_DAUGHTERS, daughterCount);
    activeDaughters = debugView === "all" || debugView === "daughters"
      ? clamp(Math.round(THREE.MathUtils.lerp(floorDaughters, daughterCount, density)), 0, daughterCount)
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
    for (let c = 0; c < contours.length; c++) paint(CONTOUR_SEGMENTS * 4, debugView === "all" || debugView === "contour" ? 1 : 0);
    for (let g = 0; g < MAX_GUIDES; g++) {
      const active = g < activeGuides && (debugView === "all" || debugView === "guides") ? 1 : 0;
      paint(SEGMENTS * 4, active);
      paint(SEGMENTS * 4, g < activeGuides && debugView === "all" ? 1 : 0);
    }
    for (let d = 0; d < daughterCount; d++) {
      paint(SEGMENTS * 4, d < activeDaughters && (debugView === "all" || debugView === "daughters") ? 1 : 0);
    }
    alphaAttr.needsUpdate = true;
    // Las hijas viven en `daughterBase`, así que el rango debe cubrir el hueco de guías inactivas
    // (sus alphas son 0 y se descartan en el fragment shader).
    const guideEnd = contourVerts + activeGuides * perGuideVerts;
    const drawnVerts = activeDaughters > 0
      ? daughterBase + activeDaughters * perDaughterVerts
      : guideEnd;
    geometry.setDrawRange(0, Math.round((drawnVerts / 4) * 6));
  };
  refreshAlpha();

  const applyTuning = (t: HairTuning) => {
    tuning = t;
    material.uniforms.uStrandAlpha.value = t.strandAlpha;
    material.uniforms.uContourAlpha.value = t.contourAlpha;
    material.uniforms.uBodyAlpha.value = t.bodyAlpha;
    (material.uniforms.uColorLow.value as THREE.Vector3).copy(gradientLow(t.color));
    (material.uniforms.uColorHigh.value as THREE.Vector3).copy(gradientHigh(t.color));
  };
  applyTuning(tuning);

  // ── Estado Verlet de las guías (contrato §4), en cm relativos a la raíz, marco local de la cabeza ──
  const gCur = new Float32Array(guideCount * POINTS * 3);
  const gPrev = new Float32Array(guideCount * POINTS * 3);
  let verletLen = -1;
  let verletShort: boolean | null = null;
  const scratch3 = new Float32Array(3);
  const gravLocal = new Float32Array(3);

  /** (Re)inicia el estado Verlet desde la plantilla del estilo, sin velocidad. */
  const initVerlet = (len: number, shortNow: boolean) => {
    verletLen = len;
    verletShort = shortNow;
    for (let g = 0; g < guideCount; g++) {
      const s = guides[g];
      const l = len * s.lengthScale;
      const base = g * POINTS * 3;
      for (let i = 0; i < POINTS; i++) {
        guideOffset(s, i / SEGMENTS, shortNow, scratch3, 0);
        const o = base + 3 * i;
        const x = scratch3[0] * l, y = scratch3[1] * l, z = scratch3[2] * l;
        gCur[o] = x; gCur[o + 1] = y; gCur[o + 2] = z;
        gPrev[o] = x; gPrev[o + 1] = y; gPrev[o + 2] = z;
      }
    }
  };

  /** Cápsula boca/mandíbula al mundo: dos rotaciones por frame; el shader hace el fade de alpha. */
  const updateMouthCapsule = (skinned: Float32Array, qHead: THREE.Quaternion) => {
    const oa = 3 * mouthAnchorA, ob = 3 * mouthAnchorB;
    rotateInto(qHead, MOUTH_A[0] - rest[oa], MOUTH_A[1] - rest[oa + 1], MOUTH_A[2] - rest[oa + 2], scratch3, 0);
    (material.uniforms.uMouthA.value as THREE.Vector3).set(
      skinned[oa] + scratch3[0], skinned[oa + 1] + scratch3[1], skinned[oa + 2] + scratch3[2]
    );
    rotateInto(qHead, MOUTH_B[0] - rest[ob], MOUTH_B[1] - rest[ob + 1], MOUTH_B[2] - rest[ob + 2], scratch3, 0);
    (material.uniforms.uMouthB.value as THREE.Vector3).set(
      skinned[ob] + scratch3[0], skinned[ob + 1] + scratch3[1], skinned[ob + 2] + scratch3[2]
    );
  };

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
    const safeDt = Math.max(1 / 240, Math.min(0.05, dt));
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
    if (short !== verletShort || Math.abs(baseLength - verletLen) > 0.05) initVerlet(baseLength, short);

    // Cápsula boca/mandíbula al mundo (contrato §3): fade de alpha en el shader, sin empuje.
    updateMouthCapsule(skinned, qHead);

    const gd = guideDelta, gc = guideCollision, ds = daughters, pos = positions, oth = others, lp = localPoint;
    const dt2 = safeDt * safeDt;
    const shapeK = short ? SHAPE_SHORT : SHAPE_LONG;
    rotateInto(qInv, 0, -GRAVITY, 0, gravLocal, 0);

    // ── Guías: Verlet en el marco local de la cabeza ──
    // Gravedad suave + rigidez hacia la plantilla del estilo + empuje por velocidad angular; la
    // raíz queda clavada y la longitud se restaura con restricciones (PBD). La colisión se aplica
    // después, en el pase de mundo, y su corrección se guarda para las hijas.
    for (let g = 0; g < computeGuides; g++) {
      const s = guides[g];
      const len = baseLength * s.lengthScale;
      const segLen = len / SEGMENTS;
      const base = g * POINTS * 3;
      for (let i = 1; i < POINTS; i++) {
        const p = base + 3 * i;
        const t = i / SEGMENTS;
        guideOffset(s, t, short, scratch3, 0);
        const tx = scratch3[0] * len, ty = scratch3[1] * len, tz = scratch3[2] * len;
        const cx = gCur[p], cy = gCur[p + 1], cz = gCur[p + 2];
        const vx = (cx - gPrev[p]) * VERLET_DAMP;
        const vy = (cy - gPrev[p + 1]) * VERLET_DAMP;
        const vz = (cz - gPrev[p + 2]) * VERLET_DAMP;
        const swayF = SWAY_FORCE * drive * (0.6 + 0.4 * Math.sin(time * 1.4 + s.phase * 0.7)) * t * t;
        const ax = shapeK * (tx - cx) + gravLocal[0] + s.tangentX * swayF;
        const ay = shapeK * (ty - cy) + gravLocal[1];
        const az = shapeK * (tz - cz) + gravLocal[2] + s.tangentZ * swayF;
        gPrev[p] = cx; gPrev[p + 1] = cy; gPrev[p + 2] = cz;
        gCur[p] = cx + vx + ax * dt2;
        gCur[p + 1] = cy + vy + ay * dt2;
        gCur[p + 2] = cz + vz + az * dt2;
      }
      for (let it = 0; it < CONSTRAINT_ITERS; it++) {
        for (let i = 0; i < SEGMENTS; i++) {
          const p0 = base + 3 * i, p1 = p0 + 3;
          const dx = gCur[p1] - gCur[p0], dy = gCur[p1 + 1] - gCur[p0 + 1], dz = gCur[p1 + 2] - gCur[p0 + 2];
          const dl = Math.hypot(dx, dy, dz) || 1e-5;
          const diff = (dl - segLen) / dl;
          if (i === 0) {
            gCur[p1] -= dx * diff; gCur[p1 + 1] -= dy * diff; gCur[p1 + 2] -= dz * diff;
          } else {
            const h = 0.5 * diff;
            gCur[p0] += dx * h; gCur[p0 + 1] += dy * h; gCur[p0 + 2] += dz * h;
            gCur[p1] -= dx * h; gCur[p1 + 1] -= dy * h; gCur[p1 + 2] -= dz * h;
          }
        }
      }
      // Salida de la guía: Verlet + onda propia + barrido (estilo), listo para colisión y hijas.
      for (let i = 0; i < POINTS; i++) {
        const t = i / SEGMENTS;
        const o = base + 3 * i;
        const wave = s.waveAmp * Math.sin(time * 0.9 + s.phase + 2 * Math.PI * s.waveFreq * t) * t;
        const sway = (0.1 + drive * 0.35) * t * t * Math.sin(time * 1.4 + s.phase * 0.7);
        gd[o] = gCur[o] + s.tangentX * (wave + sway) - 0.1 * t;
        gd[o + 1] = gCur[o + 1];
        gd[o + 2] = gCur[o + 2] + s.tangentZ * (wave + sway) + sweep * t * t;
        gc[o] = 0; gc[o + 1] = 0; gc[o + 2] = 0;
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
      for (let seg = 0; seg < CONTOUR_SEGMENTS; seg++) {
        writeRibbonSegment(pos, oth, contourPoint, seg, v);
        v += 4;
      }
    }

    // ── Guías y su núcleo de masa ──
    // La colisión se resuelve en las guías y su corrección se guarda aparte: las hijas la heredan
    // sin repetir 6 cápsulas por punto (era el coste dominante). Así el estado Verlet sigue siendo
    // la forma base de la guía y no acumula correcciones entre frames.
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
        for (let seg = 0; seg < SEGMENTS; seg++) { writeRibbonSegment(pos, oth, worldPoint, seg, v); v += 4; }
        for (let seg = 0; seg < SEGMENTS; seg++) { writeRibbonSegment(pos, oth, worldPoint, seg, v); v += 4; } // núcleo de masa
      }
    }
    // Las guías calculadas pero no dibujadas siguen alimentando el transporte de las hijas.

    // ── Hijas: transporte desde 3 guías + separación, onda y brillo propios ──
    // Salto al bloque reservado: las guías inactivas no desplazan el inicio de las hijas.
    v = daughterBase;
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
      // Onda por recurrencia: 4 trigonometric por hija en vez de 1 por punto (era el coste dominante).
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
        // El offset girado es relativo al ancla: hay que sumar el vértice skinneado, como en guías.
        lp[p] = skinned[o] + lp[p];
        lp[p + 1] = skinned[o + 1] + lp[p + 1];
        lp[p + 2] = skinned[o + 2] + lp[p + 2];
        // Sin colisión por hija: el desplazamiento de sus guías ya las saca del torso.
      }
      for (let seg = 0; seg < SEGMENTS; seg++) { writeRibbonSegment(pos, oth, lp, seg, v); v += 4; }
    }
    posAttr.needsUpdate = true;
    othAttr.needsUpdate = true;
  };

  const setSpec = (next: HairSpec | undefined) => {
    variant = next?.variant === "short" ? "short" : "long";
  };

  return {
    setVisible(next: boolean) { visible = next; mesh.visible = next; },
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
      viewportRo?.disconnect();
      parent.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}