/**
 * Capa de ropa sobre el cuerpo base: remera gris de manga corta + pantalón largo.
 *
 * No es un campo de hebras: es una "segunda piel" con relleno gris translúcido (uFill, más fuerte
 * hacia el fresnel) y el mismo trazo fino que la cabeza y el cuerpo. Desplazada 0.8–1.5 cm a lo
 * largo de la normal. La malla es la del rig: `position` y `normal` ya vienen posadas cada frame,
 * y el recorte usa `aRest`, así que la ropa sigue `body.turn` y los gestos sin deslizarse.
 *
 * En desarrollo se pueden ajustar los cuatro valores sin recompilar:
 *   ?clothFill=0.18&clothAlpha=0.5&clothEdge=0.8&clothOffset=1.1
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

const OUTFIT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;     // trazo (silueta, curvas, costuras)
uniform float uFill;      // alpha base del relleno gris; 0 lo apaga
uniform float uEdgeAlpha; // bordes de prenda, más brillantes que el relleno
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

// El borde no es un anillo recto en y = const: sigue la sección (flancos más altos) y la
// inclinación real de la superficie (normal en espacio del objeto, anclada al pose del rig).
float clothCurvedY(vec3 r, vec3 nObj, float baseY) {
  float flank = pow(clamp(abs(r.z) / 17.0, 0.0, 1.0), 1.7);
  // Amplitud acotada al feather del recorte (1,6 cm): la curva se lee pero no se sale de la tela.
  return baseY + 0.8 * flank + 0.4 * clamp(nObj.y, -1.0, 1.0);
}

void main() {
  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));
  float shirt = clothShirtMask(vRest);
  float pants = clothPantsMask(vRest);
  float mask = uGarment < 0.5 ? shirt : pants;

  // Silueta de la prenda: el mismo borde nítido y halo tenue del cuerpo base.
  float outline = 1.0 - smoothstep(0.07, 0.24, facing);
  float halo = pow(1.0 - facing, 2.6);

  // Bordes reales de la prenda (brillantes) vs. la cintura (un tercio, para que no parezca un
  // anillo). Todos siguen la sección del cuerpo en lugar de ser rectas en y = const.
  float brightEdge = 0.0;
  float waistEdge = 0.0;
  if (uGarment < 0.5) {
    // El escote ya curva por clothNeckY (más bajo adelante); no lo subimos hacia el guard.
    float neckline = lineAt(vRest.y - clothNeckY(vRest))
                   * smoothstep(50.0, 56.0, vRest.y);
    float hem = lineAt(vRest.y - clothCurvedY(vRest, vLocalN, CLOTH_HIP_Y))
              * (1.0 - smoothstep(17.0, 20.0, abs(vRest.z)));
    float cuff = lineAt(abs(vRest.z) - CLOTH_SLEEVE_Z)
               * smoothstep(20.0, 32.0, vRest.y) * (1.0 - smoothstep(50.0, 58.0, vRest.y));
    brightEdge = max(max(neckline, hem), cuff);
  } else {
    waistEdge = lineAt(vRest.y - clothCurvedY(vRest, vLocalN, CLOTH_WAIST_Y))
              * (1.0 - smoothstep(21.0, 25.0, abs(vRest.z)))
              * smoothstep(0.2, 0.7, abs(vLocalN.z)); // solo flancos: no cruza el pecho
    float ankle = lineAt(vRest.y - clothCurvedY(vRest, vLocalN, CLOTH_ANKLE_Y))
                * (1.0 - smoothstep(26.0, 30.0, abs(vRest.z)));
    brightEdge = ankle;
  }
  brightEdge *= smoothstep(0.08, 0.4, mask);
  waistEdge *= smoothstep(0.08, 0.4, mask);

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

  float wOut = outline * 0.85 + halo * 0.12;
  float wCurve = curves * tCurve * 0.42;
  float wSeam = seam * tSeam * 0.5;
  float wFold = folds * tFold * 0.22;
  // La cintura se lee a un tercio: el dobladillo real de la remera y el del pantalón sí brillan.
  float edged = brightEdge + waistEdge / 3.0;

  vec3 col = layerEncode(uColor * (0.75 + 0.45 * edged + 0.2 * wCurve));
  // Relleno gris translúcido solo en la tela; el fresnel (halo) lo refuerza hacia el borde.
  // Con uFill = 0 desaparece y queda únicamente el trazo.
  float fillAlpha = uFill * mask * (0.4 + 0.6 * halo);
  float lineAlpha = uAlpha * mask * (wOut + wCurve + wSeam + wFold);
  float edgeAlpha = uEdgeAlpha * edged; // ya ponderado por mask en el cálculo del borde
  float backFactor = uBack > 0.5 ? 0.32 : 1.0;
  float alpha = clamp((fillAlpha + lineAlpha + edgeAlpha) * backFactor, 0.0, 1.0);
  if (alpha < 0.006) discard;
  gl_FragColor = vec4(col, alpha);
}
`;

export interface OutfitSpec {
  /** `tee-pants` es la única variante de este mensaje. */
  variant?: "tee-pants";
  enabled?: boolean;
  color?: string;
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
  fill: 0.18,
  alpha: 0.5,
  edge: 0.8,
  offset: 1.1,
};

