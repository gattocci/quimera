/**
 * Quimera scene format — a minimal, serializable description of a scene.
 *
 * Rules:
 * - Everything here stays in Quimera scope: no CHIMERA internals leak into this schema.
 * - The scene describes *who speaks* and *when*; it does not rewrite phonetics or prosody.
 * - Body presets and dialogue are the two moving parts at this stage.
 * - Action timing is scene-relative (seconds). Exact voice timing comes from CHIMERA's planner;
 *   the scene player must not compute duration from character count.
 *
 * Version is a plain integer bumped on every breaking schema change.
 */

import type { Lang, DialectPreset } from "@chimera/wasm/engine.ts";
import type { BodyName } from "@chimera/wasm/../../src/worklet/protocol.ts";

// ──────────────────────────────────────────── types ──────────────────────────

/** Which body preset a character uses for their voice and rig. */
export type BodyPreset = BodyName; // "male" | "female" | "child"

/** A character defined in the scene roster. */
export interface Character {
  /** Unique within the scene. */
  id: string;
  /** Display name shown in the scene. */
  name: string;
  body: BodyPreset;
  /** Language and dialect used when speaking (overridden per line if set there). */
  lang: Lang;
  dialectPreset?: DialectPreset;
}

/** Broad body posture hint for the rig while speaking or idle. */
export type PostureHint = "neutral" | "attentive" | "relaxed" | "gesturing";

/** A single line of dialogue assigned to a character. */
export interface SceneLine {
  characterId: string;
  text: string;
  /** Override the character's default language for this line only. */
  lang?: Lang;
  dialectPreset?: DialectPreset;
  /** Desired posture during this line (rig uses it as a hint for the pose). */
  posture?: PostureHint;
  /** Pause (seconds) to wait before speaking this line (after the previous one ends). */
  pauseBefore?: number;
}

/** A beat of silence between sections with an optional label. */
export interface SceneBeat {
  kind: "beat";
  label?: string;
  durationS: number;
}

export type SceneEvent = SceneLine | SceneBeat;

/** The root scene document. */
export interface Scene {
  version: 1;
  title: string;
  characters: Character[];
  events: SceneEvent[];
}

// ──────────────────────────────────────────── helpers ────────────────────────

/** Type guard: tells a SceneLine from a SceneBeat. */
export function isLine(e: SceneEvent): e is SceneLine {
  return !("kind" in e);
}

/** Type guard: tells a SceneBeat from a SceneLine. */
export function isBeat(e: SceneEvent): e is SceneBeat {
  return "kind" in e && e.kind === "beat";
}

/** Look up a character by id; throws if not found. */
export function getCharacter(scene: Scene, id: string): Character {
  const ch = scene.characters.find((c) => c.id === id);
  if (!ch) throw new Error(`Scene: unknown character "${id}"`);
  return ch;
}

/** Resolve the language and dialect for a line (line > character defaults). */
export function lineVoiceParams(scene: Scene, line: SceneLine): {
  lang: Lang;
  dialectPreset: DialectPreset | undefined;
} {
  const ch = getCharacter(scene, line.characterId);
  return {
    lang: line.lang ?? ch.lang,
    dialectPreset: line.dialectPreset ?? ch.dialectPreset,
  };
}

/**
 * Validates untrusted parsed JSON data as a valid Scene.
 * Throws a descriptive Error if validation fails.
 */
