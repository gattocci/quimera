/**
 * ScenePlayer — runs a Scene: speaks each line through CHIMERA, waits between lines,
 * and reports back which event and character is active so the UI and 3D rig can adapt.
 */
import { PRESETS, defaultF0 } from "@chimera/ui/body.ts";
import { speakText, speakingNow, stopSpeaking } from "@chimera/ui/speech.ts";
import { DIALECT_PRESETS } from "@chimera/wasm/engine.ts";
import { useStore } from "@chimera/ui/store.ts";
import { isLine, isBeat, lineVoiceParams, getCharacter, type Scene, type PostureHint } from "./scene.ts";

const SLEEP = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const FRAME = 40; // ms between speakingNow() polls

export class ScenePlayer {
  private token = 0;
  onProgress: (
    eventIndex: number | null,
    activeCharacterId: string | null,
    posture?: PostureHint
  ) => void = () => {};

  constructor(private readonly scene: Scene) {}

  async play(): Promise<void> {
    const myToken = ++this.token;
    const events = this.scene.events;

    // ensure audio engine is started before the first line
    const state = useStore.getState();
    await state.start();

    for (let i = 0; i < events.length; i++) {
      if (this.token !== myToken) return;

      const ev = events[i];

      if (isBeat(ev)) {
        this.onProgress(i, null, "neutral");
        await SLEEP(ev.durationS * 1000);
        continue;
      }

      if (!isLine(ev)) continue;

      this.onProgress(i, ev.characterId, ev.posture ?? "attentive");

      // pauseBefore
      if (ev.pauseBefore && ev.pauseBefore > 0) await SLEEP(ev.pauseBefore * 1000);
      if (this.token !== myToken) return;

      const ch = getCharacter(this.scene, ev.characterId);
      const { lang, dialectPreset } = lineVoiceParams(this.scene, ev);
      const body = PRESETS[ch.body];
      const f0 = ch.f0 ?? defaultF0(body);

      state.setBody(body);
      state.setSource({ f0 });

      const dialect = lang === "es" && dialectPreset ? DIALECT_PRESETS[dialectPreset] : undefined;
      const plan = await speakText(ev.text, { ipa: false, lang, dialect, body, rate: 1, f0 });

      if (plan && this.token === myToken) {
        while (this.token === myToken && speakingNow()) await SLEEP(FRAME);
      }
    }

    if (this.token === myToken) this.onProgress(null, null, "neutral");
  }

  stop(): void {
    this.token++;
    stopSpeaking();
    this.onProgress(null, null, "neutral");
  }
}
