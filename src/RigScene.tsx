/**
 * RigScene — Renders one or two CHIMERA performers in a shared Three.js scene.
 *
 * Capabilities:
 *  - 1 or 2 performers with individual body rigs, voices, and 3D heads.
 *  - Natural posture transitions (lerp) based on speech state and PostureHints.
 *  - Interlocutor gaze tracking: listeners turn toward speakers.
 *  - Live articulatory lip-sync + telemetry for the active speaker.
 *  - Single WebGL canvas with high performance and linear color space.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { TelemetryMessage } from "@chimera/wasm/../../src/worklet/protocol.ts";
import { engine } from "@chimera/audio/AudioEngine.ts";
import { useStore } from "@chimera/ui/store.ts";
import type { Character, PostureHint } from "./scene.ts";
import { POSTURE_PRESETS, listeningPose, lerpPose, clonePose } from "./poses.ts";
import type { Pose } from "@chimera/rig/pose.ts";

export interface RigSceneProps {
  characters: Character[];
  activeCharacterId: string | null;
  activePosture?: PostureHint;
  speaking: boolean;
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

export function RigScene({
  characters,
  activeCharacterId,
  activePosture = "attentive",
  speaking,
  className,
}: RigSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Keep live props in refs so animation loop has instant access
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const activeCharRef = useRef(activeCharacterId);
  activeCharRef.current = activeCharacterId;
  const activePostureRef = useRef(activePosture);
  activePostureRef.current = activePosture;
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;

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
    const camera = new THREE.PerspectiveCamera(28, 1, 5, 5000);

    let lastTele: TelemetryMessage | null = null;
    const unsubTele = engine.onTelemetry((t) => {
      lastTele = t;
    });

    // Load modules once
    async function initScene() {
      const [
        { Rig },
        { wearHead },
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

      // Adjust camera for 1 vs 2 performers
      if (isDual) {
        camera.position.set(0, 150, 420);
        camera.lookAt(0, 136, 0);
      } else {
        camera.position.set(20, 155, 320);
        camera.lookAt(0, 140, 0);
      }

      for (let i = 0; i < chars.length; i++) {
        if (disposed) return;
        const ch = chars[i];
        const rig = await Rig.load(rigUrl);
        const voiceBody = BODY_PRESETS[ch.body] ?? BODY_PRESETS.female;
        const model = new VoiceModel(voiceBody, 48000);
        const head = wearHead(rig, model);
        const view = new RigView(rig);

        const group = new THREE.Group();
        group.add(view.group, head.mount);

        // Position: dual layout or single centered
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

      renderer.setAnimationLoop((now) => {
        const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
        last = now;
        breathT += dt;

        const activeId = activeCharRef.current;
        const isSpeaking = speakingRef.current;
        const postureKey = activePostureRef.current ?? "attentive";
        const hasSpeaker = isSpeaking && activeId !== null;

        for (let i = 0; i < performers.length; i++) {
          const p = performers[i];
          const isCurrentSpeaker = hasSpeaker && p.id === activeId;
          const isSolo = performers.length === 1;

          // Compute target pose
          let target: Pose;
          if (isCurrentSpeaker) {
            target = clonePose(POSTURE_PRESETS[postureKey] ?? POSTURE_PRESETS.attentive);
            target.body.turn += p.baseTurn * 0.5;
            // speaking nod & sway
            target.neck.flex += Math.sin(breathT * 0.35 * Math.PI * 2) * 1.5;
            target.spine.flex += Math.sin(breathT * 0.7 * Math.PI * 2) * 0.6;
          } else if (hasSpeaker && !isSolo) {
            // Listener turns toward interlocutor
            const otherIndex = performers.findIndex((x) => x.id === activeId);
            const side: -1 | 1 = otherIndex > i ? 1 : -1;
            target = listeningPose(side);
            target.body.turn += p.baseTurn;
            // gentle listening breath
            target.spine.flex += Math.sin(breathT * 0.4 * Math.PI * 2) * 0.3;
          } else {
            // Idle / resting
            target = clonePose(POSTURE_PRESETS.neutral);
            target.body.turn += p.baseTurn;
            // calm breathing
            target.spine.flex += Math.sin(breathT * 0.45 * Math.PI * 2) * 0.4;
          }

          // Smooth interpolation towards target pose
          p.currentPose = lerpPose(p.currentPose, target, Math.min(1, dt * 4.5));
          p.rig.pose(p.currentPose);
          p.rig.skin(p.skinned);

          // Articulation: only active speaker moves mouth
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
  }, [characters]); // Re-init when character roster changes

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height: "100%", display: "block" }}
      aria-label="Escena 3D con personajes y body rig de CHIMERA"
    />
  );
}
