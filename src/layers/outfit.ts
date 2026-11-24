/**
 * Capa de ropa sobre el cuerpo base: vidrio tenue por defecto, mate opaco como opción.
 *
 * Cabeza, cuerpo, ropa y pelo son LUZ. El vidrio necesita profundidad: un relleno translúcido
 * sobre negro se lee como gris plano. Para devolverle volumen sin volver a mostrar el cuerpo:
 *   1) revés del vidrio (BackSide, transparente, renderOrder -8): solo silueta, bordes, curvas y
 *      costuras muy tenues, dibujado antes de escribir profundidad;
 *   2) prepass (renderOrder -7, transparente para que Three.js lo ordene después del revés): mismo
 *      casco, `colorWrite: false`, `depthWrite: true`, tapa el cuerpo holográfico;
 *   3) vidrio visible (FrontSide, sin `depthWrite`, `LessEqual`, renderOrder 1): relleno bajo con
 *      fresnel ganable y trazo luminoso;
 *   4) mate opaco opcional (renderOrder -5), solo con `material: "solid"`.
 *
 * En la franja y = 14..34 cm remera y pantalón se solapan (228 vértices del rig con ambas máscaras
 * en 1.00). Los pases visibles del pantalón se descartan donde la remera cubre, para no sumar alpha.
 *
 * El recorte sigue anclado a `aRest` y usa las mismas regiones que el cuerpo; la malla es la del
 * rig, así que la ropa sigue `body.turn` y los gestos sin deslizarse. No se han tocado los umbrales
 * de `CLOTH_REGION_GLSL` ni de `outfitCoverageOut()`.
 *
 * En desarrollo se pueden ajustar los valores sin recompilar:
 *   ?clothSolid=0&clothFill=0.10&clothEdgeGain=1.6&clothAlpha=0.35&clothBackAlpha=0.25
 *   &clothEdge=0.85&clothOffset=1.1&shirtColor=aeb9c3&pantsColor=66737f
 */

import * as THREE from "three";
import {
  CLOTH_REGION_GLSL,
  LAYER_UTILS_GLSL,
  hexToLinear,
  layerHandle,
  makeLayerMesh,
  type LayerHandle,
} from "./common.ts";
import {
  seedOutfitTuningDefaults,
  type OutfitTuning,
} from "./outfitTuning.ts";

const OUTFIT_VERT = /* glsl */ `
attribute vec3 aRest;
uniform float uOffset;
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocalN; // normal ya posada, en espacio del objeto: no depende de la cámara
varying vec3 vRest;
void main() {
  vec3 p = position + normal * uOffset;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  vLocalN = normal;
  vRest = aRest;
  gl_Position = projectionMatrix * mv;
}
`;

/** Preludio compartido por los cuatro pases. */
const OUTFIT_COMMON = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uEdgeColor;
uniform vec3 uHaloColor;
uniform float uAlpha;      // trazo de curvas, costuras y pliegues
uniform float uFill;       // alpha del relleno en el centro
uniform float uEdgeGain;   // cuánto sube el alpha hacia la silueta
uniform float uBackAlpha;  // alpha del revés
uniform float uEdgeAlpha;  // bordes de prenda, luminosos
uniform float uSolid;      // 0 = vidrio, 1 = mate opaco
uniform float uDetail;
uniform float uSeed;
uniform float uGarment; // 0 = remera, 1 = pantalón
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocalN;
varying vec3 vRest;

${LAYER_UTILS_GLSL}
${CLOTH_REGION_GLSL}

// Las horizontales siguen la sección (flancos más altos) y la normal posada del rig. La amplitud
// queda acotada al feather del recorte para que la curva no se salga de la tela.
float clothCurvedY(vec3 r, vec3 nObj, float baseY) {
  float flank = pow(clamp(abs(r.z) / 17.0, 0.0, 1.0), 1.7);
  return baseY + 0.8 * flank + 0.4 * clamp(nObj.y, -1.0, 1.0);
}

