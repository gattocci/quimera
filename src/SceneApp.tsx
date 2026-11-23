import { useEffect, useRef, useState } from "react";
import { PRESETS, defaultF0 } from "@chimera/ui/body.ts";
import { speakText, speakingNow, stopSpeaking } from "@chimera/ui/speech.ts";
import { useStore } from "@chimera/ui/store.ts";
import { Chip } from "@chimera/ui/components/Screen.tsx";
import type { Lang, DialectPreset } from "@chimera/wasm/engine.ts";
import { DIALECT_PRESETS } from "@chimera/wasm/engine.ts";
import { RigScene } from "./RigScene.tsx";
import { ScenePlayer } from "./ScenePlayer.ts";
import { DEMO_SCENE, type Scene } from "./scene.ts";

/** Two modes: free (single text box) and scene (plays a Scene document). */
type AppMode = "free" | "scene";

export function SceneApp() {
  const [mode, setMode] = useState<AppMode>("free");

  // ── free mode state ──
  const [text, setText] = useState("Hola. Soy una voz hecha de aire.");
  const [lang, setLang] = useState<Lang>("es");
  const [dialectPreset, setDialectPreset] = useState<DialectPreset>("neutro");
  const [body, setBody] = useState<keyof typeof PRESETS>("female");
  const run = useRef(0);

  // ── scene mode state ──
  const [scene] = useState<Scene>(DEMO_SCENE);
  const playerRef = useRef<ScenePlayer | null>(null);
  const [activeEvent, setActiveEvent] = useState<number | null>(null);

  // ── shared ──
  const [speaking, setSpeaking] = useState(false);
  const started = useStore((s) => s.started);

  // keep ScenePlayer in sync with the current scene
  useEffect(() => {
    const p = new ScenePlayer(scene);
    p.onProgress = (idx) => {
      setActiveEvent(idx);
      setSpeaking(idx !== null);
    };
    playerRef.current = p;
    return () => { p.stop(); };
  }, [scene]);

  // ── free mode play ──
  const playFree = async () => {
    if (speaking) {
      run.current++;
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    const token = ++run.current;
    setSpeaking(true);
    try {
      const voice = PRESETS[body];
      const state = useStore.getState();
      state.setBody(voice);
      state.setSource({ f0: defaultF0(voice) });
      await state.start();
      if (!useStore.getState().started || run.current !== token) return;
      const dialect = lang === "es" ? DIALECT_PRESETS[dialectPreset] : undefined;
      const plan = await speakText(text, { ipa: false, lang, dialect, body: voice, rate: 1, f0: defaultF0(voice) });
      if (plan) {
        while (run.current === token && speakingNow())
          await new Promise((resolve) => window.setTimeout(resolve, 40));
      }
    } finally {
      if (run.current === token) setSpeaking(false);
    }
  };

  // ── scene mode play ──
  const playScene = () => {
    const p = playerRef.current;
    if (!p) return;
    if (speaking) { p.stop(); return; }
    void p.play();
  };

  const isSceneMode = mode === "scene";
  // in scene mode, body comes from the active character (or first character)
  const activeBody = isSceneMode
    ? (PRESETS[(scene.characters[0]?.body ?? "female")])
    : PRESETS[body];

  return (
    <main className="quimera-app">
      <header className="quimera-header">
        <div>
          <p className="quimera-kicker">CHIMERA · proyecto compañero</p>
          <h1>Quimera</h1>
        </div>
        <p className="quimera-note">La cabeza y la voz siguen siendo CHIMERA. La escena añade el cuerpo.</p>
      </header>

      {/* ── stage ── */}
      <section className={`quimera-stage${speaking ? " is-speaking" : ""}`} aria-label="Escena">
        <div className="quimera-grid" aria-hidden="true" />
        <div className="quimera-performer">
          <RigScene body={activeBody} speaking={speaking} className="quimera-rig-canvas" />
          <span className="quimera-name">
            {isSceneMode ? (scene.characters[0]?.name ?? "Personaje") : "Voz de aire"}
          </span>
        </div>
        <span className="quimera-stage-caption">
          {speaking ? "HABLANDO · ARTICULACIÓN CHIMERA" : "EN ESCENA · EN REPOSO"}
        </span>
      </section>

      {/* ── controls ── */}
      <section className="quimera-controls" aria-label="Controles del prototipo">
        {/* mode switcher */}
        <div className="quimera-mode-tabs" role="tablist" aria-label="Modo">
          <button
            role="tab"
            aria-selected={!isSceneMode}
            className={`quimera-tab${!isSceneMode ? " is-active" : ""}`}
            onClick={() => setMode("free")}
          >
            Libre
          </button>
          <button
            role="tab"
            aria-selected={isSceneMode}
            className={`quimera-tab${isSceneMode ? " is-active" : ""}`}
            onClick={() => setMode("scene")}
          >
            Escena
          </button>
        </div>

        {/* free mode */}
        {!isSceneMode && (
          <>
            <label className="quimera-text-label" htmlFor="scene-text">Texto</label>
            <textarea
              id="scene-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={2}
            />
            <div className="quimera-options">
              <label>
                Idioma
                <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
                  <option value="es">Español</option>
                  <option value="en">English</option>
                  <option value="tr">Türkçe</option>
                </select>
              </label>

              {lang === "es" && (
                <label>
                  Dialecto
                  <select
                    value={dialectPreset}
                    onChange={(e) => setDialectPreset(e.target.value as DialectPreset)}
                  >
                    <option value="neutro">Neutro latinoamericano</option>
                    <option value="rioplatense">Rioplatense (sheísmo, /s/ aspirada)</option>
                    <option value="castellano">Castellano (distinción c/z)</option>
                  </select>
                </label>
              )}

              <label>
                Cuerpo
                <select value={body} onChange={(e) => setBody(e.target.value as keyof typeof PRESETS)}>
                  <option value="female">Adulto · preset femenino</option>
                  <option value="male">Adulto · preset masculino</option>
                  <option value="child">Infantil</option>
                </select>
              </label>

              <Chip toggle={false} disabled={!speaking && !text.trim()} onClick={() => void playFree()}>
                {speaking ? "Detener" : "Hablar"}
              </Chip>
              <span className="quimera-status" aria-live="polite">
                {started ? "Audio listo" : "El audio empieza al pulsar Hablar"}
              </span>
            </div>
          </>
        )}

        {/* scene mode */}
        {isSceneMode && (
          <>
            <p className="quimera-scene-title">{scene.title}</p>
            <ol className="quimera-script">
              {scene.events.map((ev, i) => {
                const isActive = activeEvent === i;
                if ("kind" in ev) {
                  return (
                    <li key={i} className={`quimera-beat${isActive ? " is-active" : ""}`} aria-hidden="true">
                      {ev.label ?? "·"}
                    </li>
                  );
                }
                const ch = scene.characters.find((c) => c.id === ev.characterId);
                return (
                  <li key={i} className={`quimera-line${isActive ? " is-active" : ""}`}>
                    <span className="quimera-line-name">{ch?.name ?? ev.characterId}</span>
                    <span className="quimera-line-text">{ev.text}</span>
                  </li>
                );
              })}
            </ol>
            <div className="quimera-options">
              <Chip toggle={false} onClick={playScene}>
                {speaking ? "Detener escena" : "Reproducir escena"}
              </Chip>
              <span className="quimera-status" aria-live="polite">
                {started ? "Audio listo" : "El audio empieza al pulsar Reproducir"}
              </span>
            </div>
          </>
        )}
      </section>

      <footer className="quimera-footer">
        Prototipo inicial · voz, tracto y lip-sync sin modificar · cuerpo experimental independiente
      </footer>
    </main>
  );
}
