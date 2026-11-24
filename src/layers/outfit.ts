/**
 * Capa de ropa sobre el cuerpo base: vidrio emisivo por defecto, mate opaco como opción.
 *
 * Cabeza, cuerpo y pelo son LUZ; la ropa también emite. La tela no es plástico: es un cristal con
 * borde luminoso que tapa el cuerpo holográfico que queda detrás. Para separar OCULTAR de DIBUJAR:
 *   1) prepass de profundidad: mismo casco, `colorWrite: false`, `depthWrite: true`, antes del cuerpo;
 *   2) pase visible de vidrio: transparente, sin `depthWrite`, `depthFunc: LessEqual`, solo caras
 *      frontales (el prepass ya esconde las traseras);
 *   3) pase mate opaco: solo cuando `material: "solid"` (o `?clothSolid=1` en desarrollo).
 *
 * El recorte sigue anclado a `aRest` y usa las regiones del rigor; la malla es la del rig, así que
 * la ropa sigue `body.turn` y los gestos sin deslizarse.
 *
 * En desarrollo se pueden ajustar los valores sin recompilar:
 *   ?clothSolid=0&clothFill=0.22&clothAlpha=0.5&clothEdge=0.85&clothOffset=1.1
 *   &shirtColor=aeb9c3&pantsColor=66737f
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

/** Preludio compartido: uniforms, regiones y la cobertura de render (extends regiones, no las cambia). */
const OUTFIT_COMMON = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uEdgeColor;
uniform vec3 uHaloColor;
uniform float uAlpha;     // trazo de curvas, costuras y pliegues
uniform float uFill;      // alpha del vidrio en el centro; sube con el fresnel
uniform float uEdgeAlpha; // bordes de prenda, luminosos
uniform float uSolid;     // 0 = vidrio, 1 = mate opaco
uniform float uBack;
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
float outfitCoverageOut(vec3 r) {
  if (uGarment < 0.5) {
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
  if (mask < 0.02) discard;

  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));
  float outline = 1.0 - smoothstep(0.07, 0.24, facing);
  float halo = pow(1.0 - facing, 2.6); // fresnel suave

  // Bordes reales de la prenda: cuello, puño, dobladillo de la remera y tobillo del pantalón.
  // La cintura sigue sin dibujarse como cinturón.
  float brightEdge = 0.0;
  if (uGarment < 0.5) {
    // Escote: ya curva por clothNeckY (más bajo adelante); no lo subimos hacia la mandíbula.
    float neckline = lineAt(vRest.y - clothNeckY(vRest))
                   * smoothstep(50.0, 56.0, vRest.y);
    float hem = lineAt(vRest.y - clothCurvedY(vRest, vLocalN, CLOTH_HIP_Y))
              * (1.0 - smoothstep(17.0, 20.0, abs(vRest.z)));
    // Puño: anillo cerrado en |z| = CLOTH_SLEEVE_Z (perpendicular al eje del brazo en A-pose).
    // Antes se recortaba en y = 32..50 y parecía un corte seco; ahora envuelve todo el bíceps.
    float armR = length(vec2(vRest.x - 2.0, vRest.y - 42.0));
    float cuff = lineAt(abs(vRest.z) - CLOTH_SLEEVE_Z)
               * smoothstep(4.0, 6.0, armR) * (1.0 - smoothstep(9.0, 11.0, armR));
    brightEdge = max(max(neckline, hem), cuff);
  } else {
    float ankle = lineAt(vRest.y - clothCurvedY(vRest, vLocalN, CLOTH_ANKLE_Y))
                * (1.0 - smoothstep(26.0, 30.0, abs(vRest.z)));
    brightEdge = ankle;
  }
  brightEdge *= smoothstep(0.08, 0.4, mask);

  // Un único sistema de detalle: 0 = silueta + bordes, 0.5 = + curvas, 1 = + costuras y pliegues.
  float tCurve = smoothstep(0.3, 0.55, uDetail);
  float tSeam = smoothstep(0.78, 0.98, uDetail);
  float tFold = smoothstep(0.82, 1.0, uDetail);
  float zStep = mix(34.0, 14.0, smoothstep(0.4, 1.0, uDetail));
  float xStep = mix(26.0, 11.0, smoothstep(0.4, 1.0, uDetail));
  float frontBack = smoothstep(3.0, 8.0, abs(vRest.x));
  float flanks = smoothstep(9.0, 14.0, abs(vRest.z));
  float curves = max(layerSlice(vRest.z, zStep) * frontBack, layerSlice(vRest.x, xStep) * flanks);

  float seam = 0.0;
  if (uGarment < 0.5) {
    float shoulder = lineAt(abs(vRest.z) - 18.0) * smoothstep(46.0, 52.0, vRest.y)
                   * (1.0 - smoothstep(56.0, 60.0, vRest.y));
    float side = lineAt(abs(vRest.z) - 15.5) * smoothstep(18.0, 22.0, vRest.y)
               * (1.0 - smoothstep(52.0, 56.0, vRest.y));
    seam = max(shoulder, side);
  } else {
    float width = 23.0 - 2.5 * smoothstep(CLOTH_ANKLE_Y, CLOTH_WAIST_Y, vRest.y);
    seam = lineAt(abs(vRest.z) - width) * smoothstep(-62.0, -56.0, vRest.y)
         * (1.0 - smoothstep(26.0, 32.0, vRest.y));
  }
  seam *= smoothstep(0.15, 0.5, mask);

  float phase = layerHash(uSeed) * 6.2831853;
  float hemY = uGarment < 0.5 ? CLOTH_HIP_Y : CLOTH_ANKLE_Y;
  float folds = layerSlice(abs(vRest.z) + 1.4 * sin(0.22 * vRest.y + phase), 9.0)
              * (1.0 - smoothstep(16.0, 34.0, abs(vRest.y - hemY))) * frontBack;

  // Cristal: uFill = 0.22 en el centro y ≈ 0.50 en la silueta (fresnel).
  float glassAlpha = uFill * mask * (1.0 + 1.27 * halo) * (1.0 - uSolid);
  float lineAlpha = uAlpha * mask * (outline * 0.85 + halo * 0.12
                  + curves * tCurve * 0.7 + seam * tSeam * 0.7 + folds * tFold * 0.6);
  float edgeAlpha = uEdgeAlpha * brightEdge;
  float backFactor = uBack > 0.5 ? 0.32 : 1.0;
  float alpha = clamp((glassAlpha + lineAlpha + edgeAlpha) * backFactor, 0.0, 1.0);
  if (alpha < 0.006) discard;

  vec3 col = mix(uColor, uEdgeColor, brightEdge * 0.85);
  col += uHaloColor * 0.30 * halo;
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
}

