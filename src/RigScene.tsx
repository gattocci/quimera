/**
 * RigScene — Renders CHIMERA performers in a shared Three.js scene with interactive OrbitControls.
 *
 * Capabilities:
 *  - 1 or 2 performers with individual body rigs, voices, and 3D heads.
 *  - Interactive 3D camera (OrbitControls): rotate, zoom, and pan around the performers.
 *  - Restores the iconic CHIMERA anatomic wireframe aesthetic ("classic" look: cyan contour loops,
 *    glowing orange jaw, vivid airway, tongue, and larynx).
 *  - Dynamic posture transitions (lerp) based on speech state and PostureHints.
 *  - Interlocutor gaze tracking: listeners turn toward speakers.
 *  - Live articulatory lip-sync + telemetry for the active speaker.
 *  - High-performance WebGL renderer with LinearSRGB color space.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { TelemetryMessage } from "@chimera/wasm/../../src/worklet/protocol.ts";
import { engine } from "@chimera/audio/AudioEngine.ts";
import { useStore } from "@chimera/ui/store.ts";
import type { Character, PostureHint } from "./scene.ts";
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
  className?: string;
}

interface PerformerInstance {
  id: string;
  group: THREE.Group;
  rig: any;
  model: any;
  head: any;
  view: any;
  skinned: Float32Array;
  currentPose: Pose;
  targetPose: Pose;
  baseTurn: number;
}

export const RigScene = forwardRef<RigSceneHandle, RigSceneProps>(function RigScene(
  {
    characters,
    activeCharacterId,
    activePosture = "attentive",
    speaking,
    headLook = "classic",
    className,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resetCameraRef = useRef<(() => void) | null>(null);

  // Expose imperative handle so parent can trigger camera reset
  useImperativeHandle(ref, () => ({
    resetCamera: () => {
      resetCameraRef.current?.();
    },
  }));

  // Live refs for render loop
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

    // OrbitControls for full interactive camera exploration
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 50;
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

      // Camera initial framing: bring performers closer and center them beautifully
      const defaultTarget = isDual ? new THREE.Vector3(0, 142, 0) : new THREE.Vector3(0, 145, 0);
      const defaultPosition = isDual
        ? new THREE.Vector3(0, 146, 220)
        : new THREE.Vector3(12, 148, 135);

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

        // Mount head with the selected anatomical look (default: classic wireframe)
        const head = wearHead(rig, model, { look: lookConfig });
        const view = new RigView(rig);

        // Refine body wireframe look to elegantly accompany the head
        view.toneChanged();

        const group = new THREE.Group();
        group.add(view.group, head.mount);

        // Position: dual layout (standing slightly turned toward each other) or single centered
        const posX = isDual ? (i === 0 ? -48 : 48) : 0;
        const baseTurn = isDual ? (i === 0 ? -12 : 12) : 0;
        group.position.set(posX, 0, 0);
        scene.add(group);

        const initialPose = clonePose(POSTURE_PRESETS.neutral);
        initialPose.body.turn = baseTurn;
        rig.pose(initialPose);
        const skinned = new Float32Array(3 * rig.n);
        rig.skin(skinned);

        performers.push({
          id: ch.id,
          group,
          rig,
          model,
          head,
          view,
          skinned,
          currentPose: clonePose(initialPose),
          targetPose: clonePose(initialPose),
          baseTurn,
        });
      }

      sizeRenderer();

      let breathT = 0;
      let last = performance.now();
      let lastAppliedLook = headLookRef.current;

      renderer.setAnimationLoop((now) => {
        const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
        last = now;
        breathT += dt;

        // Check if headLook has changed dynamically
        const currentLook = headLookRef.current;
        if (currentLook !== lastAppliedLook) {
          lastAppliedLook = currentLook;
          const targetLook = HEAD_LOOKS[currentLook] ?? HEAD_LOOKS.classic;
          for (const p of performers) {
            p.head.setLook(targetLook);
            p.view.toneChanged();
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

          // Compute target posture
          let target: Pose;
          if (isCurrentSpeaker) {
            target = clonePose(POSTURE_PRESETS[postureKey] ?? POSTURE_PRESETS.attentive);
            target.body.turn += p.baseTurn * 0.5;
            // subtle speech nod & breathe
            target.neck.flex += Math.sin(breathT * 0.35 * Math.PI * 2) * 1.5;
            target.spine.flex += Math.sin(breathT * 0.7 * Math.PI * 2) * 0.6;
          } else if (hasSpeaker && !isSolo) {
            // Listener turns toward the active speaker
            const otherIndex = performers.findIndex((x) => x.id === activeId);
            const side: -1 | 1 = otherIndex > i ? 1 : -1;
            target = listeningPose(side);
            target.body.turn += p.baseTurn;
            target.spine.flex += Math.sin(breathT * 0.4 * Math.PI * 2) * 0.3;
          } else {
            // Idle resting posture
            target = clonePose(POSTURE_PRESETS.neutral);
            target.body.turn += p.baseTurn;
            target.spine.flex += Math.sin(breathT * 0.45 * Math.PI * 2) * 0.4;
          }

          // Smooth interpolation towards target pose
          p.currentPose = lerpPose(p.currentPose, target, Math.min(1, dt * 4.5));
          p.rig.pose(p.currentPose);
          p.rig.skin(p.skinned);

          // Articulation: only the speaker articulates live speech
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
