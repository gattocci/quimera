/**
 * Capa de pelo sobre la cabeza del rig: materia hecha de luz.
 *
 * Tres componentes dibujados con UN solo `LineSegments`:
 *   1) mechones: 40..90 cintas de 8..40 hebras que comparten raíz, dirección, largo y fase;
 *   2) contorno: 4 líneas más claras (arco de nacimiento, dos laterales y nuca);
 *   3) tinte: una cinta central por mechón con `uBodyAlpha` bajo para dar masa sin relleno plano.
 *
 * Las raíces se eligen sobre la malla que `wearHead()` añade al rig: el tono atenuado del cuero
 * cabelludo (rig.tone) y la posición de reposo (x delantero, y vertical, z lateral) dejan fuera la
 * frente, los ojos, la nariz, la boca y la mandíbula. Cada frame se reconstruyen las polilíneas desde
 * los vértices ya skinneados de esas raíces y desde la rotación del hueso `head`, sin tocar la cabeza.
 * El choque con torso, cuello y hombros son cápsulas leales a los huesos posados del rig.
 *
 * Determinista: mulberry32 con (seed del JSON + hash del id) para elegir raíces, jitter y fases.
 * Los ajustes del panel no reconstruyen la escena: cambian uniforms, el drawRange y los buffers de
 * posición de esta geometría, que se reserva una sola vez con el máximo número de hebras.
 */

import * as THREE from "three";
import {
  LAYER_UTILS_GLSL,
  hexToLinear,
  seedFromId,
} from "./common.ts";
import {
  HAIR_TUNING_DEFAULTS,
  type HairTuning,
} from "./hairTuning.ts";

const MIN_STRANDS = 40;
const MAX_STRANDS = 90;
const MIN_THREADS = 8;
const MAX_THREADS = 40;
/** Puntos por polilínea en reposo (6..10 según el encargo). */
const POINTS = 8;
const SEGMENTS = POINTS - 1;
const CONTOURS = 4;
/** El tinte por mechón se marca con aStrand <= -10; el contorno con -1..-4. */
const TINT_MARK = -10;

const HAIR_VERT = /* glsl */ `
attribute float aAlpha;
attribute float aPhase;
attribute float aStrand;
uniform vec3 uColor;
uniform vec3 uContourColor;
uniform float uStrandAlpha;
uniform float uContourAlpha;
uniform float uBodyAlpha;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float contour = step(aStrand, -0.5) * (1.0 - step(aStrand, -9.5));
  float tint = step(aStrand, -9.5);
  float band = 0.94 + 0.06 * fract(abs(aPhase) * 0.1591549 + aStrand * 0.031);
  vColor = mix(uColor, uContourColor, contour) * band;
  vAlpha = aAlpha * mix(mix(uStrandAlpha, uContourAlpha, contour), uBodyAlpha, tint);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HAIR_FRAG = /* glsl */ `
${LAYER_UTILS_GLSL}
varying float vAlpha;
varying vec3 vColor;
void main() {
  if (vAlpha < 0.004) discard;
  // LineSegments: un píxel de ancho en todas las plataformas; el color va en luz lineal, como el cuerpo.
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
}

export interface HairLayerHandle {
  setVisible(visible: boolean): void;
  setSpec(spec: HairSpec | undefined): void;
  setTuning(tuning: HairTuning): void;
  /** Reconstruye las polilíneas desde `skinned` (vértices del rig ya posados). */
  update(skinned: Float32Array, dt: number, time: number): void;
  dispose(): void;
}

interface StrandTemplate {
  /** Vértice del rig usado como raíz. */
  root: number;
  /** Desplazamientos en reposo relativos a la raíz, en unidades de "largo total = 1". */
  offsets: Float32Array;
  /** Dirección radial de la raíz (x delantero, z lateral), ya normalizada. */
  radial: THREE.Vector3;
  phase: number;
  gain: number;
  lengthScale: number;
  /** Jitter fijo por hebra (0.4..1.0 cm), antes de rotar con la cabeza. */
  jitter: Float32Array;
  /** Ganancia de alpha por hebra, para que la cinta no parezca una sola línea. */
  threadGain: Float32Array;
}

interface ContourTemplate {
  root: number;
  /** Puntos en cm, relativos a la raíz (no se escalan por el largo). */
  points: Float32Array;
}

interface Capsule {
  a: number;
  b: number;
  radius: number;
}

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

