import { useRef, useState } from "react";
import { AnatomyView3D } from "@chimera/ui/components/AnatomyView3D.tsx";
import { PRESETS, defaultF0 } from "@chimera/ui/body.ts";
import { speakText, speakingNow, stopSpeaking } from "@chimera/ui/speech.ts";
import { useStore } from "@chimera/ui/store.ts";
import { Chip } from "@chimera/ui/components/Screen.tsx";
import type { Lang } from "@chimera/wasm/types.ts";

const view = { pressure: true, particles: true, grid: false, calipers: false };

export function SceneApp() {
  const [text, setText] = useState("Hola. Soy una voz hecha de aire.");
  const [lang, setLang] = useState<Lang>("es");
  const [body, setBody] = useState<keyof typeof PRESETS>("female");
  const [speaking, setSpeaking] = useState(false);
  const run = useRef(0);
  const started = useStore((s) => s.started);

  const play = async () => {
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
      const plan = await speakText(text, { ipa: false, lang, body: voice, rate: 1, f0: defaultF0(voice) });
      if (plan) {
        while (run.current === token && speakingNow()) await new Promise((resolve) => window.setTimeout(resolve, 40));
      }
    } finally {
      if (run.current === token) setSpeaking(false);
    }
  };

  return (
    <main className="quimera-app">
      <header className="quimera-header">
        <div>
          <p className="quimera-kicker">CHIMERA · proyecto compañero</p>
          <h1>Quimera</h1>
        </div>
        <p className="quimera-note">La cabeza y la voz siguen siendo CHIMERA. La escena añade el cuerpo.</p>
      </header>

      <section className={`quimera-stage${speaking ? " is-speaking" : ""}`} aria-label="Escena">
        <div className="quimera-grid" aria-hidden="true" />
        <div className="quimera-performer">
          <div className="quimera-head"><AnatomyView3D view={view} readouts={false} /></div>
          <div className="quimera-neck" />
          <div className="quimera-body" aria-label="Cuerpo estilizado del personaje">
            <span className="quimera-shoulders" />
            <span className="quimera-torso" />
          </div>
          <span className="quimera-name">Voz de aire</span>
        </div>
        <span className="quimera-stage-caption">{speaking ? "HABLANDO · ARTICULACIÓN CHIMERA" : "EN ESCENA · EN REPOSO"}</span>
      </section>

      <section className="quimera-controls" aria-label="Controles del prototipo">
        <label className="quimera-text-label" htmlFor="scene-text">Texto</label>
        <textarea id="scene-text" value={text} onChange={(event) => setText(event.target.value)} rows={2} />
        <div className="quimera-options">
          <label>Idioma
            <select value={lang} onChange={(event) => setLang(event.target.value as Lang)}>
              <option value="es">Español</option>
              <option value="en">English</option>
              <option value="tr">Türkçe</option>
            </select>
          </label>
          <label>Cuerpo
            <select value={body} onChange={(event) => setBody(event.target.value as keyof typeof PRESETS)}>
              <option value="female">Adulto · preset femenino</option>
              <option value="male">Adulto · preset masculino</option>
              <option value="child">Infantil</option>
            </select>
          </label>
          <Chip toggle={false} disabled={!speaking && !text.trim()} onClick={() => void play()}>
            {speaking ? "Detener" : "Hablar"}
          </Chip>
          <span className="quimera-status" aria-live="polite">{started ? "Audio listo" : "El audio empieza al pulsar Hablar"}</span>
        </div>
      </section>

      <footer className="quimera-footer">
        Prototipo inicial · voz, tracto y lip-sync sin modificar · cuerpo experimental independiente
      </footer>
    </main>
  );
}