// Cobertura de render. CLOTH_REGION_GLSL queda intacto: aquí solo se cierran los huecos vistos en
// el rig (hombro, pantorrilla, entrepierna y costado) para que no aparezca el cuerpo debajo.
// El parámetro garment permite preguntar por la otra prenda sin cambiar uniforms.
float outfitCoverageFor(vec3 r, float garment) {
  if (garment < 0.5) {
    float top = 1.0 - smoothstep(clothNeckY(r) - CLOTH_FEATHER, clothNeckY(r) + CLOTH_FEATHER, r.y);
    float hem = smoothstep(CLOTH_HIP_Y - CLOTH_FEATHER, CLOTH_HIP_Y + CLOTH_FEATHER, r.y);
    float guard = 1.0 - smoothstep(62.0, 65.0, r.y);
    // Costado de axila / cadera.
    float side = (1.0 - smoothstep(CLOTH_TORSO_Z + 1.0, CLOTH_TORSO_Z + 4.0, abs(r.z))) * top * hem * guard;
    // El recorte de manga se apagaba en y = 55..59 mientras el torso ya se cortaba en |z| ≈ 17:
    // entre 17 y 23 cm de lateral y y ≈ 58..61 no cubría nada (parche del hombro).
    float shoulder = smoothstep(29.0, 32.0, r.y) * (1.0 - smoothstep(60.0, 64.0, r.y))
                   * smoothstep(9.5, 12.0, abs(r.z))
                   * (1.0 - smoothstep(CLOTH_SLEEVE_Z + 1.0, CLOTH_SLEEVE_Z + 3.0, abs(r.z)))
                   * guard;
    return max(max(clothShirtMask(r), side), shoulder);
  }
  float top = 1.0 - smoothstep(CLOTH_WAIST_Y - CLOTH_FEATHER, CLOTH_WAIST_Y + CLOTH_FEATHER, r.y);
  float hem = smoothstep(CLOTH_ANKLE_Y - CLOTH_FEATHER, CLOTH_ANKLE_Y + CLOTH_FEATHER, r.y);
  float width = 23.0 - 2.5 * smoothstep(CLOTH_ANKLE_Y, CLOTH_WAIST_Y, r.y);
  // El ancho compartido se quedaba corto en la pantorrilla (|z| ≈ 23, y ≈ -45..-54). Ensanchar el
  // borde exterior sin borrar la hendidura interior mantiene las piernas separadas.
  float inner = 7.0 * (1.0 - smoothstep(0.0, 10.0, r.y));
  float inseam = smoothstep(inner - CLOTH_FEATHER, inner + CLOTH_FEATHER, abs(r.z));
  float outer = 1.0 - smoothstep(width + 2.5 - CLOTH_FEATHER, width + 2.5 + CLOTH_FEATHER, abs(r.z));
  float legSide = top * hem * inseam * outer;
  // Relleno del deltoides entre piernas: arriba se cierra, se abre hacia media pierna.
  float bridge = smoothstep(-34.0, -18.0, r.y);
  return max(max(clothPantsMask(r), legSide), top * hem * outer * bridge);
}

float outfitCoverageOut(vec3 r) { return outfitCoverageFor(r, uGarment); }
float shirtCovers(vec3 r) { return outfitCoverageFor(r, 0.0); }

// Bordes reales de la prenda: cuello, puño, dobladillo de la remera y tobillo del pantalón.
// La cintura sigue sin dibujarse como cinturón.
float outfitBrightEdge(vec3 r, vec3 nObj, float garment, float mask) {
  float brightEdge = 0.0;
  if (garment < 0.5) {
    // Escote: ya curva por clothNeckY (más bajo adelante); no lo subimos hacia la mandíbula.
    float neckline = lineAt(r.y - clothNeckY(r)) * smoothstep(50.0, 56.0, r.y);
    float hem = lineAt(r.y - clothCurvedY(r, nObj, CLOTH_HIP_Y))
              * (1.0 - smoothstep(17.0, 20.0, abs(r.z)));
    // Puño: anillo cerrado en |z| = CLOTH_SLEEVE_Z (perpendicular al eje del brazo en A-pose).
    float armR = length(vec2(r.x - 2.0, r.y - 42.0));
    float cuff = lineAt(abs(r.z) - CLOTH_SLEEVE_Z)
               * smoothstep(4.0, 6.0, armR) * (1.0 - smoothstep(9.0, 11.0, armR));
    brightEdge = max(max(neckline, hem), cuff);
  } else {
    brightEdge = lineAt(r.y - clothCurvedY(r, nObj, CLOTH_ANKLE_Y))
               * (1.0 - smoothstep(26.0, 30.0, abs(r.z)));
  }
  return brightEdge * smoothstep(0.08, 0.4, mask);
}