/**
 * Raíces del cuero cabelludo: tono atenuado de la malla de la cabeza, por encima del cuello y con
 * ángulo lateral/back. `x` es delantero, así que |ángulo| pequeño queda excluido (frente, ojos,
 * nariz, boca y mandíbula). Si un rig viniera sin el tono del scalp, el fallback usa sólo geometría.
 */
function pickRootCandidates(rig: any): { v: number; x: number; y: number; z: number; u: number }[] {
  const rest = rig.rest as Float32Array;
  const candidates: { v: number; x: number; y: number; z: number; u: number }[] = [];
  const push = (v: number, x: number, y: number, z: number, u: number) => candidates.push({ v, x, y, z, u });
  for (let v = rig.bodyVertices; v < rig.n; v++) {
    const x = rest[3 * v], y = rest[3 * v + 1], z = rest[3 * v + 2];
    if (y < 78 || y > 94) continue;
    const theta = Math.atan2(z, x - 3.0);
    if (Math.abs(theta) < 0.75) continue;
    const u = theta < 0 ? theta + 2 * Math.PI : theta;
    if (rig.tone[v] < 0.85 || (y > 78 && rig.tone[v] < 0.98)) push(v, x, y, z, u);
  }
  return candidates;
}

/** Reparte índices de forma uniforme entre cubos (ángulo × altura) para que cualquier prefijo esté bien distribuido. */
function spreadRoots(candidates: ReturnType<typeof pickRootCandidates>, rng: () => number): typeof candidates {
  if (candidates.length <= MAX_STRANDS) return [...candidates];
  let minY = Infinity, maxY = -Infinity;
  for (const c of candidates) {
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  const ANGLE_BUCKETS = 14, HEIGHT_BUCKETS = 5;
  const buckets: (typeof candidates)[] = Array.from({ length: ANGLE_BUCKETS * HEIGHT_BUCKETS }, () => []);
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
  const picked: typeof candidates = [];
  // Una vuelta por cubo y, si faltan, se completan con los que queden en los cubos más poblados.
  for (let round = 0; picked.length < MAX_STRANDS; round++) {
    let added = false;
    for (const b of order) {
      const list = buckets[b];
      if (!list.length) continue;
      const i = Math.floor(rng() * list.length);
      picked.push(list[i]);
      list[i] = list[list.length - 1];
      list.pop();
      added = true;
      if (picked.length >= MAX_STRANDS) break;
    }
    if (!added) break;
  }
  return picked.length >= MIN_STRANDS ? picked : candidates.slice(0, MAX_STRANDS);
}

/** Fallback geométrico si el rig no trae el tono del scalp: sólo nuca, laterales y coronilla. */
function geometricFallback(rig: any): ReturnType<typeof pickRootCandidates> {
  const rest = rig.rest as Float32Array;
  const out: ReturnType<typeof pickRootCandidates> = [];
  for (let v = rig.bodyVertices; v < rig.n; v++) {
    const x = rest[3 * v], y = rest[3 * v + 1], z = rest[3 * v + 2];
    if (y < 78 || y > 94) continue;
    const theta = Math.atan2(z, x - 3.0);
    if (Math.abs(theta) < 0.9) continue;
    out.push({ v, x, y, z, u: theta < 0 ? theta + 2 * Math.PI : theta });
  }
  return out.slice(0, MAX_STRANDS * 2);
}

/** Interpola una lista de puntos de reposo a POINTS muestras equiespaciadas. */
function resample(points: THREE.Vector3[]): Float32Array {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + points[i].distanceTo(points[i - 1]));
  const total = distances[distances.length - 1] || 1;
  const out = new Float32Array(POINTS * 3);
  let j = 0;
  for (let i = 0; i < POINTS; i++) {
    const d = (i / (POINTS - 1)) * total;
    while (j < distances.length - 2 && distances[j + 1] < d) j++;
    const span = distances[j + 1] - distances[j] || 1;
    const t = (d - distances[j]) / span;
    const a = points[j], b = points[j + 1];
    out[3 * i] = a.x + (b.x - a.x) * t;
    out[3 * i + 1] = a.y + (b.y - a.y) * t;
    out[3 * i + 2] = a.z + (b.z - a.z) * t;
  }
  return out;
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
  const selected = spreadRoots(candidates.length >= MIN_STRANDS ? candidates : geometricFallback(rig), rng);

  // ── Plantillas de mechones (en reposo, relativas a la raíz, largo unitario) ──
  const strands: StrandTemplate[] = [];
  for (const root of selected) {
    const origin = new THREE.Vector3(root.x, root.y, root.z);
    const radial = new THREE.Vector3(root.x - 3.0, 0, root.z);
    if (radial.lengthSq() < 1e-4) radial.set(0, 0, root.z >= 0 ? 1 : -1);
    radial.normalize();
    const offsets = new Float32Array(POINTS * 3);
    const cursor = origin.clone();
    for (let i = 0; i < POINTS; i++) {
      const t = i / (POINTS - 1);
      // Sobre el cráneo la hebra sale radial y hacia abajo; luego cede a la gravedad.
      const dir = radial.clone().multiplyScalar(0.8 * (1 - t));
      dir.x -= 0.18 * (1 - t);
      dir.y -= 1;
      dir.normalize();
      cursor.addScaledVector(dir, 1 / (POINTS - 1));
      offsets[3 * i] = cursor.x - origin.x;
      offsets[3 * i + 1] = cursor.y - origin.y;
      offsets[3 * i + 2] = cursor.z - origin.z;
    }
    const jitter = new Float32Array(MAX_THREADS * 3);
    const threadGain = new Float32Array(MAX_THREADS);
    for (let t = 0; t < MAX_THREADS; t++) {
      const angle = rng() * Math.PI * 2;
      const r = 0.4 + rng() * 0.6; // 0.4..1.0 cm: con 40 hebras la cinta necesita más anchura
      jitter[3 * t] = Math.cos(angle) * r;
      jitter[3 * t + 1] = (rng() - 0.5) * 0.15;
      jitter[3 * t + 2] = Math.sin(angle) * r;
      threadGain[t] = 0.92 + rng() * 0.16;
    }
    strands.push({
      root: root.v,
      offsets,
      radial,
      phase: rng() * Math.PI * 2,
      gain: 0.75 + rng() * 0.5, // bandas de brillo: ±25 %
      lengthScale: 1,
      jitter,
      threadGain,
    });
  }
  // Si un rig raro no ofrece suficientes raíces, se degenera a un mechón sobre el hueso head.
  if (!strands.length) {
    const v = rig.bodyVertices > 0 ? rig.bodyVertices : 0;
    const offsets = new Float32Array(POINTS * 3);
    for (let i = 0; i < POINTS; i++) offsets[3 * i + 1] = -i / (POINTS - 1);
    strands.push({
      root: v,
      offsets,
      radial: new THREE.Vector3(0, 0, 1),
      phase: 0,
      gain: 1,
      lengthScale: 1,
      jitter: new Float32Array(MAX_THREADS * 3),
      threadGain: new Float32Array(MAX_THREADS).fill(1),
    });
  }
  const strandCount = strands.length;

  // ── Contorno: arco de nacimiento, laterales y nuca (4 líneas) ──
  const byAngle = strands.slice().sort((a, b) => rootU(a) - rootU(b));
  const arcPoints: THREE.Vector3[] = [];
  for (const s of byAngle) {
    const u = rootU(s);
    if (u < 0.75 || u > 2 * Math.PI - 0.75) continue;
    const o = 3 * s.root;
    arcPoints.push(new THREE.Vector3(
      rest[o] + s.radial.x * 1.2,
      rest[o + 1] + 0.4,
      rest[o + 2] + s.radial.z * 1.2
    ));
  }
  const contours: ContourTemplate[] = [];
  if (arcPoints.length >= 2) {
    const anchor = arcPoints[0];
    const arc = resample(arcPoints);
    for (let i = 0; i < POINTS; i++) {
      arc[3 * i] -= anchor.x;
      arc[3 * i + 1] -= anchor.y;
      arc[3 * i + 2] -= anchor.z;
    }
    contours.push({ root: byAngle.find((s) => rootU(s) >= 0.75)?.root ?? strands[0].root, points: arc });
  }
  const extremes = [
    strands.reduce((best, s) => (rest[3 * s.root + 2] > rest[3 * best.root + 2] ? s : best), strands[0]),
    strands.reduce((best, s) => (rest[3 * s.root + 2] < rest[3 * best.root + 2] ? s : best), strands[0]),
    strands.reduce((best, s) => (Math.abs(Math.abs(rootU(s)) - Math.PI) < Math.abs(Math.abs(rootU(best)) - Math.PI) ? s : best), strands[0]),
  ];
  while (contours.length < CONTOURS) {
    const s = extremes[(contours.length - 1 + extremes.length) % extremes.length];
    const points = new Float32Array(s.offsets);
    for (let i = 0; i < POINTS; i++) {
      const t = i / (POINTS - 1);
      const push = 1.3 + 0.8 * t;
      points[3 * i] += s.radial.x * push;
      points[3 * i + 2] += s.radial.z * push;
    }
    contours.push({ root: s.root, points });
  }

  function rootU(s: StrandTemplate): number {
    const o = 3 * s.root;
    const theta = Math.atan2(rest[o + 2], rest[o] - 3.0);
    return theta < 0 ? theta + 2 * Math.PI : theta;
  }

  // Mezcla de largos: la punta cae más en la nuca y menos en la coronilla; las sienes y laterales
  // quedan en un término medio. Con short el rango se recorta en update() (8..22 cm).
  for (const s of strands) {
    const u = rootU(s);
    const back = Math.abs(u - Math.PI) / Math.PI; // 0 delante, 1 detrás
    const high = THREE.MathUtils.clamp((rest[3 * s.root + 1] - 80) / 10, 0, 1);
    s.lengthScale = 0.7 + 0.3 * back - 0.15 * high;
  }

  // ── Geometría: contornos primero, después todos los mechones (cada uno con tinte al final) ──
  const contourVerts = contours.length * SEGMENTS * 2;
  const perStrandVerts = (MAX_THREADS + 1) * SEGMENTS * 2;
  const totalVerts = contourVerts + strandCount * perStrandVerts;
  const positions = new Float32Array(totalVerts * 3);
  const alphaBase = new Float32Array(totalVerts);
  const phaseAttr = new Float32Array(totalVerts);
  const alphaTemplate = new Float32Array(totalVerts);
  const strandAttr = new Float32Array(totalVerts);
  let w = 0;
  for (let c = 0; c < contours.length; c++) {
    for (let seg = 0; seg < SEGMENTS; seg++) {
      for (let k = 0; k < 2; k++) {
        const t = (seg + k) / SEGMENTS;
        alphaBase[w] = 1 - 0.25 * t;
        phaseAttr[w] = c * 1.7;
        strandAttr[w] = -1 - c;
        w++;
      }
    }
  }
  for (let s = 0; s < strandCount; s++) {
    const strand = strands[s];
    for (let thread = 0; thread < MAX_THREADS; thread++) {
      for (let seg = 0; seg < SEGMENTS; seg++) {
        for (let k = 0; k < 2; k++) {
          const t = (seg + k) / SEGMENTS;
          alphaBase[w] = strand.gain * strand.threadGain[thread] * (1 - 0.7 * t);
          phaseAttr[w] = strand.phase;
          strandAttr[w] = s;
          w++;
        }
      }
    }
    for (let seg = 0; seg < SEGMENTS; seg++) {
      for (let k = 0; k < 2; k++) {
        alphaBase[w] = 1;
        phaseAttr[w] = strand.phase;
        strandAttr[w] = TINT_MARK - s;
        w++;
      }
    }
  }

  alphaTemplate.set(alphaBase);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphaBase, 1);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("aAlpha", alphaAttr);
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phaseAttr, 1));
  geometry.setAttribute("aStrand", new THREE.BufferAttribute(strandAttr, 1));
  geometry.setDrawRange(0, totalVerts);

  const material = new THREE.ShaderMaterial({
    vertexShader: HAIR_VERT,
    fragmentShader: HAIR_FRAG,
    uniforms: {
      uColor: { value: hexToLinear(HAIR_TUNING_DEFAULTS.color) },
      uContourColor: { value: hexToLinear("#f3e2b8") },
      uStrandAlpha: { value: HAIR_TUNING_DEFAULTS.strandAlpha },
      uContourAlpha: { value: HAIR_TUNING_DEFAULTS.contourAlpha },
      uBodyAlpha: { value: HAIR_TUNING_DEFAULTS.bodyAlpha },
      uPx: { value: 1.4 },
    },
    transparent: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 2; // encima del vidrio de la ropa, sin escribir profundidad
  lines.frustumCulled = false;
  lines.visible = false;
  parent.add(lines);

  // Cápsulas de choque ancladas a huesos posados: torso/cuello, clavículas y brazos.
  const capsules: Capsule[] = [
    { a: rig.bone("hips"), b: rig.bone("upperchest"), radius: 12 },
    { a: rig.bone("upperchest"), b: rig.bone("neck"), radius: 8 },
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
  let lastDensity = -1;

  /** Escribe una polilínea de POINTS puntos como SEGMENTS segmentos de LineSegments. */
  const writeLine = (points: Float32Array, start: number) => {
    let o = start * 3;
    for (let seg = 0; seg < SEGMENTS; seg++) {
      for (let k = 0; k < 2; k++) {
        const p = 3 * (seg + k);
        positions[o] = points[p];
        positions[o + 1] = points[p + 1];
        positions[o + 2] = points[p + 2];
        o += 3;
      }
    }
  };

  /** Bucle caliente: escribe una hebra como 7 segmentos directamente en el buffer del LineSegments. */
function writeThread(
  positions: Float32Array,
  start: number,
  center: Float32Array,
  sway: Float32Array,
  jx: number,
  jy: number,
  jz: number
): void {
  let o = start * 3;
  for (let seg = 0; seg < SEGMENTS; seg++) {
    const fade = 1 - 0.25 * (seg / SEGMENTS);
    for (let k = 0; k < 2; k++) {
      const i = 3 * (seg + k);
      positions[o++] = center[i] + sway[i] + jx * fade;
      positions[o++] = center[i + 1] + jy * fade;
      positions[o++] = center[i + 2] + sway[i + 2] + jz * fade;
    }
  }
}

/** Empuja un punto fuera de las cápsulas del cuerpo con 1 cm de separación. */
  const collide = (p: Float32Array, i: number) => {
    const posed = rig.P;
    for (const cap of capsules) {
      const A = posed[cap.a], B = posed[cap.b];
      const min = cap.radius + 1;
      if (p[i + 1] > Math.max(A.y, B.y) + min || p[i + 1] < Math.min(A.y, B.y) - min) continue;
      const abx = B.x - A.x, aby = B.y - A.y, abz = B.z - A.z;
      const len2 = abx * abx + aby * aby + abz * abz || 1;
      const t = Math.max(0, Math.min(1, ((p[i] - A.x) * abx + (p[i + 1] - A.y) * aby + (p[i + 2] - A.z) * abz) / len2));
      const dx = p[i] - (A.x + abx * t);
      const dy = p[i + 1] - (A.y + aby * t);
      const dz = p[i + 2] - (A.z + abz * t);
      const d = Math.hypot(dx, dy, dz);
      if (d >= min) continue;
      if (d < 1e-4) {
        p[i + 2] += min;
        continue;
      }
      const push = (min - d) / d;
      p[i] += dx * push;
      p[i + 1] += dy * push;
      p[i + 2] += dz * push;
    }
  };

  const applyTuning = (t: HairTuning) => {
    tuning = t;
    material.uniforms.uStrandAlpha.value = t.strandAlpha;
    material.uniforms.uContourAlpha.value = t.contourAlpha;
    material.uniforms.uBodyAlpha.value = t.bodyAlpha;
    material.uniforms.uColor.value.copy(hexToLinear(t.color));
  };
  applyTuning(tuning);

  const update = (skinned: Float32Array, dt: number, time: number) => {
    if (!visible) return;

    // La densidad cambia cuántos mechones/hebras se dibujan; el buffer ya está reservado al máximo.
    const density = THREE.MathUtils.clamp(tuning.density, 0, 1);
    const activeStrands = Math.min(strandCount, Math.round(THREE.MathUtils.lerp(MIN_STRANDS, MAX_STRANDS, density)));
    const activeThreads = Math.round(THREE.MathUtils.lerp(MIN_THREADS, MAX_THREADS, density));
    if (density !== lastDensity) {
      lastDensity = density;
      let v = contourVerts;
      for (let s = 0; s < strandCount; s++) {
        for (let thread = 0; thread < MAX_THREADS; thread++, v += SEGMENTS * 2) {
          const on = s < activeStrands && thread < activeThreads ? 1 : 0;
          for (let j = 0; j < SEGMENTS * 2; j++) alphaBase[v + j] = alphaTemplate[v + j] * on;
        }
        // El tinte de un mechón inactivo también se apaga.
        const tintStart = v;
        v += SEGMENTS * 2;
        const on = s < activeStrands ? 1 : 0;
        for (let j = 0; j < SEGMENTS * 2; j++) alphaBase[tintStart + j] = alphaTemplate[tintStart + j] * on;
      }
      alphaAttr.needsUpdate = true;
      geometry.setDrawRange(0, contourVerts + activeStrands * perStrandVerts);
    }

    // Velocidad angular de cabeza y torso, leída de los huesos ya posados.
    const qHead = rig.S[headBone] as THREE.Quaternion;
    const qHip = rig.S[hipBone] as THREE.Quaternion;
    const safeDt = Math.max(1 / 240, Math.min(0.1, dt));
    const headSpeed = 2 * Math.acos(Math.min(1, Math.abs(prevHead.dot(qHead)))) / safeDt;
    const hipSpeed = 2 * Math.acos(Math.min(1, Math.abs(prevHip.dot(qHip)))) / safeDt;
    prevHead.copy(qHead);
    prevHip.copy(qHip);
    const drive = THREE.MathUtils.clamp(headSpeed * 0.5 + hipSpeed * 0.9, 0, 3) * tuning.sway;

    const baseLength = variant === "short"
      ? THREE.MathUtils.lerp(8, 22, tuning.length)
      : THREE.MathUtils.lerp(26, 66, tuning.length);
    const sweep = THREE.MathUtils.clamp(tuning.sweep, -1, 1) * 17; // cm de barrido lateral en la punta

    const center = new Float32Array(POINTS * 3);
    const sway = new Float32Array(POINTS * 3);
    const point = new Float32Array(3);

    const buildCenter = (s: StrandTemplate, lengthScale: number, outward: number, extraSweep: number) => {
      const root = 3 * s.root;
      const rx = skinned[root], ry = skinned[root + 1], rz = skinned[root + 2];
      const len = baseLength * lengthScale;
      for (let i = 0; i < POINTS; i++) {
        const t = i / SEGMENTS;
        const o = 3 * i;
        rotateInto(qHead, s.offsets[o] * len, s.offsets[o + 1] * len, s.offsets[o + 2] * len, point, 0);
        const push = outward * (0.4 + 0.6 * t);
        center[o] = rx + point[0] + s.radial.x * push;
        center[o + 1] = ry + point[1];
        center[o + 2] = rz + point[2] + s.radial.z * push + sweep * t * t + extraSweep * t;
        // Balanceo: fase propia por mechón, amplitud creciente hacia la punta.
        const amp = (0.12 + drive * 0.9) * t * t;
        const wave = Math.sin(time * 1.6 + s.phase + t * 1.1);
        sway[o] = -0.35 * amp * wave;
        sway[o + 1] = 0;
        sway[o + 2] = amp * wave;
        collide(center, o);
      }
    };

    // Contornos (no dependen de la densidad).
    let v = 0;
    for (const c of contours) {
      const root = 3 * c.root;
      const rx = skinned[root], ry = skinned[root + 1], rz = skinned[root + 2];
      for (let i = 0; i < POINTS; i++) {
        const o = 3 * i;
        rotateInto(qHead, c.points[o], c.points[o + 1], c.points[o + 2], point, 0);
        center[o] = rx + point[0];
        center[o + 1] = ry + point[1];
        center[o + 2] = rz + point[2];
      }
      writeLine(center, v);
      v += SEGMENTS * 2;
    }

    // Mechones: un centro por mechón y las hebras como desplazamientos rígidos sobre ese centro.
    for (let s = 0; s < activeStrands; s++) {
      const strand = strands[s];
      buildCenter(strand, strand.lengthScale, 0, 0);
      for (let thread = 0; thread < MAX_THREADS; thread++) {
        if (thread < activeThreads) {
          // El jitter es de 0.4..1.0 cm: se deja en el marco del cuerpo y no se gira con la cabeza.
          writeThread(positions, v, center, sway,
            strand.jitter[3 * thread], strand.jitter[3 * thread + 1], strand.jitter[3 * thread + 2]);
        }
        // Las hebras inactivas conservan su buffer: su alpha es 0.
        v += SEGMENTS * 2;
      }
      // Cinta de masa tenue: la polilínea central con uBodyAlpha.
      writeLine(center, v);
      v += SEGMENTS * 2;
    }
    posAttr.needsUpdate = true;
  };

  const setSpec = (next: HairSpec | undefined) => {
    variant = next?.variant === "short" ? "short" : "long";
  };

  return {
    setVisible(next: boolean) {
      visible = next;
      lines.visible = next;
    },
    setSpec,
    setTuning: applyTuning,
    update,
    dispose() {
      parent.remove(lines);
      geometry.dispose();
      material.dispose();
    },
  };
}
