/**
 * Capa de ropa sobre el cuerpo base: remera y pantalón como MATERIA, no como vidrio.
 *
 * El cuerpo y la cabeza son luz (holograma de línea fina); la tela es una superficie mate que
 * tapa lo que hay debajo solo en la sección cubierta. Para eso se dibuja en dos pases:
 *   1) relleno opaco (depthWrite), que oculta al cuerpo holográfico sin tocar su shader;
 *   2) líneas transparentes (sin depthWrite, 0,05 cm por encima) para bordes, curvas y costuras.
 *
 * El recorte sigue anclado a `aRest` y usa las mismas regiones que el cuerpo; la malla es la del
 * rig, así que la ropa sigue `body.turn` y los gestos sin deslizarse.
 *
 * En desarrollo se pueden ajustar los valores sin recompilar:
 *   ?clothSolid=1&clothFill=0.18&clothAlpha=0.5&clothEdge=0.8&clothOffset=1.1
 *   &shirtColor=6c737a&pantsColor=3c4249
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

/** Preludio compartido por los dos pases: uniforms, regiones y cobertura extendida. */
const OUTFIT_COMMON = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uEdgeColor;
uniform vec3 uHaloColor;
uniform float uAlpha;     // trazo (silueta, curvas, costuras)
uniform float uFill;      // relleno del estilo vidrio; 0 lo apaga
uniform float uEdgeAlpha; // bordes de prenda, claros sobre la tela
uniform float uSolid;     // 0 = vidrio translúcido, 1 = mate opaco
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

// Cobertura de render, sin tocar los umbrales compartidos: rellena la entrepierna (el hueco
// tipo calzoncillo) y el costado de la axila / cadera donde la silueta se quedaba corta.
float outfitCoverageOut(vec3 r) {
  if (uGarment < 0.5) {
    float top = 1.0 - smoothstep(clothNeckY(r) - CLOTH_FEATHER, clothNeckY(r) + CLOTH_FEATHER, r.y);
    float hem = smoothstep(CLOTH_HIP_Y - CLOTH_FEATHER, CLOTH_HIP_Y + CLOTH_FEATHER, r.y);
    float guard = 1.0 - smoothstep(62.0, 65.0, r.y);
    float side = (1.0 - smoothstep(CLOTH_TORSO_Z + 1.0, CLOTH_TORSO_Z + 4.0, abs(r.z))) * top * hem * guard;
    return max(clothShirtMask(r), side);
  }
  float top = 1.0 - smoothstep(CLOTH_WAIST_Y - CLOTH_FEATHER, CLOTH_WAIST_Y + CLOTH_FEATHER, r.y);
  float hem = smoothstep(CLOTH_ANKLE_Y - CLOTH_FEATHER, CLOTH_ANKLE_Y + CLOTH_FEATHER, r.y);
  float width = 23.0 - 2.5 * smoothstep(CLOTH_ANKLE_Y, CLOTH_WAIST_Y, r.y);
  float outer = 1.0 - smoothstep(width - CLOTH_FEATHER, width + CLOTH_FEATHER, abs(r.z));
  // Sin la hendidura interior: deltoides de pierna arriba, se abre hacia media pierna.
  float bridge = smoothstep(-34.0, -18.0, r.y);
  return max(clothPantsMask(r), top * hem * outer * bridge);
}
`;

/** Pase 1: superficie mate opaca. Con uSolid = 0 no dibuja nada y deja paso al vidrio. */
const OUTFIT_FILL_FRAG = /* glsl */ `
${OUTFIT_COMMON}

void main() {
  float mask = outfitCoverageOut(vRest);
  if (mask < 0.5 || uSolid < 0.01) discard;

  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));
  vec3 lightDir = normalize(vec3(-0.4, 0.6, 0.7)); // fijo en espacio de vista
  float diffuse = max(dot(n, lightDir), 0.0);
  float fresnel = pow(1.0 - facing, 2.2);
  float shade = 0.35 + 0.5 * diffuse + 0.12 * fresnel;
  vec3 matte = uColor * shade;
  // Halo azul muy tenue en la silueta: mismo azul de línea del cuerpo, intensidad 0.25.
  matte += uHaloColor * 0.25 * pow(1.0 - facing, 4.0);
  matte *= uBack > 0.5 ? 0.75 : 1.0;
  gl_FragColor = vec4(layerEncode(matte), 1.0);
}
`;

/** Pase 2: trazo transparente sobre la tela; con uSolid = 0 recupera el relleno de vidrio. */
const OUTFIT_LINE_FRAG = /* glsl */ `
${OUTFIT_COMMON}

