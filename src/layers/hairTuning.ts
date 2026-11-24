/**
 * Ajustes en vivo del pelo.
 *
 * Es un store mínimo y sin React, igual que `outfitTuning.ts`: `SceneApp` escribe aquí al mover los
 * sliders y `RigScene` lee cada frame para actualizar uniforms y la geometría de líneas. Así el panel
 * no cambia la identidad de `characters` y no provoca el rebuild de la escena. Los mismos valores se
 * guardan en `layers.hair` del JSON; al cargar una escena, `RigScene` siembra este store desde ahí.
 *
 * `hairDebugView` NO se persiste: es una ayuda de diagnóstico del editor (todo / guías / hijas /
 * contorno), no parte de la escena exportable.
 */

/** Extremos del degradado por hebra, en color lineal calculado por `hair.ts`. */
export const HAIR_COLOR_LOW = "#cdb98a";
export const HAIR_COLOR_HIGH = "#fff0c8";

export interface HairTuning {
  /** Densidad relativa: 600..3000 hijas y 30..`guideCount` guías. */
  density: number;
  /** Largo relativo dentro de la variante (corto o largo). */
  length: number;
  /** Barrido lateral: −1 a la izquierda, 0 simétrico, +1 a la derecha. */
  sweep: number;
  /** Alpha de cada hebra antes de la caída hacia la punta. */
  strandAlpha: number;
  /** Alpha de las líneas de contorno del volumen. */
  contourAlpha: number;
  /** Alpha del núcleo tenue que da masa sobre cada guía. */
  bodyAlpha: number;
  /** Ganancia del balanceo inducido por la velocidad angular de cabeza y torso. */
  sway: number;
  /** Dispersión lateral mínima entre hijas, en cm (0.6..1.8). */
  spread: number;
  /** Cuánto se acerca cada hija a su guía más cercana: 0 = 30 %, 1 = 60 %. */
  clump: number;
  /** Guías objetivo con density = 1 (30..70). */
  guideCount: number;
  /** Color base del pelo en hex; el degradado se deriva de este valor. */
  color: string;
}

export type HairNumericKey = Exclude<keyof HairTuning, "color">;

/** Rangos compartidos por el panel y por `validateScene()`. */
export const HAIR_TUNING_RANGES: Record<HairNumericKey, { min: number; max: number }> = {
  density: { min: 0, max: 1 },
  length: { min: 0, max: 1 },
  sweep: { min: -1, max: 1 },
  strandAlpha: { min: 0, max: 1 },
  contourAlpha: { min: 0, max: 1 },
  bodyAlpha: { min: 0, max: 0.3 },
  sway: { min: 0, max: 2 },
  spread: { min: 0.6, max: 1.8 },
  clump: { min: 0, max: 1 },
  guideCount: { min: 30, max: 70 },
};

/** Punto de partida: translúcido, hebras separadas, casi sin masa. */
export const HAIR_TUNING_DEFAULTS: HairTuning = {
  density: 0.5,
  length: 0.5,
  sweep: 0,
  strandAlpha: 0.14,
  contourAlpha: 0.7,
  bodyAlpha: 0.03,
  sway: 1,
  spread: 1.0,
  clump: 0.5,
  guideCount: 70,
  color: "#e6cf9a",
};

const KEYS = Object.keys(HAIR_TUNING_RANGES) as HairNumericKey[];

function sanitize(key: HairNumericKey, value: number | undefined): number | undefined {
  if (value === undefined || typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const { min, max } = HAIR_TUNING_RANGES[key];
  return Math.min(max, Math.max(min, value));
}

function sanitizeColor(value: string | undefined): string | undefined {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
}

/** Defaults globales (por si en el futuro se siembran desde la URL, como la ropa). */
let defaults: HairTuning = { ...HAIR_TUNING_DEFAULTS };
/** Valores por personaje; lo que haya aquí gana a `defaults`. */
const perCharacter = new Map<string, HairTuning>();

export function seedHairTuningDefaults(patch: Partial<HairTuning>): void {
  const next = { ...defaults };
  for (const key of KEYS) {
    const value = sanitize(key, patch[key]);
    if (value !== undefined) next[key] = value;
  }
  const color = sanitizeColor(patch.color);
  if (color !== undefined) next.color = color;
  defaults = next;
}

export function getHairTuning(id: string): HairTuning {
  return { ...(perCharacter.get(id) ?? defaults) };
}

/** Los campos `undefined` se ignoran: sirve para pasar solo lo que trae el JSON. */
export function setHairTuning(id: string, patch: Partial<HairTuning>): HairTuning {
  const current = perCharacter.get(id) ?? defaults;
  const next = { ...current };
  for (const key of KEYS) {
    const value = sanitize(key, patch[key]);
    if (value !== undefined) next[key] = value;
  }
  const color = sanitizeColor(patch.color);
  if (color !== undefined) next.color = color;
  perCharacter.set(id, next);
  return { ...next };
}

/** Si el JSON de la escena no trae ajustes, vuelve a los defaults. */
export function resetHairTuning(id: string): HairTuning {
  perCharacter.delete(id);
  return { ...defaults };
}

// ── Diagnóstico del editor (no persistente) ────────────────────────────────
export type HairDebugView = "all" | "guides" | "daughters" | "contour";
export const HAIR_DEBUG_VIEWS: readonly HairDebugView[] = ["all", "guides", "daughters", "contour"];

let debugView: HairDebugView = "all";

export function getHairDebugView(): HairDebugView {
  return debugView;
}

export function setHairDebugView(view: HairDebugView): HairDebugView {
  if (HAIR_DEBUG_VIEWS.includes(view)) debugView = view;
  return debugView;
}