// Curvas verticales ancladas al reposo; aparecen a partir de detail = 0.3.
float outfitCurves(vec3 r) {
  float tCurve = smoothstep(0.3, 0.55, uDetail);
  float zStep = mix(34.0, 14.0, smoothstep(0.4, 1.0, uDetail));
  float xStep = mix(26.0, 11.0, smoothstep(0.4, 1.0, uDetail));
  float frontBack = smoothstep(3.0, 8.0, abs(r.x));
  float flanks = smoothstep(9.0, 14.0, abs(r.z));
  return max(layerSlice(r.z, zStep) * frontBack, layerSlice(r.x, xStep) * flanks) * tCurve;
}

// Costuras de hombro / costado y del exterior del pantalón; detail >= 0.78.
float outfitSeam(vec3 r, float garment, float mask) {
  float seam = 0.0;
  if (garment < 0.5) {
    float shoulder = lineAt(abs(r.z) - 18.0) * smoothstep(46.0, 52.0, r.y)
                   * (1.0 - smoothstep(56.0, 60.0, r.y));
    float side = lineAt(abs(r.z) - 15.5) * smoothstep(18.0, 22.0, r.y)
               * (1.0 - smoothstep(52.0, 56.0, r.y));
    seam = max(shoulder, side);
  } else {
    float width = 23.0 - 2.5 * smoothstep(CLOTH_ANKLE_Y, CLOTH_WAIST_Y, r.y);
    seam = lineAt(abs(r.z) - width) * smoothstep(-62.0, -56.0, r.y)
         * (1.0 - smoothstep(26.0, 32.0, r.y));
  }
  return seam * smoothstep(0.78, 0.98, uDetail) * smoothstep(0.15, 0.5, mask);
}

// Pliegues cortos junto al dobladillo; detail >= 0.82.
float outfitFolds(vec3 r, float garment) {
  float phase = layerHash(uSeed) * 6.2831853;
  float hemY = garment < 0.5 ? CLOTH_HIP_Y : CLOTH_ANKLE_Y;
  return layerSlice(abs(r.z) + 1.4 * sin(0.22 * r.y + phase), 9.0)
       * (1.0 - smoothstep(16.0, 34.0, abs(r.y - hemY)))
       * smoothstep(3.0, 8.0, abs(r.x)) * smoothstep(0.82, 1.0, uDetail);
}

// Peso compartido del trazo: silueta, fresnel, curvas, costuras y pliegues.
float outfitLineWeight(vec3 r, vec3 nObj, float garment, float mask, float facing,
                       out float brightEdge) {
  float outline = 1.0 - smoothstep(0.07, 0.24, facing);
  float halo = pow(1.0 - facing, 2.6);
  brightEdge = outfitBrightEdge(r, nObj, garment, mask);
  return outline * 0.85 + halo * 0.12
       + outfitCurves(r) * 0.7 + outfitSeam(r, garment, mask) * 0.7
       + outfitFolds(r, garment) * 0.6;
}
`;

/** Revés del vidrio: antes del prepass, sin profundidad y con un trazo muy tenue. */
const OUTFIT_BACK_FRAG = /* glsl */ `
${OUTFIT_COMMON}

