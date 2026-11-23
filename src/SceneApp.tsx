import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PRESETS, defaultF0 } from "@chimera/ui/body.ts";
import { speakText, speakingNow, stopSpeaking } from "@chimera/ui/speech.ts";
import { useStore } from "@chimera/ui/store.ts";
import { Chip } from "@chimera/ui/components/Screen.tsx";
import type { Lang, DialectPreset } from "@chimera/wasm/engine.ts";
import { DIALECT_PRESETS } from "@chimera/wasm/engine.ts";
import { RigScene, type HeadLookName, type RigSceneHandle } from "./RigScene.tsx";
import { ScenePlayer } from "./ScenePlayer.ts";
import {
  DIALOGUE_SCENE,
  SOLILOQUY_SCENE,
  validateScene,
  type Character,
  type PostureHint,
  type Scene,
} from "./scene.ts";

type AppMode = "scene" | "free";

export function SceneApp() {
  const [mode, setMode] = useState<AppMode>("scene");

  // ── Appearance & Camera ──
  const [headLook, setHeadLook] = useState<HeadLookName>("classic");
  const rigSceneRef = useRef<RigSceneHandle>(null);

  // ── Free mode state ──
  const [text, setText] = useState("Hola. Soy una voz hecha de aire.");
  const [lang, setLang] = useState<Lang>("es");
  const [dialectPreset, setDialectPreset] = useState<DialectPreset>("neutro");
  const [body, setBody] = useState<keyof typeof PRESETS>("female");
  const run = useRef(0);

  // ── Scene mode state ──
  const [scenePresetKey, setScenePresetKey] = useState<"dialogue" | "soliloquy" | "custom">("dialogue");
  const [scene, setScene] = useState<Scene>(DIALOGUE_SCENE);
  const [activeEventIndex, setActiveEventIndex] = useState<number | null>(null);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [activePosture, setActivePosture] = useState<PostureHint>("neutral");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const playerRef = useRef<ScenePlayer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputId = useId();

  // ── Shared audio state ──
  const [speaking, setSpeaking] = useState(false);
  const started = useStore((s) => s.started);

  // Keep ScenePlayer synchronized with the current scene
  useEffect(() => {
    const p = new ScenePlayer(scene);
    p.onProgress = (idx, charId, posture) => {
      setActiveEventIndex(idx);
      setActiveCharacterId(charId);
      setActivePosture(posture ?? "neutral");
      setSpeaking(idx !== null && charId !== null);
    };
    playerRef.current = p;
    return () => {
      p.stop();
    };
  }, [scene]);

  // Handle preset change
  const handlePresetChange = (key: "dialogue" | "soliloquy" | "custom") => {
    setScenePresetKey(key);
    setJsonError(null);
    if (key === "dialogue") setScene(DIALOGUE_SCENE);
    if (key === "soliloquy") setScene(SOLILOQUY_SCENE);
  };

  // Import JSON scene
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const raw = JSON.parse(event.target?.result as string);
        const valid = validateScene(raw);
        setScene(valid);
        setScenePresetKey("custom");
        setJsonError(null);
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : String(err));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Export current scene as JSON
  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scene.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "scene"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Free mode play ──
  const playFree = async () => {
    if (speaking) {
      run.current++;
      stopSpeaking();
      setSpeaking(false);
      setActiveCharacterId(null);
      return;
    }
    const token = ++run.current;
    setSpeaking(true);
    setActiveCharacterId("solo");
    try {
      const voice = PRESETS[body];
      const state = useStore.getState();
      state.setBody(voice);
      state.setSource({ f0: defaultF0(voice) });
      await state.start();
      if (!useStore.getState().started || run.current !== token) return;
      const dialect = lang === "es" ? DIALECT_PRESETS[dialectPreset] : undefined;
      const plan = await speakText(text, {
        ipa: false,
        lang,
        dialect,
        body: voice,
        rate: 1,
        f0: defaultF0(voice),
      });
      if (plan) {
        while (run.current === token && speakingNow()) {
          await new Promise((resolve) => window.setTimeout(resolve, 40));
        }
      }
    } finally {
      if (run.current === token) {
        setSpeaking(false);
        setActiveCharacterId(null);
      }
    }
  };

  // ── Scene mode play ──
  const playScene = () => {
    const p = playerRef.current;
    if (!p) return;
    if (speaking) {
      p.stop();
      return;
    }
    void p.play();
  };

  // Construct active characters for the 3D rig
  const isSceneMode = mode === "scene";
  const activeCharacters: Character[] = useMemo(() => {
    if (!isSceneMode) {
      return [
        {
          id: "solo",
          name: "Voz de aire",
          body,
          lang,
          dialectPreset,
        },
      ];
    }
    return scene.characters;
  }, [isSceneMode, body, lang, dialectPreset, scene.characters]);

  return (
    <main className="quimera-app">
      <header className="quimera-header">
        <div>
          <p className="quimera-kicker">CHIMERA · proyecto compañero</p>
          <h1>Quimera</h1>
        </div>
        <p className="quimera-note">
          La cabeza y la voz siguen siendo CHIMERA. La escena añade el cuerpo y los turnos.
        </p>
      </header>

      {/* ── 3D Stage with RigScene ── */}
      <section className={`quimera-stage${speaking ? " is-speaking" : ""}`} aria-label="Escena 3D">
        <div className="quimera-grid" aria-hidden="true" />

        {/* Floating 3D view controls toolbar */}
        <div className="quimera-stage-bar">
          <div className="quimera-look-picker">
            <span className="quimera-bar-label">Cabeza:</span>
            <button
              type="button"
              className={`quimera-look-btn${headLook === "classic" ? " is-active" : ""}`}
              onClick={() => setHeadLook("classic")}
              title="Estética anatómica clásica: anillos wireframe y tracto vocal visible"
            >
              Clásica
            </button>
            <button
              type="button"
              className={`quimera-look-btn${headLook === "vocal" ? " is-active" : ""}`}
              onClick={() => setHeadLook("vocal")}
              title="Malla densa con rasgos resaltados"
            >
              Vocal
            </button>
            <button
              type="button"
              className={`quimera-look-btn${headLook === "outside" ? " is-active" : ""}`}
              onClick={() => setHeadLook("outside")}
              title="Malla exterior con interior atenuado"
            >
              Piel
            </button>
          </div>

          <div className="quimera-camera-tools">
            <span className="quimera-camera-hint">🖱️ Arrastra para rotar · Rueda: zoom</span>
            <button
              type="button"
              className="quimera-btn-reset-cam"
              onClick={() => rigSceneRef.current?.resetCamera()}
              title="Centrar y reajustar cámara a los personajes"
            >
              Centrar cámara
            </button>
          </div>
        </div>

        <div className="quimera-stage-viewport">
          <RigScene
            ref={rigSceneRef}
            characters={activeCharacters}
            activeCharacterId={activeCharacterId}
            activePosture={activePosture}
            speaking={speaking}
            headLook={headLook}
            className="quimera-rig-canvas"
          />

          <div className="quimera-cast-labels" aria-hidden="true">
            {activeCharacters.map((c) => (
              <span
                key={c.id}
                className={`quimera-performer-badge${activeCharacterId === c.id ? " is-speaking" : ""}`}
              >
                {c.name}
              </span>
            ))}
          </div>
        </div>

        <span className="quimera-stage-caption">
          {speaking
            ? `HABLANDO: ${activeCharacters.find((c) => c.id === activeCharacterId)?.name ?? "PERSONAJE"} · POSTURA: ${activePosture.toUpperCase()}`
            : "EN ESCENA · REPOSO"}
        </span>
      </section>

      {/* ── Control Console ── */}
      <section className="quimera-controls" aria-label="Controles del prototipo">
        <div className="quimera-mode-tabs" role="tablist" aria-label="Modo de ejecución">
          <button
            role="tab"
            aria-selected={isSceneMode}
            className={`quimera-tab${isSceneMode ? " is-active" : ""}`}
            onClick={() => setMode("scene")}
          >
            Escena & Diálogo
          </button>
          <button
            role="tab"
            aria-selected={!isSceneMode}
            className={`quimera-tab${!isSceneMode ? " is-active" : ""}`}
            onClick={() => setMode("free")}
          >
            Voz Libre
          </button>
        </div>

        {/* ── Scene Mode Controls ── */}
        {isSceneMode && (
          <div className="quimera-scene-deck">
            <div className="quimera-scene-bar">
              <label>
                Guión
                <select
                  value={scenePresetKey}
                  onChange={(e) => handlePresetChange(e.target.value as any)}
                >
                  <option value="dialogue">Diálogo: Aria & Dante (2 personajes)</option>
                  <option value="soliloquy">Soliloquio: Aria (1 personaje)</option>
                  <option value="custom">Personalizado (archivo JSON)</option>
                </select>
              </label>

              <button
                type="button"
                className="quimera-btn-secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                Cargar JSON
              </button>
              <input
                id={jsonInputId}
                ref={fileInputRef}
                type="file"
                accept=".json"
                style={{ display: "none" }}
                onChange={handleFileUpload}
              />

              <button type="button" className="quimera-btn-secondary" onClick={handleExportJson}>
                Exportar JSON
              </button>
            </div>

            {jsonError && <p className="quimera-error-banner">{jsonError}</p>}

            <ol className="quimera-script">
              {scene.events.map((ev, i) => {
                const isActive = activeEventIndex === i;
                if ("kind" in ev) {
                  return (
                    <li key={i} className={`quimera-beat${isActive ? " is-active" : ""}`}>
                      <span className="quimera-beat-icon">⏱</span>
                      Pausa: {ev.label ?? "silencio"} ({ev.durationS} s)
                    </li>
                  );
                }
                const ch = scene.characters.find((c) => c.id === ev.characterId);
                return (
                  <li key={i} className={`quimera-line${isActive ? " is-active" : ""}`}>
                    <span className="quimera-line-name">{ch?.name ?? ev.characterId}</span>
                    <span className="quimera-line-text">{ev.text}</span>
                    {ev.posture && <span className="quimera-line-tag">{ev.posture}</span>}
                  </li>
                );
              })}
            </ol>

            <div className="quimera-options">
              <Chip toggle={false} onClick={playScene}>
                {speaking ? "Detener escena" : "Reproducir escena"}
              </Chip>
              <span className="quimera-status" aria-live="polite">
                {started ? "Audio listo" : "El audio inicia al pulsar Reproducir"}
              </span>
            </div>
          </div>
        )}

        {/* ── Free Mode Controls ── */}
        {!isSceneMode && (
          <div className="quimera-free-deck">
            <label className="quimera-text-label" htmlFor="scene-text">
              Texto
            </label>
            <textarea
              id="scene-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
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
                <select
                  value={body}
                  onChange={(e) => setBody(e.target.value as keyof typeof PRESETS)}
                >
                  <option value="female">Adulto · preset femenino</option>
                  <option value="male">Adulto · preset masculino</option>
                  <option value="child">Infantil</option>
                </select>
              </label>

              <Chip toggle={false} disabled={!speaking && !text.trim()} onClick={() => void playFree()}>
                {speaking ? "Detener" : "Hablar"}
              </Chip>
              <span className="quimera-status" aria-live="polite">
                {started ? "Audio listo" : "El audio inicia al pulsar Hablar"}
              </span>
            </div>
          </div>
        )}
      </section>

      <footer className="quimera-footer">
        Quimera · escenas, cuerpo y turnos para CHIMERA · articulación vocal física original
      </footer>
    </main>
  );
}