export interface OutfitLayerHandle extends LayerHandle {
  setSpec(spec: OutfitSpec | undefined): void;
}

/** Valores finales de la prenda; en producción se usan siempre estos. */
const OUTFIT_TUNING = {
  solid: 0,
  fill: 0.22,
  alpha: 0.5,
  edge: 0.85,
  offset: 1.1,
  shirtColor: "#aeb9c3",
  pantsColor: "#66737f",
};

/** Azul de línea del cuerpo, en luz lineal (CHIMERA_LOOK.line). */
const HALO_LINEAR = new THREE.Vector3(0.06, 0.36, 0.68);
/** Borde luminoso de la prenda, en luz lineal (#d0d8df). */
const EDGE_LINEAR = hexToLinear("#d0d8df");

/**
 * Solo en desarrollo. Los colores se aceptan con o sin `#` y con seis dígitos hexadecimales;
 * cualquier valor inválido cae al color por defecto de esa prenda.
 */
function devTuning(): typeof OUTFIT_TUNING {
  if (!import.meta.env.DEV || typeof window === "undefined") return OUTFIT_TUNING;
  const params = new URLSearchParams(window.location.search);
  const read = (key: string, fallback: number, min: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
  };
  const readHex = (key: string, fallback: string) => {
    const raw = params.get(key)?.replace(/^#/, "");
    return raw && /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw.toLowerCase()}` : fallback;
  };
  return {
    solid: read("clothSolid", OUTFIT_TUNING.solid, 0, 1),
    fill: read("clothFill", OUTFIT_TUNING.fill, 0, 1),
    alpha: read("clothAlpha", OUTFIT_TUNING.alpha, 0, 1),
    edge: read("clothEdge", OUTFIT_TUNING.edge, 0, 1),
    offset: read("clothOffset", OUTFIT_TUNING.offset, 0, 4),
    shirtColor: readHex("shirtColor", OUTFIT_TUNING.shirtColor),
    pantsColor: readHex("pantsColor", OUTFIT_TUNING.pantsColor),
  };
}

const TUNING = devTuning();

type Garment = "shirt" | "pants";
type Pass = "depth" | "solid" | "glass";

function makeMaterial(garment: Garment, pass: Pass, color: string): THREE.ShaderMaterial {
  const isDepth = pass === "depth";
  const isSolid = pass === "solid";
  return new THREE.ShaderMaterial({
    vertexShader: OUTFIT_VERT,
    fragmentShader: isDepth ? OUTFIT_DEPTH_FRAG : isSolid ? OUTFIT_SOLID_FRAG : OUTFIT_GLASS_FRAG,
    uniforms: {
      uColor: { value: hexToLinear(color) },
      uEdgeColor: { value: EDGE_LINEAR.clone() },
      uHaloColor: { value: HALO_LINEAR.clone() },
      uAlpha: { value: TUNING.alpha },
      uFill: { value: TUNING.fill },
      uEdgeAlpha: { value: TUNING.edge },
      uSolid: { value: TUNING.solid },
      uBack: { value: 0 },
      uDetail: { value: 0.5 },
      uSeed: { value: 0 },
      uGarment: { value: garment === "shirt" ? 0 : 1 },
      uPx: { value: 1.4 },
      uOffset: { value: TUNING.offset },
    },
    transparent: pass === "glass",
    side: THREE.FrontSide,
    colorWrite: !isDepth,
    depthWrite: isDepth || isSolid,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    // El prepass se aparta un pelo del pase visible para no pelear con el mate; el vidrio no
    // escribe profundidad y con LessEqual dibuja sobre la misma superficie sin z-fighting.
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
  // Prepass antes del cuerpo (-3/-2); mate antes que el trazo; vidrio y líneas después del cuerpo.
  const orders = { depth: -7, solid: -5, glass: 1 };

  for (const garment of ["shirt", "pants"] as const) {
    const color = spec?.color ?? (garment === "shirt" ? TUNING.shirtColor : TUNING.pantsColor);
    const depth = makeMaterial(garment, "depth", color);
    const solid = makeMaterial(garment, "solid", color);
    const glass = makeMaterial(garment, "glass", color);
    materials.push(depth, solid, glass);
    const depthMesh = makeLayerMesh(parent, geometry, depth, orders.depth);
    const solidMesh = makeLayerMesh(parent, geometry, solid, orders.solid);
    const glassMesh = makeLayerMesh(parent, geometry, glass, orders.glass);
    meshes.push(depthMesh, solidMesh, glassMesh);
    solidMeshes.push(solidMesh);
  }

  const base = layerHandle(parent, meshes, materials);
  let visible = false;
  let useSolid = false;

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
    // El mate solo se monta cuando se pide; el prepass y el vidrio están siempre activos.
    for (const m of solidMeshes) m.visible = visible && useSolid;
  };
  apply(spec);

  return {
    ...base,
    setVisible(v: boolean) {
      visible = v;
      base.setVisible(v);
      for (const m of solidMeshes) m.visible = v && useSolid;
    },
    setSpec: apply,
  };
}