void main() {
  float mask = outfitCoverageOut(vRest);
  if (uGarment > 0.5 && shirtCovers(vRest) > 0.5) discard;
  if (mask < 0.02) discard;

  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));
  float brightEdge;
  float weight = outfitLineWeight(vRest, vLocalN, uGarment, mask, facing, brightEdge);
  // Solo un susurro de relleno (0.05) para que el revés no se lea como una segunda tela.
  float alpha = clamp(uBackAlpha * mask * (0.05 + weight + brightEdge * 0.8), 0.0, 0.6);
  if (alpha < 0.006) discard;

  vec3 col = mix(uColor * 0.75, uEdgeColor * 0.85, brightEdge * 0.7)
           + uHaloColor * 0.18 * pow(1.0 - facing, 2.6);
  gl_FragColor = vec4(layerEncode(col), alpha);
}
`;

/** Prepass: solo escribe profundidad para ocultar el cuerpo detrás de la tela. */
const OUTFIT_DEPTH_FRAG = /* glsl */ `
${OUTFIT_COMMON}

void main() {
  if (outfitCoverageOut(vRest) < 0.5) discard;
  gl_FragColor = vec4(0.0); // colorWrite está desactivado
}
`;

/** Pase mate opaco, reservado a `material: "solid"`. */
const OUTFIT_SOLID_FRAG = /* glsl */ `
${OUTFIT_COMMON}

void main() {
  float mask = outfitCoverageOut(vRest);
  if (mask < 0.5) discard;

  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));
  vec3 lightDir = normalize(vec3(-0.4, 0.6, 0.7)); // fijo en espacio de vista
  float diffuse = max(dot(n, lightDir), 0.0);
  float fresnel = pow(1.0 - facing, 2.2);
  float shade = 0.35 + 0.5 * diffuse + 0.12 * fresnel;
  vec3 matte = uColor * shade;
  matte += uHaloColor * 0.25 * pow(1.0 - facing, 4.0);
  gl_FragColor = vec4(layerEncode(matte), 1.0);
}
`;

/** Pase visible: vidrio emisivo + trazo. Con uSolid = 1 el relleno se apaga y quedan las líneas. */
const OUTFIT_GLASS_FRAG = /* glsl */ `
${OUTFIT_COMMON}

void main() {
  float mask = outfitCoverageOut(vRest);
  // En el solape con la remera (y = 14..34 cm) el pantalón no dibuja: dos rellenos sumaban alpha
  // y dejaban una banda más clara. El prepass del pantalón sigue activo, así que el cuerpo no asoma.
  if (uGarment > 0.5 && shirtCovers(vRest) > 0.5) discard;
  if (mask < 0.02) discard;

  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));
  float brightEdge;
  float weight = outfitLineWeight(vRest, vLocalN, uGarment, mask, facing, brightEdge);

  float halo = pow(1.0 - facing, 2.6);
  float glassAlpha = uFill * mask * (1.0 + uEdgeGain * halo) * (1.0 - uSolid);
  float lineAlpha = uAlpha * mask * weight;
  float edgeAlpha = uEdgeAlpha * brightEdge;
  float alpha = clamp(glassAlpha + lineAlpha + edgeAlpha, 0.0, 1.0);
  if (alpha < 0.006) discard;

  vec3 col = mix(uColor, uEdgeColor, brightEdge * 0.85) + uHaloColor * 0.30 * halo;
  gl_FragColor = vec4(layerEncode(col), alpha);
}
`;

export interface OutfitSpec {
  /** `tee-pants` es la única variante de este mensaje. */
  variant?: "tee-pants";
  enabled?: boolean;
  color?: string;
  /** Vidrio emisivo (por defecto) o mate opaco. */
  material?: "glass" | "solid";
  /** 0 = solo silueta y bordes; 0.5 = + curvas; 1 = + costuras y pliegues. */
  detail?: number;
  /** Semilla determinista para la fase de los pliegues. */
  seed?: number;
  density?: number;
  /** Ajustes vidrio persistidos en el JSON y reflejados en el store ligero del panel. */
  fill?: number;
  edgeGain?: number;
  lineAlpha?: number;
  backAlpha?: number;
  offset?: number;
}

export interface OutfitLayerHandle extends LayerHandle {
  setSpec(spec: OutfitSpec | undefined): void;
  /** Aplica los ajustes del panel sin reconstruir la escena ni tocar la geometría. */
  setTuning(tuning: OutfitTuning): void;
}

/** Valores que no van en el panel: acabado, borde y colores. */
const OUTFIT_TUNING = {
  solid: 0,
  edge: 0.85,
  shirtColor: "#aeb9c3",
  pantsColor: "#66737f",
};

/** Azul de línea del cuerpo, en luz lineal (CHIMERA_LOOK.line). */
const HALO_LINEAR = new THREE.Vector3(0.06, 0.36, 0.68);
/** Borde luminoso de la prenda, en luz lineal (#d0d8df). */
const EDGE_LINEAR = hexToLinear("#d0d8df");

/** Solo en desarrollo: los parámetros de URL siembran los defaults del store del panel. */
function devTuning() {
  const fallback = { ...OUTFIT_TUNING };
  const tuning: Partial<OutfitTuning> = {};
  if (!import.meta.env.DEV || typeof window === "undefined") return { fallback, tuning };
  const params = new URLSearchParams(window.location.search);
  const read = (key: string, min: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : undefined;
  };
  const readHex = (key: string, def: string) => {
    const raw = params.get(key)?.replace(/^#/, "");
    return raw && /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw.toLowerCase()}` : def;
  };
  Object.assign(tuning, {
    fill: read("clothFill", 0, 0.5),
    edgeGain: read("clothEdgeGain", 0, 2),
    lineAlpha: read("clothAlpha", 0, 1),
    backAlpha: read("clothBackAlpha", 0, 0.6),
    offset: read("clothOffset", 0.6, 2),
  });
  fallback.solid = read("clothSolid", 0, 1) ?? fallback.solid;
  fallback.edge = read("clothEdge", 0, 1) ?? fallback.edge;
  fallback.shirtColor = readHex("shirtColor", fallback.shirtColor);
  fallback.pantsColor = readHex("pantsColor", fallback.pantsColor);
  return { fallback, tuning };
}