export function validateScene(data: unknown): Scene {
  if (!data || typeof data !== "object") {
    throw new Error("El documento de escena debe ser un objeto JSON válido.");
  }

  const d = data as Partial<Scene>;

  if (d.version !== 1) {
    throw new Error(`Versión de escena no compatible: ${String(d.version)}. Se requiere versión 1.`);
  }

  if (typeof d.title !== "string" || !d.title.trim()) {
    throw new Error("La escena debe tener un campo 'title' de tipo texto no vacío.");
  }

  if (!Array.isArray(d.characters) || d.characters.length === 0) {
    throw new Error("La escena debe incluir al menos un personaje en 'characters'.");
  }

  const characterIds = new Set<string>();
  for (const c of d.characters) {
    if (!c || typeof c !== "object") throw new Error("Cada personaje debe ser un objeto.");
    if (typeof c.id !== "string" || !c.id.trim()) throw new Error("Cada personaje debe tener un 'id' único.");
    if (characterIds.has(c.id)) throw new Error(`ID de personaje duplicado: "${c.id}".`);
    characterIds.add(c.id);

    if (typeof c.name !== "string" || !c.name.trim()) throw new Error(`El personaje "${c.id}" debe tener un 'name'.`);
    if (!["male", "female", "child"].includes(c.body)) {
      throw new Error(`Cuerpo inválido "${String(c.body)}" en personaje "${c.id}". Opciones: male, female, child.`);
    }
  }

  if (!Array.isArray(d.events)) {
    throw new Error("La escena debe tener una lista de 'events'.");
  }

  for (let i = 0; i < d.events.length; i++) {
    const ev = d.events[i];
    if (!ev || typeof ev !== "object") throw new Error(`Evento #${i + 1} no válido.`);

    if ("kind" in ev && ev.kind === "beat") {
      if (typeof ev.durationS !== "number" || ev.durationS < 0) {
        throw new Error(`Pausa en evento #${i + 1} debe tener una duración 'durationS' numérica positiva.`);
      }
    } else {
      const line = ev as Partial<SceneLine>;
      if (typeof line.characterId !== "string" || !characterIds.has(line.characterId)) {
        throw new Error(`Evento #${i + 1}: personaje desconocido "${String(line.characterId)}".`);
      }
      if (typeof line.text !== "string" || !line.text.trim()) {
        throw new Error(`Evento #${i + 1}: la línea debe contener un 'text' no vacío.`);
      }
    }
  }

  return d as Scene;
}

// ──────────────────────────────────────────── presets ────────────────────────

/** Escena 1: Diálogo entre dos personajes con dialectos y posturas diferentes. */
export const DIALOGUE_SCENE: Scene = {
  version: 1,
  title: "Diálogo: Aria & Dante",
  characters: [
    {
      id: "aria",
      name: "Aria",
      body: "female",
      lang: "es",
      dialectPreset: "neutro",
    },
    {
      id: "dante",
      name: "Dante",
      body: "male",
      lang: "es",
      dialectPreset: "rioplatense",
    },
  ],
  events: [
    {
      characterId: "aria",
      text: "Hola Dante. Qué bueno verte en el escenario.",
      posture: "attentive",
    },
    { kind: "beat", label: "pausa", durationS: 0.5 },
    {
      characterId: "dante",
      text: "Hola Aria. Escuchá cómo suenan nuestras voces en escena.",
      posture: "gesturing",
    },
    { kind: "beat", label: "pausa", durationS: 0.4 },
    {
      characterId: "aria",
      text: "Cada uno con su cuerpo y su entonación natural.",
      posture: "relaxed",
    },
    { kind: "beat", label: "pausa", durationS: 0.4 },
    {
      characterId: "dante",
      text: "Y al terminar la frase, ambos volvemos al reposo.",
      posture: "attentive",
    },
  ],
};

/** Escena 2: Soliloquio individual. */
export const SOLILOQUY_SCENE: Scene = {
  version: 1,
  title: "Soliloquio: Aria",
  characters: [
    {
      id: "aria",
      name: "Aria",
      body: "female",
      lang: "es",
      dialectPreset: "neutro",
    },
  ],
  events: [
    {
      characterId: "aria",
      text: "Hola. Soy una voz hecha de aire.",
      posture: "attentive",
    },
    { kind: "beat", label: "pausa", durationS: 0.5 },
    {
      characterId: "aria",
      text: "El cuerpo ahora se mueve en tres dimensiones mientras hablo.",
      posture: "gesturing",
    },
    { kind: "beat", label: "pausa", durationS: 0.4 },
    {
      characterId: "aria",
      text: "Todo el sonido y los articuladores provienen directamente de CHIMERA.",
      posture: "relaxed",
    },
  ],
};

/** Escena por defecto al abrir la aplicación. */
export const DEMO_SCENE = DIALOGUE_SCENE;
