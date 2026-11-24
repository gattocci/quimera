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
  type BodyStyle,
  type Character,
  type PostureHint,
  type Scene,
  type SceneBeat,
  type SceneEvent,
  type SceneLine,
  type StageAtmosphere,
} from "./scene.ts";
import { POSTURE_LABELS } from "./poses.ts";

type AppMode = "scene" | "studio" | "free";

export function SceneApp() {
  const [mode, setMode] = useState<AppMode>("scene");

  // ── Global Stage Appearance ──
  const [headLook, setHeadLook] = useState<HeadLookName>("vocal");
  const [bodyStyle, setBodyStyle] = useState<BodyStyle>("vocal");
  const [atmosphere, setAtmosphere] = useState<StageAtmosphere>("void");
  const rigSceneRef = useRef<RigSceneHandle>(null);

  // ── Scene state ──
  const [scenePresetKey, setScenePresetKey] = useState<"dialogue" | "soliloquy" | "custom">("dialogue");
  const [scene, setScene] = useState<Scene>(DIALOGUE_SCENE);
  const [activeEventIndex, setActiveEventIndex] = useState<number | null>(null);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [activePosture, setActivePosture] = useState<PostureHint>("neutral");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // ── Free mode state ──
  const [freeText, setFreeText] = useState("Hola. Soy una voz hecha de aire y resonancia.");
  const [freeLang, setFreeLang] = useState<Lang>("es");
  const [freeDialect, setFreeDialect] = useState<DialectPreset>("neutro");
  const [freeBody, setFreeBody] = useState<keyof typeof PRESETS>("female");
  const freeRun = useRef(0);

  const playerRef = useRef<ScenePlayer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputId = useId();

  // ── Audio playback state ──
  const [speaking, setSpeaking] = useState(false);
  const started = useStore((s) => s.started);

  // Synchronize ScenePlayer with scene updates
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

  // Handle Preset Switching
  const handlePresetChange = (key: "dialogue" | "soliloquy" | "custom") => {
    setScenePresetKey(key);
    setJsonError(null);
    if (key === "dialogue") {
      setScene(DIALOGUE_SCENE);
      if (DIALOGUE_SCENE.stageBodyStyle) setBodyStyle(DIALOGUE_SCENE.stageBodyStyle);
      if (DIALOGUE_SCENE.stageAtmosphere) setAtmosphere(DIALOGUE_SCENE.stageAtmosphere);
    } else if (key === "soliloquy") {
      setScene(SOLILOQUY_SCENE);
      if (SOLILOQUY_SCENE.stageBodyStyle) setBodyStyle(SOLILOQUY_SCENE.stageBodyStyle);
      if (SOLILOQUY_SCENE.stageAtmosphere) setAtmosphere(SOLILOQUY_SCENE.stageAtmosphere);
    }
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
        if (valid.stageBodyStyle) setBodyStyle(valid.stageBodyStyle);
        if (valid.stageAtmosphere) setAtmosphere(valid.stageAtmosphere);
        setScenePresetKey("custom");
        setJsonError(null);
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : String(err));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Export scene
  const handleExportJson = () => {
    const exportData: Scene = {
      ...scene,
      stageBodyStyle: bodyStyle,
      stageAtmosphere: atmosphere,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scene.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "scene"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Scene Playback ──
  const playScene = () => {
    const p = playerRef.current;
    if (!p) return;
    if (speaking) {
      p.stop();
      return;
    }
    void p.play();
  };

  // ── Free Mode Playback ──
  const playFree = async () => {
    if (speaking) {
      freeRun.current++;
      stopSpeaking();
      setSpeaking(false);
      setActiveCharacterId(null);
      return;
    }
    const token = ++freeRun.current;
    setSpeaking(true);
    setActiveCharacterId("solo");
    try {
      const voice = PRESETS[freeBody];
      const state = useStore.getState();
      state.setBody(voice);
      state.setSource({ f0: defaultF0(voice) });
      await state.start();
      if (!useStore.getState().started || freeRun.current !== token) return;
      const dialect = freeLang === "es" ? DIALECT_PRESETS[freeDialect] : undefined;
      const plan = await speakText(freeText, {
        ipa: false,
        lang: freeLang,
        dialect,
        body: voice,
        rate: 1,
        f0: defaultF0(voice),
      });
      if (plan) {
        while (freeRun.current === token && speakingNow()) {
          await new Promise((resolve) => window.setTimeout(resolve, 40));
        }
      }
    } finally {
      if (freeRun.current === token) {
        setSpeaking(false);
        setActiveCharacterId(null);
      }
    }
  };

  // ── Studio Mutations ──
  const updateCharacter = (id: string, partial: Partial<Character>) => {
    setScene((prev) => ({
      ...prev,
      characters: prev.characters.map((c) => (c.id === id ? { ...c, ...partial } : c)),
    }));
  };

  const addCharacter = () => {
    const newId = `char-${Date.now().toString(36)}`;
    const newChar: Character = {
      id: newId,
      name: `Personaje ${scene.characters.length + 1}`,
      body: "female",
      lang: "es",
      dialectPreset: "neutro",
      f0: 200,
      color: "#50fa7b",
      stageX: 0,
      bodyStyle,
    };
    setScene((prev) => ({
      ...prev,
      characters: [...prev.characters, newChar],
    }));
  };

  const removeCharacter = (id: string) => {
    if (scene.characters.length <= 1) return;
    setScene((prev) => ({
      ...prev,
      characters: prev.characters.filter((c) => c.id !== id),
      events: prev.events.filter((e) => ("characterId" in e ? e.characterId !== id : true)),
    }));
  };

  const addLine = () => {
    const firstCharId = scene.characters[0]?.id ?? "aria";
    const newLine: SceneLine = {
      characterId: firstCharId,
      text: "Nueva frase de diálogo para la escena.",
      posture: "attentive",
    };
    setScene((prev) => ({
      ...prev,
      events: [...prev.events, newLine],
    }));
  };

  const addBeat = () => {
    const newBeat: SceneBeat = {
      kind: "beat",
      label: "pausa",
      durationS: 0.5,
    };
    setScene((prev) => ({
      ...prev,
      events: [...prev.events, newBeat],
    }));
  };

  const updateEvent = (index: number, event: SceneEvent) => {
    setScene((prev) => {
      const nextEvents = [...prev.events];
      nextEvents[index] = event;
      return { ...prev, events: nextEvents };
    });
  };

  const removeEvent = (index: number) => {
    setScene((prev) => ({
      ...prev,
      events: prev.events.filter((_, i) => i !== index),
    }));
  };

  const moveEvent = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= scene.events.length) return;
    setScene((prev) => {
      const next = [...prev.events];
      const temp = next[index];
      next[index] = next[target];
      next[target] = temp;
      return { ...prev, events: next };
    });
  };

  // Performers displayed in the 3D canvas
  const activeCharacters: Character[] = useMemo(() => {
    if (mode === "free") {
      return [
        {
          id: "solo",
          name: "Voz de aire",
          body: freeBody,
          lang: freeLang,
          dialectPreset: freeDialect,
          stageX: 0,
        },
      ];
    }
    return scene.characters;
  }, [mode, freeBody, freeLang, freeDialect, scene.characters]);

  return (
    <main className="quimera-app">
      <header className="quimera-header">
        <div>
          <p className="quimera-kicker">CHIMERA · proyecto compañero</p>
          <h1>Quimera</h1>
        </div>
        <p className="quimera-note">
          Estudio de escenas, cuerpos y diálogo vocal físico para CHIMERA.
        </p>
      </header>

      {/* ── 3D Stage Viewport ── */}
      <section
        className={`quimera-stage atmo-${atmosphere}${speaking ? " is-speaking" : ""}`}
        aria-label="Escenario 3D interactivo"
      >
        <div className="quimera-grid" aria-hidden="true" />
        {atmosphere === "spotlight" && <div className="quimera-spotlight" aria-hidden="true" />}

        {/* Floating Scene Controls Toolbar */}
        <div className="quimera-stage-bar">
          {/* Estética aprobada: la malla del cuerpo continua la de la cabeza en modo vocal.
              "head-only" sigue en el esquema para escenas avanzadas; los estilos legacy
              (anatomic/ethereal/mesh) se normalizan a "vocal" al importar. */}
          <div className="quimera-tool-group">
            <span className="quimera-bar-label">Cuerpo:</span>
            <button
              type="button"
              className={`quimera-tool-btn${bodyStyle === "vocal" ? " is-active" : ""}`}
              onClick={() => setBodyStyle("vocal")}
              title="Silueta tenue, línea media y pocas curvas verticales en el azul de la cabeza; cortada en el cuello para dejar la cara limpia"
            >
              Vocal
            </button>
          </div>

          {/* Head look: de las opciones de esta barra, "vocal" es la que articula los labios. */}
          <div className="quimera-tool-group">
            <span className="quimera-bar-label">Cabeza:</span>
            <button
              type="button"
              className={`quimera-tool-btn${headLook === "vocal" ? " is-active" : ""}`}
              onClick={() => setHeadLook("vocal")}
              title="Anatomía de CHIMERA con los labios articulando la voz"
            >
              Vocal
            </button>
          </div>

          {/* Atmosphere */}
          <div className="quimera-tool-group">
            <span className="quimera-bar-label">Atmósfera:</span>
            <button
              type="button"
              className={`quimera-tool-btn${atmosphere === "void" ? " is-active" : ""}`}
              onClick={() => setAtmosphere("void")}
              title="Vacío negro profundo de alto contraste"
            >
              Vacío
            </button>
            <button
              type="button"
              className={`quimera-tool-btn${atmosphere === "grid" ? " is-active" : ""}`}
              onClick={() => setAtmosphere("grid")}
              title="Rejilla cibernética sutil"
            >
              Rejilla
            </button>
            <button
              type="button"
              className={`quimera-tool-btn${atmosphere === "spotlight" ? " is-active" : ""}`}
              onClick={() => setAtmosphere("spotlight")}
              title="Foco de iluminación cenital"
            >
              Foco
            </button>
          </div>

          {/* Camera reset */}
          <div className="quimera-tool-group">
            <span className="quimera-camera-hint"> Arrastrar: rotar · Rueda: zoom</span>
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

        {/* 3D Canvas */}
        <div className="quimera-stage-viewport">
          <RigScene
            ref={rigSceneRef}
            characters={activeCharacters}
            activeCharacterId={activeCharacterId}
            activePosture={activePosture}
            speaking={speaking}
            headLook={headLook}
            bodyStyle={bodyStyle}
            className="quimera-rig-canvas"
          />

          {/* Performer badges */}
          <div className="quimera-cast-labels" aria-hidden="true">
            {activeCharacters.map((c) => (
              <span
                key={c.id}
                style={{ borderColor: activeCharacterId === c.id ? c.color ?? "var(--amber)" : undefined }}
                className={`quimera-performer-badge${activeCharacterId === c.id ? " is-speaking" : ""}`}
              >
                {c.name}
              </span>
            ))}
          </div>
        </div>

        <span className="quimera-stage-caption">
          {speaking
            ? `HABLANDO: ${activeCharacters.find((c) => c.id === activeCharacterId)?.name ?? "PERSONAJE"} · ACTITUD: ${POSTURE_LABELS[activePosture]?.label ?? activePosture}`
            : "EN ESCENA · REPOSO"}
        </span>
      </section>

      {/* ── Main Control Console ── */}
      <section className="quimera-controls" aria-label="Consola de control">
        {/* Navigation Mode Tabs */}
        <div className="quimera-mode-tabs" role="tablist" aria-label="Modo de ejecución">
          <button
            role="tab"
            aria-selected={mode === "scene"}
            className={`quimera-tab${mode === "scene" ? " is-active" : ""}`}
            onClick={() => setMode("scene")}
          >
            Escena & Diálogo
          </button>
          <button
            role="tab"
            aria-selected={mode === "studio"}
            className={`quimera-tab${mode === "studio" ? " is-active" : ""}`}
            onClick={() => setMode("studio")}
          >
            Estudio Creativo
          </button>
          <button
            role="tab"
            aria-selected={mode === "free"}
            className={`quimera-tab${mode === "free" ? " is-active" : ""}`}
            onClick={() => setMode("free")}
          >
            Voz Libre
          </button>
        </div>

        {/* ── 1. Scene Mode (Playback & View) ── */}
        {mode === "scene" && (
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

              <button
                type="button"
                className="quimera-btn-secondary quimera-btn-accent"
                onClick={() => setMode("studio")}
              >
                Editar en Estudio
              </button>
            </div>

            {jsonError && <p className="quimera-error-banner">{jsonError}</p>}

            <ol className="quimera-script">
              {scene.events.map((ev, i) => {
                const isActive = activeEventIndex === i;
                if ("kind" in ev) {
                  return (
                    <li key={i} className={`quimera-beat${isActive ? " is-active" : ""}`}>
                      <span className="quimera-beat-icon"></span>
                      Pausa: {ev.label ?? "silencio"} ({ev.durationS} s)
                    </li>
                  );
                }
                const ch = scene.characters.find((c) => c.id === ev.characterId);
                const postureInfo = ev.posture ? POSTURE_LABELS[ev.posture] : null;
                return (
                  <li key={i} className={`quimera-line${isActive ? " is-active" : ""}`}>
                    <span className="quimera-line-name" style={{ color: ch?.color }}>
                      {ch?.name ?? ev.characterId}
                    </span>
                    <span className="quimera-line-text">{ev.text}</span>
                    {postureInfo && (
                      <span className="quimera-line-tag" title={postureInfo.label}>
                        {postureInfo.icon} {postureInfo.label}
                      </span>
                    )}
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

        {/* ── 2. Studio Mode (Character & Dialogue Creator) ── */}
        {mode === "studio" && (
          <div className="quimera-studio-deck">
            {/* Top Toolbar */}
            <div className="quimera-scene-bar">
              <label>
                Título de la escena
                <input
                  type="text"
                  className="quimera-input-text"
                  value={scene.title}
                  onChange={(e) => setScene((prev) => ({ ...prev, title: e.target.value }))}
                />
              </label>

              <button type="button" className="quimera-btn-secondary" onClick={handleExportJson}>
                Exportar JSON
              </button>

              <button
                type="button"
                className="quimera-btn-secondary quimera-btn-accent"
                onClick={() => setMode("scene")}
              >
                Ver reproducción
              </button>
            </div>

            {/* Studio Columns */}
            <div className="quimera-studio-grid">
              {/* Left Column: Character Roster */}
              <div className="quimera-studio-panel">
                <div className="quimera-panel-header">
                  <h3>Personajes ({scene.characters.length})</h3>
                  <button type="button" className="quimera-btn-small" onClick={addCharacter}>
                    + Añadir personaje
                  </button>
                </div>

                <div className="quimera-character-cards">
                  {scene.characters.map((ch) => (
                    <div
                      key={ch.id}
                      className="quimera-char-card"
                      style={{ borderLeftColor: ch.color ?? "var(--blue)" }}
                    >
                      <div className="quimera-char-card-row">
                        <label className="quimera-field">
                          Nombre
                          <input
                            type="text"
                            value={ch.name}
                            onChange={(e) => updateCharacter(ch.id, { name: e.target.value })}
                          />
                        </label>

                        <label className="quimera-field">
                          Voz
                          <select
                            value={ch.body}
                            onChange={(e) => updateCharacter(ch.id, { body: e.target.value as any })}
                          >
                            <option value="female">Adulto femenino</option>
                            <option value="male">Adulto masculino</option>
                            <option value="child">Infantil</option>
                          </select>
                        </label>

                        {scene.characters.length > 1 && (
                          <button
                            type="button"
                            className="quimera-btn-danger"
                            onClick={() => removeCharacter(ch.id)}
                            title="Eliminar personaje"
                          >
                            ✕
                          </button>
                        )}
                      </div>

                      <div className="quimera-char-card-row">
                        <label className="quimera-field">
                          Dialecto
                          <select
                            value={ch.dialectPreset ?? "neutro"}
                            onChange={(e) =>
                              updateCharacter(ch.id, { dialectPreset: e.target.value as any })
                            }
                          >
                            <option value="neutro">Neutro (latinoam.)</option>
                            <option value="rioplatense">Rioplatense</option>
                            <option value="castellano">Castellano</option>
                          </select>
                        </label>

                        <label className="quimera-field">
                          Tono base ({ch.f0 ?? defaultF0(PRESETS[ch.body])} Hz)
                          <input
                            type="range"
                            min="80"
                            max="300"
                            value={ch.f0 ?? defaultF0(PRESETS[ch.body])}
                            onChange={(e) => updateCharacter(ch.id, { f0: Number(e.target.value) })}
                          />
                        </label>

                        <label className="quimera-field">
                          Posición X ({ch.stageX ?? 0})
                          <input
                            type="range"
                            min="-60"
                            max="60"
                            value={ch.stageX ?? 0}
                            onChange={(e) => updateCharacter(ch.id, { stageX: Number(e.target.value) })}
                          />
                        </label>

                        <label className="quimera-field quimera-field-color">
                          Color
                          <input
                            type="color"
                            value={ch.color ?? "#4fb6f2"}
                            onChange={(e) => updateCharacter(ch.id, { color: e.target.value })}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Right Column: Dialogue & Feelings Editor */}
              <div className="quimera-studio-panel">
                <div className="quimera-panel-header">
                  <h3>Diálogo & Sentimientos ({scene.events.length})</h3>
                  <div className="quimera-panel-actions">
                    <button type="button" className="quimera-btn-small" onClick={addLine}>
                      + Frase
                    </button>
                    <button type="button" className="quimera-btn-small" onClick={addBeat}>
                      + Pausa
                    </button>
                  </div>
                </div>

                <div className="quimera-events-editor">
                  {scene.events.map((ev, i) => {
                    const isLineEvent = !("kind" in ev);
                    return (
                      <div key={i} className={`quimera-editor-row${isLineEvent ? "" : " is-beat-row"}`}>
                        <span className="quimera-row-num">{i + 1}</span>

                        {isLineEvent ? (
                          <div className="quimera-line-editor">
                            <div className="quimera-line-editor-top">
                              {/* Character select */}
                              <select
                                className="quimera-char-select"
                                value={ev.characterId}
                                onChange={(e) =>
                                  updateEvent(i, { ...ev, characterId: e.target.value })
                                }
                              >
                                {scene.characters.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>

                              {/* Feeling / Posture select */}
                              <select
                                className="quimera-posture-select"
                                value={ev.posture ?? "attentive"}
                                onChange={(e) =>
                                  updateEvent(i, { ...ev, posture: e.target.value as any })
                                }
                              >
                                {Object.entries(POSTURE_LABELS).map(([k, meta]) => (
                                  <option key={k} value={k}>
                                    {meta.icon} {meta.label}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <textarea
                              className="quimera-line-textarea"
                              rows={2}
                              value={ev.text}
                              onChange={(e) => updateEvent(i, { ...ev, text: e.target.value })}
                            />
                          </div>
                        ) : (
                          <div className="quimera-beat-editor">
                            <span className="quimera-beat-icon">Pausa:</span>
                            <input
                              type="text"
                              className="quimera-beat-input"
                              value={ev.label ?? "silencio"}
                              placeholder="Etiqueta"
                              onChange={(e) => updateEvent(i, { ...ev, label: e.target.value })}
                            />
                            <label className="quimera-beat-dur">
                              Duración:
                              <input
                                type="number"
                                min="0.1"
                                max="5"
                                step="0.1"
                                value={ev.durationS}
                                onChange={(e) =>
                                  updateEvent(i, { ...ev, durationS: Math.max(0.1, Number(e.target.value)) })
                                }
                              />
                              s
                            </label>
                          </div>
                        )}

                        <div className="quimera-row-tools">
                          <button
                            type="button"
                            className="quimera-btn-icon"
                            disabled={i === 0}
                            onClick={() => moveEvent(i, -1)}
                            title="Subir"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            className="quimera-btn-icon"
                            disabled={i === scene.events.length - 1}
                            onClick={() => moveEvent(i, 1)}
                            title="Bajar"
                          >
                            ▼
                          </button>
                          <button
                            type="button"
                            className="quimera-btn-icon quimera-btn-danger"
                            onClick={() => removeEvent(i)}
                            title="Eliminar"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── 3. Free Voice Mode ── */}
        {mode === "free" && (
          <div className="quimera-free-deck">
            <label className="quimera-text-label" htmlFor="scene-text">
              Texto para sintetizar
            </label>
            <textarea
              id="scene-text"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              rows={2}
            />
            <div className="quimera-options">
              <label>
                Idioma
                <select value={freeLang} onChange={(e) => setFreeLang(e.target.value as Lang)}>
                  <option value="es">Español</option>
                  <option value="en">English</option>
                  <option value="tr">Türkçe</option>
                </select>
              </label>

              {freeLang === "es" && (
                <label>
                  Dialecto
                  <select
                    value={freeDialect}
                    onChange={(e) => setFreeDialect(e.target.value as DialectPreset)}
                  >
                    <option value="neutro">Neutro latinoamericano</option>
                    <option value="rioplatense">Rioplatense (sheísmo, /s/ aspirada)</option>
                    <option value="castellano">Castellano (distinción c/z)</option>
                  </select>
                </label>
              )}

              <label>
                Cuerpo de voz
                <select
                  value={freeBody}
                  onChange={(e) => setFreeBody(e.target.value as keyof typeof PRESETS)}
                >
                  <option value="female">Adulto femenino</option>
                  <option value="male">Adulto masculino</option>
                  <option value="child">Infantil</option>
                </select>
              </label>

              <Chip toggle={false} disabled={!speaking && !freeText.trim()} onClick={() => void playFree()}>
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
        Quimera · estudio de escenas y diálogo para CHIMERA · articulación vocal física original
      </footer>
    </main>
  );
}