void main() {
  float mask = outfitCoverageOut(vRest);
  if (mask < 0.02) discard;

  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));
  float outline = 1.0 - smoothstep(0.07, 0.24, facing);
  float halo = pow(1.0 - facing, 2.6);

  // Bordes reales de la prenda: cuello, manga, dobladillo de la remera y tobillo del pantalón.
  // La cintura ya no se dibuja: con tela opaca parecía un cinturón.
  float brightEdge = 0.0;
  if (uGarment < 0.5) {
    // El escote ya curva por clothNeckY (más bajo adelante); no lo subimos hacia la mandíbula.
    float neckline = lineAt(vRest.y - clothNeckY(vRest))
                   * smoothstep(50.0, 56.0, vRest.y);
    float hem = lineAt(vRest.y - clothCurvedY(vRest, vLocalN, CLOTH_HIP_Y))
              * (1.0 - smoothstep(17.0, 20.0, abs(vRest.z)));
    float cuff = lineAt(abs(vRest.z) - CLOTH_SLEEVE_Z)
               * smoothstep(20.0, 32.0, vRest.y) * (1.0 - smoothstep(50.0, 58.0, vRest.y));
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

  float glassAlpha = uFill * mask * (0.4 + 0.6 * halo) * (1.0 - uSolid);
  float lineAlpha = uAlpha * mask * (outline * 0.85 + halo * 0.12
                  + curves * tCurve * 0.42 + seam * tSeam * 0.5 + folds * tFold * 0.22);
  float edgeAlpha = uEdgeAlpha * brightEdge;
  float backFactor = uBack > 0.5 ? 0.32 : 1.0;
  float alpha = clamp((glassAlpha + lineAlpha + edgeAlpha) * backFactor, 0.0, 1.0);
  if (alpha < 0.006) discard;

  vec3 lineCol = mix(uColor * 1.5, uEdgeColor, brightEdge);
  lineCol += uHaloColor * 0.08 * halo;
  gl_FragColor = vec4(layerEncode(lineCol), alpha);
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
  solid: 1,
  fill: 0.18,
  alpha: 0.5,
  edge: 0.8,
  offset: 1.1,
  shirtColor: "#6c737a",
  pantsColor: "#3c4249",
};

/** Azul de línea del cuerpo, en luz lineal (CHIMERA_LOOK.line). */
const HALO_LINEAR = new THREE.Vector3(0.06, 0.36, 0.68);
/** Blanco cálido de los bordes de prenda, en luz lineal (#b8c0c8). */
const EDGE_LINEAR = hexToLinear("#b8c0c8");

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
type Pass = "fill" | "line";

function makeMaterial(
  garment: Garment,
  pass: Pass,
  color: string,
  back: boolean
): THREE.ShaderMaterial {
  const solidFill = pass === "fill";
  return new THREE.ShaderMaterial({
    vertexShader: OUTFIT_VERT,
    fragmentShader: solidFill ? OUTFIT_FILL_FRAG : OUTFIT_LINE_FRAG,
    uniforms: {
      uColor: { value: hexToLinear(color) },
      uEdgeColor: { value: EDGE_LINEAR.clone() },
      uHaloColor: { value: HALO_LINEAR.clone() },
      uAlpha: { value: TUNING.alpha },
      uFill: { value: TUNING.fill },
      uEdgeAlpha: { value: TUNING.edge },
      uSolid: { value: TUNING.solid },
      uBack: { value: back ? 1 : 0 },
      uDetail: { value: 0.5 },
      uSeed: { value: 0 },
      uGarment: { value: garment === "shirt" ? 0 : 1 },
      uPx: { value: 1.4 },
      // Las líneas van 0,05 cm por encima de la tela para no pelear con su depth.
      uOffset: { value: TUNING.offset + (solidFill ? 0 : 0.05) },
    },
    transparent: !solidFill,
    side: back ? THREE.BackSide : THREE.FrontSide,
    depthWrite: solidFill,
    depthTest: true,
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
  // El relleno entra en el pase opaco (antes que el cuerpo transparente) y escribe profundidad;
  // las líneas van después del cuerpo holográfico para dibujar sobre la tela.
  const orders = { fillBack: -6, fillFront: -5, lineBack: 1, lineFront: 2 };

  for (const garment of ["shirt", "pants"] as const) {
    const color = (spec?.color ?? (garment === "shirt" ? TUNING.shirtColor : TUNING.pantsColor));
    const fillBack = makeMaterial(garment, "fill", color, true);
    const fillFront = makeMaterial(garment, "fill", color, false);
    const lineBack = makeMaterial(garment, "line", color, true);
    const lineFront = makeMaterial(garment, "line", color, false);
    materials.push(fillBack, fillFront, lineBack, lineFront);
    meshes.push(
      makeLayerMesh(parent, geometry, fillBack, orders.fillBack),
      makeLayerMesh(parent, geometry, fillFront, orders.fillFront),
      makeLayerMesh(parent, geometry, lineBack, orders.lineBack),
      makeLayerMesh(parent, geometry, lineFront, orders.lineFront)
    );
  }

  const base = layerHandle(parent, meshes, materials);

  const apply = (s: OutfitSpec | undefined) => {
    const detail = THREE.MathUtils.clamp(s?.detail ?? 0.5, 0, 1);
    const seed = s?.seed ?? 0;
    for (const m of materials) {
      const garment = m.uniforms.uGarment.value as number;
      const color = s?.color ?? (garment < 0.5 ? TUNING.shirtColor : TUNING.pantsColor);
      m.uniforms.uColor.value.copy(hexToLinear(color));
      m.uniforms.uDetail.value = detail;
      m.uniforms.uSeed.value = seed;
    }
    base.setVisible(!!s && s.enabled !== false);
  };
  apply(spec);

  return { ...base, setSpec: apply };
}
