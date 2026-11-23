/**
 * RigScene — Renders CHIMERA performers in a shared Three.js scene with interactive OrbitControls.
 *
 * Capabilities:
 *  - 1 or 2 performers with individual body rigs, voices, and 3D heads.
 *  - Body style modes:
 *      * "anatomic": Horizontal contour slice rings matching the exact aesthetic of the CHIMERA head.
 *      * "head-only": Pure CHIMERA standalone head floating in space, zero body clutter.
 *      * "ethereal": Soft, translucent contour silhouette that anchors the head gently.
 *      * "mesh": Complete technical wireframe rig.
 *  - Restores the iconic CHIMERA anatomic wireframe aesthetic ("classic" look: cyan contour loops,
 *    glowing orange jaw, vivid airway, tongue, and larynx).
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
  contourMat: THREE.ShaderMaterial;
  origFrontMat: THREE.ShaderMaterial;
  origBackMat: THREE.ShaderMaterial;
  skinned: Float32Array;
  currentPose: Pose;
  targetPose: Pose;
  baseTurn: number;
}

// ────────────────────────────────────────────── Contour Ring Shaders ─────────

const CONTOUR_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPos = position;
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const CONTOUR_FRAG = /* glsl */ `
uniform vec3 uLine;
uniform vec3 uEdge;
uniform vec3 uFill;
uniform float uAlpha;
uniform float uRingStep;
uniform float uLineWidth;
varying vec3 vPos;
varying vec3 vN;
varying vec3 vV;

void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float facing = abs(dot(n, v));
  float rim = pow(1.0 - facing, 2.4);

  // Horizontal contour ring slice matching CHIMERA head's rings
  float y = vPos.y;
  float ringDist = abs(fract(y / uRingStep + 0.5) - 0.5) * uRingStep;
  float dy = max(fwidth(y), 0.001);
  float ring = 1.0 - smoothstep(uLineWidth, uLineWidth + dy * 1.6, ringDist);

  // Soft fade below the waist/hips to keep an elegant anatomical bust
  float heightFade = smoothstep(68.0, 96.0, y);

  // Combine line, rim edge, and subtle fill
  vec3 col = uFill * 0.2 + uEdge * 1.1 * rim + uLine * ring * (0.6 + 0.4 * facing) * 1.5;
  col = max(col, 0.0);
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));

  float alpha = uAlpha * max(ring * 1.15, rim * 0.65) * heightFade;
  if (alpha < 0.015) discard;

  gl_FragColor = vec4(col, alpha);
}
`;

function createContourMaterial(opacity = 0.85, ringStep = 1.6) {
  return new THREE.ShaderMaterial({
    vertexShader: CONTOUR_VERT,
    fragmentShader: CONTOUR_FRAG,
    uniforms: {
      uLine: { value: new THREE.Vector3(0.06, 0.38, 0.72) }, // CHIMERA cyan
      uEdge: { value: new THREE.Vector3(0.02, 0.18, 0.38) },
      uFill: { value: new THREE.Vector3(0.002, 0.006, 0.012) },
      uAlpha: { value: opacity },
      uRingStep: { value: ringStep },
      uLineWidth: { value: 0.045 },
    },
    transparent: true,
    side: THREE.DoubleSide,
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
    headLook = "classic",
    bodyStyle = "anatomic",
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

      // Camera initial framing: center right at the performers' faces
      const defaultTarget = isDual ? new THREE.Vector3(0, 142, 0) : new THREE.Vector3(0, 145, 0);
      const defaultPosition = isDual
        ? new THREE.Vector3(0, 146, 215)
        : new THREE.Vector3(12, 148, 130);

      const applyCameraReset = () => {
        camera.position.copy(defaultPosition);
        controls.target.copy(defaultTarget);
        controls.update();
      };
      resetCameraRef.current = applyCameraReset;
      applyCameraReset();

      const lookConfig = HEAD_LOOKS[headLookRef.current] ?? HEAD_LOOKS.classic;

      for (let i = 0; i < chars.length; i++) {
        if (disposed) return;
        const ch = chars[i];
        const rig = await Rig.load(rigUrl);
        const voiceBody = BODY_PRESETS[ch.body] ?? BODY_PRESETS.female;
        const model = new VoiceModel(voiceBody, 48000);

        const head = wearHead(rig, model, { look: lookConfig });
        const view = new RigView(rig);

        // Save original materials so we can switch back to "mesh" cleanly
        const frontMesh = view.group.children[1] as THREE.Mesh;
        const backMesh = view.group.children[0] as THREE.Mesh;
        const origFrontMat = frontMesh.material as THREE.ShaderMaterial;
        const origBackMat = backMesh.material as THREE.ShaderMaterial;
        const contourMat = createContourMaterial(0.85, 1.6);

        // Position on stage
        const defaultX = isDual ? (i === 0 ? -48 : 48) : 0;
        const posX = ch.stageX ?? defaultX;
        const baseTurn = isDual ? (posX < 0 ? -12 : 12) : 0;

        const group = new THREE.Group();
        group.add(view.group, head.mount);
        group.position.set(posX, 0, 0);
        scene.add(group);

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
          contourMat,
          origFrontMat,
          origBackMat,
          skinned,
          currentPose: clonePose(initialPose),
          targetPose: clonePose(initialPose),
          baseTurn,
        };

        // Apply initial body style
        applyBodyStyle(pInstance, bodyStyleRef.current);
        performers.push(pInstance);
      }

      sizeRenderer();

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
          const targetLook = HEAD_LOOKS[currentLook] ?? HEAD_LOOKS.classic;
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
      } else if (style === "anatomic") {
        // Horizontal contour slice rings matching CHIMERA's head rings
        view.group.visible = true;
        p.contourMat.uniforms.uAlpha.value = 0.85;
        p.contourMat.uniforms.uRingStep.value = 1.6;
        p.contourMat.uniforms.uLineWidth.value = 0.045;
        frontMesh.material = p.contourMat;
        backMesh.visible = false;
        view.showBones = true; // delicate spine/shoulder line
      } else if (style === "ethereal") {
        // Soft translucent contour silhouette
        view.group.visible = true;
        p.contourMat.uniforms.uAlpha.value = 0.3;
        p.contourMat.uniforms.uRingStep.value = 2.0;
        p.contourMat.uniforms.uLineWidth.value = 0.035;
        frontMesh.material = p.contourMat;
        backMesh.visible = false;
        view.showBones = false;
      } else {
        // "mesh": restore standard MakeHuman wireframe quad shader
        view.group.visible = true;
        frontMesh.material = p.origFrontMat;
        backMesh.material = p.origBackMat;
        backMesh.visible = true;
        view.showBones = false;
      }
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
        p.head.dispose();
        p.view.dispose();
        p.contourMat.dispose();
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