const DEV = devTuning();
const TUNING = DEV.fallback;
seedOutfitTuningDefaults(DEV.tuning);

type Garment = "shirt" | "pants";
type Pass = "back" | "depth" | "solid" | "glass";

const PASS_FRAG: Record<Pass, string> = {
  back: OUTFIT_BACK_FRAG,
  depth: OUTFIT_DEPTH_FRAG,
  solid: OUTFIT_SOLID_FRAG,
  glass: OUTFIT_GLASS_FRAG,
};

function makeMaterial(garment: Garment, pass: Pass, color: string): THREE.ShaderMaterial {
  const isBack = pass === "back";
  const isDepth = pass === "depth";
  const isSolid = pass === "solid";
  return new THREE.ShaderMaterial({
    vertexShader: OUTFIT_VERT,
    fragmentShader: PASS_FRAG[pass],
    uniforms: {
      uColor: { value: hexToLinear(color) },
      uEdgeColor: { value: EDGE_LINEAR.clone() },
      uHaloColor: { value: HALO_LINEAR.clone() },
      uAlpha: { value: 0.35 },
      uFill: { value: 0.1 },
      uEdgeGain: { value: 1.6 },
      uBackAlpha: { value: 0.25 },
      uEdgeAlpha: { value: TUNING.edge },
      uSolid: { value: TUNING.solid },
      uDetail: { value: 0.5 },
      uSeed: { value: 0 },
      uGarment: { value: garment === "shirt" ? 0 : 1 },
      uPx: { value: 1.4 },
      uOffset: { value: 1.1 },
    },
    // Three.js dibuja la lista opaca antes que la transparente, y renderOrder solo ordena dentro
    // de cada lista. El prepass debe ser transparente para que el revés (-8) se dibuje ANTES que
    // él (-7) y que el cuerpo (-3/-2) siga quedando oculto por su profundidad.
    transparent: isBack || isDepth || pass === "glass",
    side: isBack ? THREE.BackSide : THREE.FrontSide,
    colorWrite: !isDepth,
    depthWrite: isDepth || isSolid,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    // El prepass se aparta un pelo del pase visible para no pelear con él; el vidrio no escribe
    // profundidad y con LessEqual dibuja sobre la misma superficie sin z-fighting.
    polygonOffset: isDepth,
    polygonOffsetFactor: isDepth ? 1 : 0,
    polygonOffsetUnits: isDepth ? 1 : 0,
  });
}

