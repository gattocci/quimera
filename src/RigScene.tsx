/**
 * RigScene — Renders CHIMERA performers in a shared Three.js scene with interactive OrbitControls.
 *
 * Capabilities:
 *  - 1 or 2 performers with individual body rigs, voices, and 3D heads.
 *  - Body style modes:
 *      * "vocal" (default): a quiet "ghost" body in CHIMERA's blue — a faint silhouette outline plus
 *        a few sparse vertical contour curves (a bright warm midline, like the cut through the head)
 *        so it reads when the camera orbits. No grid, no fill, no rings; cut at the neck rim so the
 *        face stays clean. It is the base layer: a gray tee + pants (Character.layers.outfit) sits
 *        on top; hair is reserved for the next stage.
 *      * "head-only": pure CHIMERA standalone head, no body at all (advanced scenes).
 *   Legacy body styles are normalized to "vocal" by validateScene() and render as "vocal" here.
 *  - The approved presentation is head look "vocal": the CHIMERA anatomical head with its lips
 *    driven by the voice's articulators, not a generic viseme animation.
 *  - Interactive 3D camera (OrbitControls): rotate, zoom, and pan around the performers.
 *  - Emotion & intention transitions (curious, emphatic, thoughtful, agreement, etc.).
 *  - Interlocutor gaze tracking: listeners turn toward speakers.
 *  - Live articulatory lip-sync + telemetry for the active speaker.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { TelemetryMessage } from "@chimera/wasm/../../src/worklet/protocol.ts";
import { engine } from "@chimera/audio/AudioEngine.ts";
import { useStore } from "@chimera/ui/store.ts";
import type { BodyStyle, Character, PostureHint } from "./scene.ts";
import { POSTURE_PRESETS, listeningPose, lerpPose, clonePose } from "./poses.ts";
import { CLOTH_REGION_GLSL, type LayerHandle } from "./layers/common.ts";
import { createOutfitLayer, type OutfitLayerHandle, type OutfitSpec } from "./layers/outfit.ts";
import { createHairLayer, type HairSpec } from "./layers/hair.ts";
import type { Pose } from "@chimera/rig/pose.ts";

export type HeadLookName = "classic" | "vocal" | "skinned" | "outside";

export interface RigSceneHandle {
  resetCamera: () => void;
}

export interface RigSceneProps {
  characters: Character[];
  activeCharacterId: string | null;
  activePosture?: PostureHint;
  speaking: boolean;
  headLook?: HeadLookName;
  bodyStyle?: BodyStyle;
  className?: string;
}

interface PerformerInstance {
  id: string;
  group: THREE.Group;
  rig: any;
  model: any;
  head: any;
  view: any;
  vocalMat: THREE.ShaderMaterial;
  vocalBackMat: THREE.ShaderMaterial;
  outfit: OutfitLayerHandle;
  hair: LayerHandle;
  outfitSpec?: OutfitSpec;
  hairEnabled: boolean;
  layerSignature: string;
  styleVisible: boolean;
  skinned: Float32Array;
  currentPose: Pose;
  targetPose: Pose;
  baseTurn: number;
}

// ──────────────────────────────────────── Vocal body shader ───────────────────

/**
 * Cuerpo base "fantasma" con el lenguaje de la cabeza en `vocal`.
 *
 * La cabeza es un *corte*: un contorno nítido por la línea media, pocos elementos brillantes y
 * mucho negro alrededor. El cuerpo habla el mismo idioma con tres cosas y nada más:
 *   1. silueta: contorno fino del borde (fresnel), sin relleno;
 *   2. línea media del torso: la más clara, con el acento rosa/rojo solo en el pecho;
 *   3. pocas curvas verticales de contorno (cortes perpendiculares a x y a z) que dan volumen y se
 *      leen al orbitar. Son verticales a propósito: los anillos horizontales ya se rechazaron.
 *
 * Los cortes se miden en coordenadas de reposo del rig (atributo `aRest`), no en la malla skinneada:
 * `position` ya está posada, y en ella el plano elegido se desplaza con `body.turn` y los gestos.
 * El eje x del rig es delantero-posterior y el z es lateral: la línea media (el corte por el
 * entrecejo de la cabeza) es z = 0, no x = 0. Con x = 0 el rojo caía en los flancos del torso,
 * donde brazos y antebrazos también tienen x ≈ 0. La línea media y su acento usan z = 0 y se acotan
 * a la profundidad del torso (|x| < uTorsoDepth), lejos de manos y antebrazos adelantados.
 *
 * Las líneas se miden en píxeles de pantalla (fwidth), así que mantienen el mismo grosor fino con
 * cualquier zoom y no forman manchas donde la superficie es tangente al plano de corte.
 *
 * La piel facial vive en esta misma malla por encima del cuello (y ≈ 67 cm): el dibujo se corta
 * ahí y la cara queda limpia. Es la capa base: la ropa se dibuja encima como segunda piel y el
 * pelo queda para el siguiente hito.
 */
