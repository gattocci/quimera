/**
 * Quimera scene format — serializable description of a scene and its performers.
 *
 * Capabilities:
 * - Full character customization (voice body, base pitch f0, dialect, accent color, stageX, bodyStyle).
 * - Rich dialogue lines with posture/feeling hints and precise pause/beat timings.
 * - Global stage appearance:
 *     * bodyStyle: "anatomic" (contour rings matching the head), "head-only", "ethereal", "mesh".
 *     * atmosphere: "void", "grid", "spotlight".
 */

import type { Lang, DialectPreset } from "@chimera/wasm/engine.ts";
import type { BodyName } from "@chimera/wasm/../../src/worklet/protocol.ts";

// ──────────────────────────────────────────── types ──────────────────────────

export type BodyPreset = BodyName; // "male" | "female" | "child"

/** Body presentation style:
 * - "anatomic": Horizontal contour slice rings matching the exact aesthetic of the CHIMERA head.
 * - "head-only": Standalone floating head with zero body clutter.
 * - "ethereal": Faint translucent contour silhouette.
 * - "mesh": Full technical quad wireframe rig.
 */
export type BodyStyle = "anatomic" | "head-only" | "ethereal" | "mesh";

/** Stage visual atmosphere / backdrop. */
export type StageAtmosphere = "void" | "grid" | "spotlight";

/** A character defined in the scene roster. */
export interface Character {
  /** Unique within the scene. */
  id: string;
  /** Display name shown in the scene. */
  name: string;
  body: BodyPreset;
  /** Language and dialect used when speaking. */
  lang: Lang;
  dialectPreset?: DialectPreset;
  /** Custom baseline pitch in Hz (optional). */
  f0?: number;
  /** Accent color in hex for visual distinction (e.g. #4fb6f2, #ffb347). */
  color?: string;
  /** Position on stage X-axis in body cm (-80 to 80). */
  stageX?: number;
  /** Custom body style per character (overrides scene default if set). */
  bodyStyle?: BodyStyle;
}

/** Posture and emotion hints for performers. */
export type PostureHint =
  | "neutral"
  | "attentive"
  | "relaxed"
  | "gesturing"
  | "curious"
  | "emphatic"
  | "thoughtful"
  | "agreement";

/** A single line of dialogue assigned to a character. */
export interface SceneLine {
  characterId: string;
  text: string;
  /** Override the character's default language for this line only. */
  lang?: Lang;
  dialectPreset?: DialectPreset;
  /** Emotional posture or attitude during this line. */
  posture?: PostureHint;
  /** Pause (seconds) to wait before speaking this line. */
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
  stageBodyStyle?: BodyStyle;
  stageAtmosphere?: StageAtmosphere;
  characters: Character[];
  events: SceneEvent[];
}

// ──────────────────────────────────────────── helpers ────────────────────────

export function isLine(e: SceneEvent): e is SceneLine {
  return !("kind" in e);
}

export function isBeat(e: SceneEvent): e is SceneBeat {
  return "kind" in e && e.kind === "beat";
}

export function getCharacter(scene: Scene, id: string): Character {
  const ch = scene.characters.find((c) => c.id === id);
  if (!ch) throw new Error(`Scene: unknown character "${id}"`);
  return ch;
}

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

/** Diálogo expresivo a dos voces con sentimientos e intenciones. */
export const DIALOGUE_SCENE: Scene = {
  version: 1,
  title: "Diálogo: Aria & Dante",
  stageBodyStyle: "anatomic",
  stageAtmosphere: "void",
  characters: [
    {
      id: "aria",
      name: "Aria",
      body: "female",
      lang: "es",
      dialectPreset: "neutro",
      f0: 210,
      color: "#4fb6f2",
      stageX: -46,
    },
    {
      id: "dante",
      name: "Dante",
      body: "male",
      lang: "es",
      dialectPreset: "rioplatense",
      f0: 115,
      color: "#ffb347",
      stageX: 46,
    },
  ],
  events: [
    {
      characterId: "aria",
      text: "Hola Dante. ¿Notás lo limpios que se ven ahora nuestros cuerpos de contorno?",
      posture: "curious",
    },
    { kind: "beat", label: "pausa reflexiva", durationS: 0.5 },
    {
      characterId: "dante",
      text: "Totalmente. Los anillos del cuerpo continúan la misma anatomía que la cabeza.",
      posture: "agreement",
    },
    { kind: "beat", label: "pausa", durationS: 0.4 },
    {
      characterId: "aria",
      text: "Sin cuadrículas pesadas, la voz y el tracto vocal siguen siendo los protagonistas.",
      posture: "gesturing",
    },
    { kind: "beat", label: "pausa", durationS: 0.4 },
    {
      characterId: "dante",
      text: "Y al respirar y mirarnos, todo el conjunto se mueve en armonía.",
      posture: "emphatic",
    },
  ],
};

/** Soliloquio expresivo individual. */
export const SOLILOQUY_SCENE: Scene = {
  version: 1,
  title: "Soliloquio: Aria",
  stageBodyStyle: "anatomic",
  stageAtmosphere: "spotlight",
  characters: [
    {
      id: "aria",
      name: "Aria",
      body: "female",
      lang: "es",
      dialectPreset: "neutro",
      f0: 205,
      color: "#4fb6f2",
      stageX: 0,
    },
  ],
  events: [
    {
      characterId: "aria",
      text: "Hola. Soy una voz hecha de aire y resonancia.",
      posture: "attentive",
    },
    { kind: "beat", label: "silencio", durationS: 0.5 },
    {
      characterId: "aria",
      text: "Mi cuerpo y mi cabeza ahora comparten el mismo dibujo de contornos anatómicos.",
      posture: "curious",
    },
    { kind: "beat", label: "silencio", durationS: 0.4 },
    {
      characterId: "aria",
      text: "Toda la física vocal proviene íntegra de CHIMERA.",
      posture: "thoughtful",
    },
  ],
};

export const DEMO_SCENE = DIALOGUE_SCENE;
