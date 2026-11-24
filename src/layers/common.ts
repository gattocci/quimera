/**
 * Base compartida por las capas sobre el cuerpo base `vocal` (ropa; pelo después).
 *
 * Todas las capas reutilizan la malla del rig: sus meshes comparten la geometría que `RigView`
 * actualiza cada frame, así que siguen el cuerpo con `body.turn` y los gestos sin buffers propios.
 * El recorte se mide siempre sobre `aRest` (coordenadas de reposo del rig), nunca sobre `position`.
 *
 * Ejes confirmados en `chimera/docs/rig.md` y en los datos de `body.rig.bin`:
 *   x = delantero (+) / trasero (−), y = vertical, z = lateral (|z| crece hacia brazos y piernas).
 * El cuello está alrededor de y ≈ 61 cm, el codo a |z| ≈ 35 cm y el tobillo a y ≈ −70 cm.
 */

import * as THREE from "three";

/** Lo que una capa debe poder hacer sin conocer los detalles del renderer. */
export interface LayerHandle {
  /** Meshes añadidos al grupo del personaje (comparten la geometría del rig). */
  readonly meshes: readonly THREE.Mesh[];
  setVisible(visible: boolean): void;
  /** Libera solo los materiales propios; la geometría es del rig y la libera `RigView.dispose()`. */
  dispose(): void;
}

/** Utilidades GLSL de todas las capas: líneas de grosor en píxeles y ruido determinista. */
export const LAYER_UTILS_GLSL = /* glsl */ `
uniform float uPx;

// Línea centrada en d = 0, de uPx píxeles de ancho, con antialias por derivadas.
float lineAt(float d) {
  float aa = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(0.0, aa * uPx, abs(d));
}

// Línea periódica c = k·step, también en píxeles (misma familia que el cuerpo base).
float layerSlice(float c, float step) {
  float d = abs(fract(c / step + 0.5) - 0.5) * step;
  return lineAt(d);
}

float layerHash(float n) {
  return fract(sin(n * 12.9898 + 78.233) * 43758.5453);
}

// Codificación sRGB igual que la malla del cuerpo; el renderer usa LinearSRGBColorSpace.
vec3 layerEncode(vec3 linear) {
  vec3 c = max(linear, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

/**
 * Regiones de la ropa en coordenadas de reposo, compartidas por el shader de la prenda y por el
 * cuerpo base: así el cuerpo puede bajar su alpha justo donde la tela lo tapa, sin duplicar líneas.
 * Los números están en cm del rig y son constantes (no uniforms) para que ambos shaders coincidan.
 */
export const CLOTH_REGION_GLSL = /* glsl */ `
const float CLOTH_NECK_Y = 61.0;   // base del cuello
const float CLOTH_HIP_Y = 14.0;    // dobladillo de la remera
const float CLOTH_WAIST_Y = 34.0;  // cintura del pantalón
const float CLOTH_ANKLE_Y = -68.0; // tobillo, antes del pie
const float CLOTH_SLEEVE_Z = 30.0; // manga corta: antes del codo (|z| ≈ 35)
const float CLOTH_TORSO_Z = 17.0;  // semiancho del torso
const float CLOTH_FEATHER = 1.6;   // transición suave del recorte, en cm

// Escote redondo: más bajo adelante (x > 0) y más alto hacia los hombros y la nuca.
float clothNeckY(vec3 r) {
  float front = smoothstep(-3.0, 8.0, r.x);
  float shoulder = smoothstep(6.0, 15.0, abs(r.z));
  return CLOTH_NECK_Y - 3.2 * front + 3.0 * shoulder;
}

float clothShirtMask(vec3 r) {
  float top = 1.0 - smoothstep(clothNeckY(r) - CLOTH_FEATHER, clothNeckY(r) + CLOTH_FEATHER, r.y);
  float hem = smoothstep(CLOTH_HIP_Y - CLOTH_FEATHER, CLOTH_HIP_Y + CLOTH_FEATHER, r.y);
  float guard = 1.0 - smoothstep(62.0, 65.0, r.y); // la cara y el tracto quedan intactos
  float torso = top * hem * guard
              * (1.0 - smoothstep(CLOTH_TORSO_Z - CLOTH_FEATHER, CLOTH_TORSO_Z + CLOTH_FEATHER, abs(r.z)));
  float sleeve = smoothstep(31.0 - CLOTH_FEATHER, 31.0 + CLOTH_FEATHER, r.y)
                * (1.0 - smoothstep(55.0, 59.0, r.y))
                * smoothstep(15.0, 17.5, abs(r.z))
                * (1.0 - smoothstep(CLOTH_SLEEVE_Z - CLOTH_FEATHER, CLOTH_SLEEVE_Z + CLOTH_FEATHER, abs(r.z)));
  return clamp(max(torso, sleeve), 0.0, 1.0);
}

float clothPantsMask(vec3 r) {
  float top = 1.0 - smoothstep(CLOTH_WAIST_Y - CLOTH_FEATHER, CLOTH_WAIST_Y + CLOTH_FEATHER, r.y);
  float hem = smoothstep(CLOTH_ANKLE_Y - CLOTH_FEATHER, CLOTH_ANKLE_Y + CLOTH_FEATHER, r.y);
  float inner = 7.0 * (1.0 - smoothstep(0.0, 10.0, r.y)); // separación entre piernas
  float inseam = smoothstep(inner - CLOTH_FEATHER, inner + CLOTH_FEATHER, abs(r.z));
  float width = 23.0 - 2.5 * smoothstep(CLOTH_ANKLE_Y, CLOTH_WAIST_Y, r.y); // más ancho abajo
  float outer = 1.0 - smoothstep(width - CLOTH_FEATHER, width + CLOTH_FEATHER, abs(r.z));
  return clamp(top * hem * inseam * outer, 0.0, 1.0);
}

float outfitCoverage(vec3 r) {
  return max(clothShirtMask(r), clothPantsMask(r));
}
`;

/** Hex `#rrggbb` → vector lineal para los uniforms de color. */
export function hexToLinear(hex: string): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

/** Seed estable a partir de un id: la misma escena da siempre la misma prenda. */
export function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

/** Crea un mesh que comparte la geometría del rig, sin poseerla. */
export function makeLayerMesh(
  parent: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.ShaderMaterial,
  renderOrder: number
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  mesh.visible = false;
  parent.add(mesh);
  return mesh;
}

/** Implementación común de `LayerHandle`: quita los meshes y libera solo sus materiales. */
export function layerHandle(
  parent: THREE.Group,
  meshes: THREE.Mesh[],
  materials: THREE.ShaderMaterial[]
): LayerHandle {
  return {
    meshes,
    setVisible(visible: boolean) {
      for (const m of meshes) m.visible = visible;
    },
    dispose() {
      for (const m of meshes) parent.remove(m);
      for (const m of materials) m.dispose();
    },
  };
}
