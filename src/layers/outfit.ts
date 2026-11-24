/**
 * Capa de ropa sobre el cuerpo base: remera gris de manga corta + pantalón largo.
 *
 * No es un campo de hebras: es una "segunda piel" dibujada con el mismo lenguaje que la cabeza y
 * el cuerpo (silueta fina + pocas curvas verticales + bordes de prenda), desplazada 0.8–1.5 cm
 * a lo largo de la normal. La malla es la del rig: `position` y `normal` ya vienen posadas cada
 * frame, y el recorte usa `aRest`, así que la ropa sigue `body.turn` y los gestos sin deslizarse.
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
varying vec3 vRest;
void main() {
  vec3 p = position + normal * uOffset;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  vRest = aRest;
  gl_Position = projectionMatrix * mv;
}
`;

const OUTFIT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uBack;
uniform float uDetail;
uniform float uSeed;
uniform float uGarment; // 0 = remera, 1 = pantalón
varying vec3 vN;
varying vec3 vV;
varying vec3 vRest;

${LAYER_UTILS_GLSL}
${CLOTH_REGION_GLSL}

void main() {
  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));
  float shirt = clothShirtMask(vRest);
  float pants = clothPantsMask(vRest);
  float mask = uGarment < 0.5 ? shirt : pants;

  // Silueta de la prenda: el mismo borde nítido y halo tenue del cuerpo base.
  float outline = 1.0 - smoothstep(0.07, 0.24, facing);
  float halo = pow(1.0 - facing, 2.6);

  // Bordes: solo donde el recorte cruza su umbral (cuello, puños, cintura/dobladillo, tobillo).
  float edge = 0.0;
  if (uGarment < 0.5) {
    float neckline = lineAt(vRest.y - clothNeckY(vRest)) * smoothstep(50.0, 56.0, vRest.y);
    float hem = lineAt(vRest.y - CLOTH_HIP_Y) * (1.0 - smoothstep(17.0, 20.0, abs(vRest.z)));
    float cuff = lineAt(abs(vRest.z) - CLOTH_SLEEVE_Z)
               * smoothstep(20.0, 32.0, vRest.y) * (1.0 - smoothstep(50.0, 58.0, vRest.y));
    edge = max(max(neckline, hem), cuff);
  } else {
    float waist = lineAt(vRest.y - CLOTH_WAIST_Y) * (1.0 - smoothstep(21.0, 25.0, abs(vRest.z)));
    float ankle = lineAt(vRest.y - CLOTH_ANKLE_Y) * (1.0 - smoothstep(26.0, 30.0, abs(vRest.z)));
    edge = max(waist, ankle);
  }
  edge *= smoothstep(0.08, 0.4, mask);

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
  float wEdge = edge * 0.9;
  float wCurve = curves * tCurve * 0.42;
  float wSeam = seam * tSeam * 0.5;
  float wFold = folds * tFold * 0.22;
  float w = wOut + wEdge + wCurve + wSeam + wFold;

  vec3 col = layerEncode(uColor * (0.75 + 0.45 * wEdge + 0.2 * wCurve));
  float alpha = uAlpha * mask * w * (uBack > 0.5 ? 0.32 : 1.0);
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

function makeMaterial(garment: "shirt" | "pants", spec: OutfitSpec, back = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: OUTFIT_VERT,
    fragmentShader: OUTFIT_FRAG,
    uniforms: {
      uColor: { value: hexToLinear(spec.color ?? "#9aa4ad") },
      uAlpha: { value: 0.5 }, // más tenue que la cabeza (0.9) y que el cuerpo (0.7)
      uBack: { value: back ? 1 : 0 },
      uDetail: { value: spec.detail ?? 0.5 },
      uSeed: { value: spec.seed ?? 0 },
      uGarment: { value: garment === "shirt" ? 0 : 1 },
      uPx: { value: 1.4 },
      uOffset: { value: 1.1 }, // cm a lo largo de la normal: segunda piel, no volumen nuevo
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
