/**
 * Quimera scene format — serializable description of a scene and its performers.
 *
 * Capabilities:
 * - Full character customization (voice body, base pitch f0, dialect, accent color, stageX, bodyStyle,
 *   optional `layers` for hair/outfit line-fields — schema only, not rendered yet).
 * - Rich dialogue lines with posture/feeling hints and precise pause/beat timings.
 * - Global stage appearance:
 *     * bodyStyle: "vocal" (ghost silhouette + midline + sparse vertical contours), "head-only".
 *       Legacy "anatomic" / "ethereal" / "mesh" are normalized to "vocal" on import.
 *     * atmosphere: "void", "grid", "spotlight".
 */

import type { Lang, DialectPreset } from "@chimera/wasm/engine.ts";
import type { BodyName } from "@chimera/wasm/../../src/worklet/protocol.ts";

// ──────────────────────────────────────────── types ──────────────────────────

export type BodyPreset = BodyName; // "male" | "female" | "child"

/** Presentación del cuerpo en escena.
 *
 * El estilo aprobado es `vocal`: un cuerpo base "fantasma" en el azul de CHIMERA —silueta fina,
 * línea media con acento rosa/rojo y pocas curvas verticales de contorno— cortado en el borde del
 * cuello para dejar la cara limpia. Es la capa base: pelo y ropa se agregan encima (ver
 * `CharacterLayers`). `head-only` sigue disponible para escenas avanzadas que quieran solo la cabeza; los demás
 * valores son legacy y `validateScene()` los normaliza a `vocal` al importar.
 */
export type BodyStyle =
  | "vocal"
  | "head-only"
  /** @deprecated Legacy: anillos de contorno. Se normaliza a `vocal` al importar. */
  | "anatomic"
  /** @deprecated Legacy: silueta etérea. Se normaliza a `vocal` al importar. */
  | "ethereal"
  /** @deprecated Legacy: malla técnica del rig. Se normaliza a `vocal` al importar. */
  | "mesh";

/** Stage visual atmosphere / backdrop. */
export type StageAtmosphere = "void" | "grid" | "spotlight";

/**
 * Capas agregadas sobre el cuerpo base. Cada capa es un campo de líneas finas (misma familia que
 * la cabeza), con su propia dirección, densidad y color de acento.
 *
 * Solo esquema por ahora: el renderer todavía no las dibuja. Se validan para que los JSON ya
 * puedan declararlas sin romperse cuando se implementen.
 */
export type BodyLayerName = "hair" | "outfit";

export interface BodyLayer {
  /** Si es false la capa existe pero no se dibuja. Por defecto true. */
  enabled?: boolean;
  /** Color de acento en hex; si falta se usa el `color` del personaje. */
  color?: string;
  /** Densidad relativa de líneas, 0 a 1 (por defecto 0.5). */
  density?: number;
  /** Identificador de variante dentro de la capa (ej. "long", "tunic"). */
  variant?: string;
}

export type CharacterLayers = Partial<Record<BodyLayerName, BodyLayer>>;

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
  /** Capas agregadas sobre el cuerpo base (pelo, ropa). Opcional; aún sin render. */
  layers?: CharacterLayers;
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

const LAYER_NAMES = ["hair", "outfit"] as const;

function validateLayers(value: unknown, where: string): CharacterLayers | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where}: 'layers' debe ser un objeto.`);
  }
  const out: CharacterLayers = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!LAYER_NAMES.includes(name as BodyLayerName)) {
      throw new Error(`${where}: capa desconocida "${name}". Opciones: ${LAYER_NAMES.join(", ")}.`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${where}: la capa "${name}" debe ser un objeto.`);
    }
    const l = raw as BodyLayer;
    if (l.enabled !== undefined && typeof l.enabled !== "boolean") {
      throw new Error(`${where}: "${name}.enabled" debe ser booleano.`);
    }
    if (l.color !== undefined && (typeof l.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(l.color))) {
      throw new Error(`${where}: "${name}.color" debe ser un hex tipo #4fb6f2.`);
    }
    if (l.density !== undefined && (typeof l.density !== "number" || l.density < 0 || l.density > 1)) {
      throw new Error(`${where}: "${name}.density" debe estar entre 0 y 1.`);
    }
    if (l.variant !== undefined && typeof l.variant !== "string") {
      throw new Error(`${where}: "${name}.variant" debe ser texto.`);
    }
    out[name as BodyLayerName] = l;
  }
  return out;
}

const BODY_STYLES = ["vocal", "head-only", "anatomic", "ethereal", "mesh"] as const;
const LEGACY_BODY_STYLES = new Set<string>(["anatomic", "ethereal", "mesh"]);

/**
 * Estilos legacy de escenas anteriores. Se aceptan al leer para no romper archivos guardados, pero
 * nunca se conservan: la estética aprobada siempre se guarda como `vocal`.
 */
function normalizeBodyStyle(value: unknown, where: string): BodyStyle | undefined {
  if (value === undefined) return undefined;
  if (!BODY_STYLES.includes(value as (typeof BODY_STYLES)[number])) {
    throw new Error(`${where}: estilo de cuerpo desconocido "${String(value)}". Opciones: vocal, head-only.`);
  }
  return LEGACY_BODY_STYLES.has(value as string) ? "vocal" : (value as BodyStyle);
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
    c.bodyStyle = normalizeBodyStyle(c.bodyStyle, `Personaje "${c.id}"`);
    c.layers = validateLayers(c.layers, `Personaje "${c.id}"`);
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

  d.stageBodyStyle = normalizeBodyStyle(d.stageBodyStyle, "Escena");

  return d as Scene;
}

// ──────────────────────────────────────────── presets ────────────────────────

/** Diálogo expresivo a dos voces con sentimientos e intenciones. */
export const DIALOGUE_SCENE: Scene = {
  version: 1,
  title: "Diálogo: Aria & Dante",
  stageBodyStyle: "vocal",
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
      text: "Hola Dante. ¿Notás cómo la línea de la cabeza sigue por el cuerpo sin recargar la imagen?",
      posture: "curious",
    },
    { kind: "beat", label: "pausa reflexiva", durationS: 0.5 },
    {
      characterId: "dante",
      text: "Totalmente. Mismo azul, misma línea: el cuerpo es apenas una silueta y no tapa la anatomía.",
      posture: "agreement",
    },
    { kind: "beat", label: "pausa", durationS: 0.4 },
    {
      characterId: "aria",
      text: "Sin mallas ni relleno pesado, la voz y el tracto vocal siguen siendo los protagonistas.",
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
  stageBodyStyle: "vocal",
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
      text: "Mi cuerpo es una línea tenue que acompaña a mi cabeza; la voz sigue siendo el centro.",
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