const VOCAL_VERT = /* glsl */ `
attribute vec3 aRest;
varying vec3 vN;
varying vec3 vV;
varying vec3 vRest;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  vRest = aRest;
  gl_Position = projectionMatrix * mv;
}
`;

const VOCAL_FRAG = /* glsl */ `
uniform vec3 uLine;
uniform vec3 uEdge;
uniform vec3 uWarm;
uniform float uAlpha;
uniform float uFadeBottom;
uniform float uFadeTop;
uniform float uHeadCutBottom;
uniform float uHeadCutTop;
uniform float uBack;
uniform float uStepX;
uniform float uStepZ;
uniform float uPx;
uniform float uTorsoDepth;
uniform float uClothMask; // baja el alpha del cuerpo donde hay prenda (0 si no hay ropa)
varying vec3 vN;
varying vec3 vV;
varying vec3 vRest;

${CLOTH_REGION_GLSL}

// Línea de grosor constante en píxeles sobre el corte c = k·step.
float slice(float c, float step) {
  float d = abs(fract(c / step + 0.5) - 0.5) * step;
  float aa = max(fwidth(c), 1e-5);
  float t = d / aa;
  return 1.0 - smoothstep(uPx * 0.5, uPx * 0.5 + 1.6, t);
}

void main() {
  vec3 n = normalize(vN), v = normalize(vV);
  float facing = abs(dot(n, v));

  // 1) silueta: borde fino y nítido + un halo muy suave
  float outline = 1.0 - smoothstep(0.07, 0.24, facing);
  float halo = pow(1.0 - facing, 2.6);

  // 2) línea media del torso: plano z = 0 (sagital), anclado al reposo del rig.
  float aaMid = max(fwidth(vRest.z), 1e-5);
  float mid = (1.0 - smoothstep(uPx * 0.5, uPx * 0.5 + 1.6, abs(vRest.z) / aaMid))
            * (1.0 - smoothstep(uTorsoDepth - 2.0, uTorsoDepth, abs(vRest.x)));

  // 3) pocas curvas verticales: cortes en x y en z, sin repetir la línea media (z = 0)
  float notMid = smoothstep(uStepZ * 0.25, uStepZ * 0.5, abs(vRest.z));
  float cuts = max(slice(vRest.x, uStepX), slice(vRest.z, uStepZ) * notMid);

  // acento rosa/rojo solo en el pecho, guiño a los órganos internos de la cabeza
  float chest = smoothstep(18.0, 38.0, vRest.y) * (1.0 - smoothstep(48.0, 64.0, vRest.y));
  vec3 midColor = mix(uLine, uWarm, chest);

  float wMid = mid * (0.7 + 0.3 * facing);
  float wCut = cuts * 0.4 * (0.5 + 0.5 * facing);
  float wOut = outline * 0.9 + halo * 0.2;

  vec3 col = uEdge * 1.2 * halo + uLine * (wCut + outline * 0.9) * 1.3 + midColor * wMid * 2.0;
  col = max(col, 0.0);
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));

  float fade = smoothstep(uFadeBottom, uFadeTop, vRest.y);
  float headCut = 1.0 - smoothstep(uHeadCutBottom, uHeadCutTop, vRest.y);
  float a = max(max(wMid, wCut), wOut);
  // La ropa dibuja su propia silueta encima: atenuamos el cuerpo bajo la tela para no duplicar líneas.
  float bare = 1.0 - uClothMask * outfitCoverage(vRest);
  float alpha = uAlpha * fade * headCut * a * bare * (uBack > 0.5 ? 0.35 : 1.0);
  if (alpha < 0.008) discard;
  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * `RigView` rellena `position` con los vértices skinneados de cada frame. Copiamos las posiciones
 * de reposo del rig a un atributo estático, con el mismo orden de esquinas que usa el view:
 * los seis vértices de cada quad siguen [0,1,2,0,2,3] sobre `rig.quads`.
 */
function addRestAttribute(rig: any, view: any): void {
  const geometry = (view.group.children[1] as THREE.Mesh).geometry as THREE.BufferGeometry;
  const cornerCount = geometry.getAttribute("position").count;
  const rest = new Float32Array(3 * cornerCount);
  const order = [0, 1, 2, 0, 2, 3];
  for (let f = 0; f < rig.nq; f++) {
    for (let j = 0; j < 6; j++) {
      const vertex = rig.quads[4 * f + order[j]];
      const to = 3 * (6 * f + j), from = 3 * vertex;
      rest[to] = rig.rest[from];
      rest[to + 1] = rig.rest[from + 1];
      rest[to + 2] = rig.rest[from + 2];
    }
  }
  geometry.setAttribute("aRest", new THREE.BufferAttribute(rest, 3));
}

function createVocalBodyMaterial(back = false) {
  // CHIMERA_LOOK de src/rig/view.ts: los mismos valores de línea y borde que ve la cabeza.
  return new THREE.ShaderMaterial({
    vertexShader: VOCAL_VERT,
    fragmentShader: VOCAL_FRAG,
    uniforms: {
      uLine: { value: new THREE.Vector3(0.06, 0.36, 0.68) },
      uEdge: { value: new THREE.Vector3(0.03, 0.2, 0.45) },
      uWarm: { value: new THREE.Vector3(0.9, 0.22, 0.34) },
      uAlpha: { value: 0.7 },
      uFadeBottom: { value: -90 },
      uFadeTop: { value: -45 }, // los pies se desvanecen suavemente
      uHeadCutBottom: { value: 64 },
      uHeadCutTop: { value: 70 },
      uBack: { value: back ? 1 : 0 },
      uStepX: { value: 18 }, // cm entre cortes perpendiculares a x (delantero-posterior)
      uStepZ: { value: 26 }, // cm entre cortes perpendiculares a z (laterales)
      uPx: { value: 1.4 }, // grosor de línea en píxeles
      uTorsoDepth: { value: 13 }, // cm: semiprofundidad del torso; fuera, la línea media se apaga
      uClothMask: { value: 0 }, // lo activa syncLayers() cuando el personaje lleva ropa
    },
    transparent: true,
    side: back ? THREE.BackSide : THREE.FrontSide,
    depthWrite: false,
  });
}

// ────────────────────────────────────────────── Component ─────────────────────

export const RigScene = forwardRef<RigSceneHandle, RigSceneProps>(function RigScene(
  {
    characters,
    activeCharacterId,
    activePosture = "attentive",
    speaking,
    headLook = "vocal",
    bodyStyle = "vocal",
    className,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resetCameraRef = useRef<(() => void) | null>(null);

  useImperativeHandle(ref, () => ({
    resetCamera: () => {
      resetCameraRef.current?.();
    },
  }));

  // Live refs for animation loop
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const activeCharRef = useRef(activeCharacterId);
  activeCharRef.current = activeCharacterId;
  const activePostureRef = useRef(activePosture);
  activePostureRef.current = activePosture;
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const headLookRef = useRef(headLook);
  headLookRef.current = headLook;
  const bodyStyleRef = useRef(bodyStyle);
  bodyStyleRef.current = bodyStyle;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let performers: PerformerInstance[] = [];
    let animId = 0;

    // Las capas solo se montan una vez por personaje; aquí se actualizan sus uniforms al editarlas.
    const layerSignature = (ch: Character) => JSON.stringify(ch.layers ?? {});
    const syncLayerVisibility = (p: PerformerInstance) => {
      const dressed = p.styleVisible && !!p.outfitSpec && p.outfitSpec.enabled !== false;
      p.outfit.setVisible(dressed);
      p.hair.setVisible(p.styleVisible && p.hairEnabled);
      p.vocalMat.uniforms.uClothMask.value = dressed ? 0.85 : 0;
      p.vocalBackMat.uniforms.uClothMask.value = dressed ? 0.6 : 0;
    };
    const syncLayers = (p: PerformerInstance, ch: Character) => {
      const signature = layerSignature(ch);
      if (signature === p.layerSignature) return;
      p.layerSignature = signature;
      p.outfitSpec = ch.layers?.outfit;
      p.hairEnabled = !!ch.layers?.hair && ch.layers.hair.enabled !== false;
      p.outfit.setSpec(p.outfitSpec);
      syncLayerVisibility(p);
    };

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 5, 5000);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 40;
    controls.maxDistance = 650;
    controls.enablePan = true;
    controls.panSpeed = 0.8;
    controls.rotateSpeed = 0.8;

    let lastTele: TelemetryMessage | null = null;
    const unsubTele = engine.onTelemetry((t) => {
      lastTele = t;
    });

    async function initScene() {
      const [
        { Rig },
        { wearHead, HEAD_LOOKS },
        { RigView },
        { VoiceModel },
        { PRESETS: BODY_PRESETS },
        { REST_ARTIC },
      ] = await Promise.all([
        import("@chimera/rig/rig.ts"),
        import("@chimera/rig/head.ts"),
        import("@chimera/rig/view.ts"),
        import("@chimera/ui/analysis.ts"),
        import("@chimera/ui/body.ts"),
        import("@chimera/ui/render/anatomy3d.ts"),
      ]);

      const rigUrl = new URL("../chimera/src/rig/body.rig.bin", import.meta.url).href;
      const chars = charactersRef.current;
      const isDual = chars.length > 1;

      const defaultTarget = new THREE.Vector3();
      const defaultPosition = new THREE.Vector3();

      // Encuadre desde los bounds reales de cuerpo + cabeza. La cabeza llega a y ≈ 92, no a 142;
      // un target fijo alto deja a los personajes en la franja inferior del canvas.
      // El tramo final de las piernas se desvanece en el shader: no debe achicar la figura.
      const updateCameraFrame = () => {
        if (!performers.length) return;
        const box = new THREE.Box3();
        for (const p of performers) box.expandByObject(p.group);
        box.min.y = Math.max(box.min.y, -10);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5;
        const margin = 1.22;
        const distance = Math.max(
          (size.y * margin) / (2 * Math.tan(halfFov)),
          (size.x * margin) / (2 * Math.tan(halfFov) * camera.aspect)
        );
        // El centro X es la media de las posiciones de escenario: simétrico aunque una cabeza sea
        // más ancha que la otra. La cámara queda en ese mismo X, sin desplazamiento lateral: un
        // pequeño offset acercaba al personaje derecho y lo hacía más grande y más brillante.
        const stageX = performers.reduce((sum, p) => sum + p.group.position.x, 0) / performers.length;
        defaultTarget.set(stageX, center.y, center.z);
        defaultPosition.set(stageX, center.y + distance * 0.015, center.z + distance);
      };

      const applyCameraReset = () => {
        updateCameraFrame();
        camera.position.copy(defaultPosition);
        controls.target.copy(defaultTarget);
        controls.update();
      };
      resetCameraRef.current = applyCameraReset;

      const lookConfig = HEAD_LOOKS[headLookRef.current] ?? HEAD_LOOKS.vocal;

      for (let i = 0; i < chars.length; i++) {
        if (disposed) return;
        const ch = chars[i];
        const rig = await Rig.load(rigUrl);
        const voiceBody = BODY_PRESETS[ch.body] ?? BODY_PRESETS.female;
        const model = new VoiceModel(voiceBody, 48000);

        const head = wearHead(rig, model, { look: lookConfig });
        const view = new RigView(rig);

        // Static rest coordinates for the vocal shader's anchored cuts.
        addRestAttribute(rig, view);
        const frontMesh = view.group.children[1] as THREE.Mesh;
        const backMesh = view.group.children[0] as THREE.Mesh;
        const vocalMat = createVocalBodyMaterial();
        const vocalBackMat = createVocalBodyMaterial(true);

        // Position on stage
        const defaultX = isDual ? (i === 0 ? -48 : 48) : 0;
        const posX = ch.stageX ?? defaultX;
        const baseTurn = isDual ? (posX < 0 ? -12 : 12) : 0;

        const group = new THREE.Group();
        group.add(view.group, head.mount);
        group.position.set(posX, 0, 0);
        scene.add(group);

        // Capas sobre la misma geometría del rig (con `aRest`): siguen el pose sin buffers propios.
        const outfit = createOutfitLayer(
          group,
          frontMesh.geometry as THREE.BufferGeometry,
          ch.layers?.outfit as OutfitSpec | undefined
        );
        const hair = createHairLayer(group, ch.layers?.hair as HairSpec | undefined);

        const initialPose = clonePose(POSTURE_PRESETS.neutral);
        initialPose.body.turn = baseTurn;
        rig.pose(initialPose);
        const skinned = new Float32Array(3 * rig.n);
        rig.skin(skinned);

        const pInstance: PerformerInstance = {
          id: ch.id,
          group,
          rig,
          model,
          head,
          view,
          vocalMat,
          vocalBackMat,
          outfit,
          hair,
          hairEnabled: false,
          layerSignature: "",
          styleVisible: true,
          skinned,
          currentPose: clonePose(initialPose),
          targetPose: clonePose(initialPose),
          baseTurn,
        };

        // Apply initial body style and the character's layers (outfit by default in DIALOGUE_SCENE).
        applyBodyStyle(pInstance, bodyStyleRef.current);
        syncLayers(pInstance, ch);
        performers.push(pInstance);
      }

      sizeRenderer();

      let framed = false;
      let breathT = 0;
      let last = performance.now();
      let lastAppliedLook = headLookRef.current;
      let lastAppliedStyle = bodyStyleRef.current;

      renderer.setAnimationLoop((now) => {
        const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
        last = now;
        breathT += dt;

        // Dynamic headLook switch
        const currentLook = headLookRef.current;
        if (currentLook !== lastAppliedLook) {
          lastAppliedLook = currentLook;
          const targetLook = HEAD_LOOKS[currentLook] ?? HEAD_LOOKS.vocal;
          for (const p of performers) {
            p.head.setLook(targetLook);
            p.view.toneChanged();
          }
        }

        // Dynamic bodyStyle switch
        const currentStyle = bodyStyleRef.current;
        if (currentStyle !== lastAppliedStyle) {
          lastAppliedStyle = currentStyle;
          for (const p of performers) {
            applyBodyStyle(p, currentStyle);
          }
        }

        controls.update();

        const activeId = activeCharRef.current;
        const isSpeaking = speakingRef.current;
        const postureKey = activePostureRef.current ?? "attentive";
        const hasSpeaker = isSpeaking && activeId !== null;

        for (let i = 0; i < performers.length; i++) {
          const p = performers[i];
          const chNow = charactersRef.current[i];
          if (chNow) syncLayers(p, chNow);
          const isCurrentSpeaker = hasSpeaker && p.id === activeId;
          const isSolo = performers.length === 1;

          // Compute target posture based on emotion / intent
          let target: Pose;
          if (isCurrentSpeaker) {
            target = clonePose(POSTURE_PRESETS[postureKey] ?? POSTURE_PRESETS.attentive);
            target.body.turn += p.baseTurn * 0.5;

            // Expressive speech oscillations based on attitude
            if (postureKey === "agreement") {
              target.neck.flex += Math.sin(breathT * 1.8 * Math.PI * 2) * 2.8;
            } else if (postureKey === "emphatic") {
              target.neck.flex += Math.sin(breathT * 0.9 * Math.PI * 2) * 2.2;
              target.spine.flex += Math.sin(breathT * 0.9 * Math.PI * 2) * 1.0;
            } else if (postureKey === "curious") {
              target.neck.bend += Math.sin(breathT * 0.3 * Math.PI * 2) * 2.0;
            } else {
              target.neck.flex += Math.sin(breathT * 0.35 * Math.PI * 2) * 1.5;
              target.spine.flex += Math.sin(breathT * 0.7 * Math.PI * 2) * 0.6;
            }
          } else if (hasSpeaker && !isSolo) {
            // Listener turns toward interlocutor
            const otherIndex = performers.findIndex((x) => x.id === activeId);
            const side: -1 | 1 = otherIndex > i ? 1 : -1;
            target = listeningPose(side);
            target.body.turn += p.baseTurn;
            target.spine.flex += Math.sin(breathT * 0.4 * Math.PI * 2) * 0.3;
          } else {
            // Resting state
            target = clonePose(POSTURE_PRESETS.neutral);
            target.body.turn += p.baseTurn;
            target.spine.flex += Math.sin(breathT * 0.45 * Math.PI * 2) * 0.4;
          }

          // Smooth frame-by-frame interpolation
          p.currentPose = lerpPose(p.currentPose, target, Math.min(1, dt * 4.5));
          p.rig.pose(p.currentPose);
          p.rig.skin(p.skinned);

          // Articulation: only active speaker moves speech articulators
          const store = useStore.getState();
          const artic = isCurrentSpeaker && store.started ? store.artic : REST_ARTIC;
          const tele = isCurrentSpeaker ? lastTele : null;

          p.head.update(camera, artic, tele, dt);
          p.head.face(p.skinned, p.view.posed);
          p.view.update();
        }

        // Los bounds ya están actualizados por el primer frame (el view rellena su geometría aquí).
        if (!framed) {
          framed = true;
          applyCameraReset();
        }

        renderer.render(scene, camera);
      });
    }

    function applyBodyStyle(p: PerformerInstance, style: BodyStyle) {
      const view = p.view;
      const frontMesh = view.group.children[1] as THREE.Mesh;
      const backMesh = view.group.children[0] as THREE.Mesh;

      if (style === "head-only") {
        view.group.visible = false;
        view.showBones = false;
        p.styleVisible = false;
        syncLayerVisibility(p);
        return;
      }

      // "vocal" y cualquier estilo legacy (normalizado a "vocal" al importar).
      // Cuerpo base fantasma: silueta + línea media + pocas curvas verticales (ver VOCAL_FRAG).
      // Se corta en el cuello para dejar la cara limpia. Caras traseras muy tenues dan capas.
      view.group.visible = true;
      frontMesh.material = p.vocalMat;
      backMesh.material = p.vocalBackMat;
      backMesh.visible = true;
      view.showBones = false;
      p.styleVisible = true;
      syncLayerVisibility(p);
    }

    initScene().catch((err) => {
      console.error("[RigScene] Initialization failed:", err);
    });

    function sizeRenderer() {
      const c = canvasRef.current;
      if (!c) return;
      const w = c.clientWidth,
        h = c.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      for (const p of performers) {
        p.head.resize(w, h);
      }
    }

    const ro = new ResizeObserver(sizeRenderer);
    ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(animId);
      renderer.setAnimationLoop(null);
      controls.dispose();
      unsubTele();
      ro.disconnect();
      for (const p of performers) {
        p.outfit.dispose(); // libera sus materiales; la geometría es del rig y la libera view.dispose()
        p.hair.dispose();
        p.head.dispose();
        p.view.dispose();
        p.vocalMat.dispose();
        p.vocalBackMat.dispose();
        p.model.dispose?.();
        scene.remove(p.group);
      }
      renderer.dispose();
    };
  }, [characters]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height: "100%", display: "block", cursor: "grab" }}
      aria-label="Escena 3D interactiva: arrastra para orbitar la cámara"
    />
  );
});