/**
 * Monta las dos prendas sobre el grupo del personaje. La geometría es la del rig (la que ya tiene
 * `aRest`): no se copia ni se posee, y `RigView.dispose()` la libera.
 */
export function createOutfitLayer(
  parent: THREE.Group,
  geometry: THREE.BufferGeometry,
  spec: OutfitSpec | undefined
): OutfitLayerHandle {
  const materials: THREE.ShaderMaterial[] = [];
  const meshes: THREE.Mesh[] = [];
  const solidMeshes: THREE.Mesh[] = [];
  const backMeshes: THREE.Mesh[] = [];
  // Revés antes del prepass (-7) y del cuerpo (-3/-2); mate antes que el vidrio; vidrio al final.
  const orders: Record<Pass, number> = { back: -8, depth: -7, solid: -5, glass: 1 };

  for (const garment of ["shirt", "pants"] as const) {
    const color = spec?.color ?? (garment === "shirt" ? TUNING.shirtColor : TUNING.pantsColor);
    const back = makeMaterial(garment, "back", color);
    const depth = makeMaterial(garment, "depth", color);
    const solid = makeMaterial(garment, "solid", color);
    const glass = makeMaterial(garment, "glass", color);
    materials.push(back, depth, solid, glass);
    const backMesh = makeLayerMesh(parent, geometry, back, orders.back);
    const solidMesh = makeLayerMesh(parent, geometry, solid, orders.solid);
    meshes.push(
      backMesh,
      makeLayerMesh(parent, geometry, depth, orders.depth),
      solidMesh,
      makeLayerMesh(parent, geometry, glass, orders.glass)
    );
    solidMeshes.push(solidMesh);
    backMeshes.push(backMesh);
  }

  const base = layerHandle(parent, meshes, materials);
  let visible = false;
  let useSolid = false;

  const applyTuning = (t: OutfitTuning) => {
    for (const m of materials) {
      m.uniforms.uFill.value = t.fill;
      m.uniforms.uEdgeGain.value = t.edgeGain;
      m.uniforms.uAlpha.value = t.lineAlpha;
      m.uniforms.uBackAlpha.value = t.backAlpha;
      m.uniforms.uOffset.value = t.offset;
    }
  };

  const apply = (s: OutfitSpec | undefined) => {
    const detail = THREE.MathUtils.clamp(s?.detail ?? 0.5, 0, 1);
    const seed = s?.seed ?? 0;
    useSolid = TUNING.solid > 0.5 || s?.material === "solid";
    for (const m of materials) {
      const garment = m.uniforms.uGarment.value as number;
      const color = s?.color ?? (garment < 0.5 ? TUNING.shirtColor : TUNING.pantsColor);
      m.uniforms.uColor.value.copy(hexToLinear(color));
      m.uniforms.uDetail.value = detail;
      m.uniforms.uSeed.value = seed;
      m.uniforms.uSolid.value = useSolid ? 1 : 0;
    }
    visible = !!s && s.enabled !== false;
    base.setVisible(visible);
    // El mate solo se monta cuando se pide; el revés es exclusivo del vidrio. Prepass y vidrio
    // (con uSolid = 1 reduce su relleno a cero y deja las líneas) quedan siempre activos.
    for (const m of solidMeshes) m.visible = visible && useSolid;
    for (const m of backMeshes) m.visible = visible && !useSolid;
  };
  apply(spec);

  const setVisible = (v: boolean) => {
    visible = v;
    base.setVisible(v);
    for (const m of solidMeshes) m.visible = v && useSolid;
    for (const m of backMeshes) m.visible = v && !useSolid;
  };

  return { ...base, setVisible, setTuning: applyTuning, setSpec: apply };
}