/**
 * Solo en desarrollo: ?clothFill=0.18&clothAlpha=0.5&clothEdge=0.8&clothOffset=1.1
 * Permite ajustar los cuatro uniforms sin recompilar. Fuera de DEV (o sin `window`) se ignoran
 * los parámetros y quedan los valores finales.
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
  return {
    fill: read("clothFill", OUTFIT_TUNING.fill, 0, 1),
    alpha: read("clothAlpha", OUTFIT_TUNING.alpha, 0, 1),
    edge: read("clothEdge", OUTFIT_TUNING.edge, 0, 1),
    offset: read("clothOffset", OUTFIT_TUNING.offset, 0, 4),
  };
}

const TUNING = devTuning();

function makeMaterial(garment: "shirt" | "pants", spec: OutfitSpec, back = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: OUTFIT_VERT,
    fragmentShader: OUTFIT_FRAG,
    uniforms: {
      uColor: { value: hexToLinear(spec.color ?? "#9aa4ad") },
      uAlpha: { value: TUNING.alpha }, // trazo: más tenue que la cabeza (0.9) y que el cuerpo (0.7)
      uFill: { value: TUNING.fill }, // relleno gris translúcido (0 lo apaga)
      uEdgeAlpha: { value: TUNING.edge }, // bordes reales de la prenda
      uBack: { value: back ? 1 : 0 },
      uDetail: { value: spec.detail ?? 0.5 },
      uSeed: { value: spec.seed ?? 0 },
      uGarment: { value: garment === "shirt" ? 0 : 1 },
      uPx: { value: 1.4 },
      uOffset: { value: TUNING.offset }, // cm a lo largo de la normal: segunda piel, no volumen nuevo
    },
    transparent: true,
    side: back ? THREE.BackSide : THREE.FrontSide,
    depthWrite: false,
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
  const shirtMat = makeMaterial("shirt", spec ?? {});
  const pantsMat = makeMaterial("pants", spec ?? {});
  const meshes = [
    makeLayerMesh(parent, geometry, shirtMat, 1), // después del cuerpo (-3, -2)
    makeLayerMesh(parent, geometry, pantsMat, 1),
  ];
  const backShirtMat = makeMaterial("shirt", spec ?? {}, true);
  const backPantsMat = makeMaterial("pants", spec ?? {}, true);
  const backMeshes = [
    makeLayerMesh(parent, geometry, backShirtMat, 0),
    makeLayerMesh(parent, geometry, backPantsMat, 0),
  ];
  const all = [...meshes, ...backMeshes];
  const materials = [shirtMat, pantsMat, backShirtMat, backPantsMat];
  const base = layerHandle(parent, all, materials);

  const apply = (s: OutfitSpec | undefined) => {
    const color = hexToLinear(s?.color ?? "#9aa4ad");
    const detail = THREE.MathUtils.clamp(s?.detail ?? 0.5, 0, 1);
    const seed = s?.seed ?? 0;
    for (const m of materials) {
      m.uniforms.uColor.value.copy(color);
      m.uniforms.uDetail.value = detail;
      m.uniforms.uSeed.value = seed;
    }
    base.setVisible(!!s && s.enabled !== false);
  };
  apply(spec);

  return { ...base, setSpec: apply };
}
