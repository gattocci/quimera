/**
 * RigScene — the CHIMERA head worn by the body rig, rendered live in a Three.js canvas.
 *
 * Keeps Three.js and rig state entirely inside this component.
 * The parent passes body preset and speaking state; the component manages
 * the render loop and telemetry subscription itself.
 *
 * Layout rules:
 *  - renderer.outputColorSpace = THREE.LinearSRGBColorSpace (the head's colours are display values)
 *  - no OrbitControls; camera is fixed to a portrait view of the performer
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { BodyMix } from "@chimera/ui/body.ts";
import type { TelemetryMessage } from "@chimera/wasm/../../src/worklet/protocol.ts";
import { engine } from "@chimera/audio/AudioEngine.ts";
import { useStore } from "@chimera/ui/store.ts";

export interface RigSceneProps {
  body: BodyMix;
  speaking: boolean;
  className?: string;
}

export function RigScene({ body, speaking, className }: RigSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const started = useStore((s) => s.started);
  const startedRef = useRef(started);
  startedRef.current = started;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let rigModule: Awaited<ReturnType<typeof loadRig>> | null = null;
    let animId = 0;

    async function loadRig() {
      const [
        { Rig },
        { wearHead },
        { RigView },
        { VoiceModel },
        { PRESETS: BODY_PRESETS },
        { REST_ARTIC },
        { pose },
      ] = await Promise.all([
        import("@chimera/rig/rig.ts"),
        import("@chimera/rig/head.ts"),
        import("@chimera/rig/view.ts"),
        import("@chimera/ui/analysis.ts"),
        import("@chimera/ui/body.ts"),
        import("@chimera/ui/render/anatomy3d.ts"),
        import("@chimera/rig/pose.ts"),
      ]);

      const rigUrl = new URL("../chimera/src/rig/body.rig.bin", import.meta.url).href;
      const rig = await Rig.load(rigUrl);
      const b = bodyRef.current;
      const model = new VoiceModel(b, 48000);
      const head = wearHead(rig, model);
      const view = new RigView(rig);

      // Breathing / idle pose
      const idlePose = pose({
        spine: { flex: 2 },
        neck: { flex: -4 },
        bothArms: { raise: 8, plane: 10, elbow: 10 },
      });
      rig.pose(idlePose);
      const skinned = new Float32Array(3 * rig.n);
      rig.skin(skinned);

      return { rig, model, head, view, skinned, idlePose, pose, BODY_PRESETS, REST_ARTIC };
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 5, 5000);

    // Portrait view: looking at the head-and-shoulders from slightly front-right
    camera.position.set(30, 155, 320);
    camera.lookAt(10, 140, 0);

    let lastTele: TelemetryMessage | null = null;
    const unsubTele = engine.onTelemetry((t) => { lastTele = t; });

    // Breath animation
    let breathT = 0;
    let last = performance.now();

    loadRig().then((m) => {
      if (disposed) {
        m.head.dispose();
        m.view.dispose();
        return;
      }
      rigModule = m;
      scene.add(m.view.group, m.head.mount);

      // size once
      sizeRenderer();

      renderer.setAnimationLoop((now) => {
        const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
        last = now;
        if (!rigModule) return;
        const { rig, head, view, skinned, idlePose, pose: poseFn, REST_ARTIC } = rigModule;

        breathT += dt;
        const speaking = speakingRef.current;
        // subtle breath sway
        const breathScale = speaking ? 1.4 : 0.8;
        const breath = Math.sin(breathT * (speaking ? 0.72 : 0.42) * Math.PI * 2) * breathScale;
        const nodAmount = speaking ? Math.sin(breathT * 0.31 * Math.PI * 2) * 1.5 : 0;

        const p = poseFn({
          spine: { flex: 2 + breath * 0.4 },
          neck: { flex: -4 + nodAmount, bend: Math.sin(breathT * 0.19 * Math.PI * 2) * 0.6 },
          bothArms: { raise: 8, plane: 10, elbow: 10 },
        });
        rig.pose(p);
        rig.skin(skinned);

        // the store's artic only updates during active speech; fall back to rest outside it
        const store = useStore.getState();
        const artic = startedRef.current ? store.artic : REST_ARTIC;
        head.update(camera, artic, lastTele, dt);
        head.face(skinned, view.posed);
        view.update();

        renderer.render(scene, camera);
      });
    }).catch((err) => {
      console.error("[RigScene] Failed to load rig:", err);
    });

    function sizeRenderer() {
      const c = canvasRef.current;
      if (!c) return;
      const w = c.clientWidth, h = c.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      rigModule?.head.resize(w, h);
    }

    const ro = new ResizeObserver(sizeRenderer);
    if (canvas) ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(animId);
      renderer.setAnimationLoop(null);
      unsubTele();
      ro.disconnect();
      rigModule?.head.dispose();
      rigModule?.view.dispose();
      renderer.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once — body changes are handled via refs

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height: "100%", display: "block" }}
      aria-label="Personaje 3D con cabeza CHIMERA y cuerpo posable"
    />
  );
}
