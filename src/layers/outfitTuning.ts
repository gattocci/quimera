/**
 * Ajustes en vivo del vidrio de la ropa.
 *
 * Es un store mínimo y sin React: `SceneApp` escribe aquí al mover los sliders y `RigScene` lee
 * cada frame para actualizar uniforms. Así el panel no cambia la identidad de `characters` y no
 * provoca el rebuild de la escena. Los mismos valores se guardan en `layers.outfit` del JSON; al
 * cargar una escena, `RigScene` siembra este store desde ese JSON.
 */

export interface OutfitTuning {
  /** Alpha del relleno central del vidrio. */
  fill: number;
  /** Ganancia del fresnel: cuánto sube el alpha hacia la silueta. */
  edgeGain: number;
  /** Alpha de silueta, curvas, costuras y pliegues. */
  lineAlpha: number;
  /** Alpha del revés (caras traseras) dibujado antes del prepass. */
  backAlpha: number;
  /** Desplazamiento de la tela a lo largo de la normal, en cm. */
  offset: number;
}

export type OutfitTuningKey = keyof OutfitTuning;

/** Rangos compartidos por el panel, la validación del JSON y el clamp del store. */
export const OUTFIT_TUNING_RANGES: Record<OutfitTuningKey, { min: number; max: number }> = {
  fill: { min: 0, max: 0.5 },
  edgeGain: { min: 0, max: 2 },
  lineAlpha: { min: 0, max: 1 },
  backAlpha: { min: 0, max: 0.6 },
  offset: { min: 0.6, max: 2 },
};

/** Punto de partida del estilo tenue. */
export const OUTFIT_TUNING_DEFAULTS: OutfitTuning = {
  fill: 0.1,
  edgeGain: 1.6,
  lineAlpha: 0.35,
  backAlpha: 0.25,
  offset: 1.1,
};

const KEYS = Object.keys(OUTFIT_TUNING_RANGES) as OutfitTuningKey[];

function sanitize(value: number | undefined, key: OutfitTuningKey): number | undefined {
  if (value === undefined || typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const { min, max } = OUTFIT_TUNING_RANGES[key];
  return Math.min(max, Math.max(min, value));
}

/** Defaults globales (sembrados por los parámetros de URL en DEV). */
let defaults: OutfitTuning = { ...OUTFIT_TUNING_DEFAULTS };
/** Valores por personaje; lo que haya aquí gana a `defaults`. */
const perCharacter = new Map<string, OutfitTuning>();

/** Solo lo usa `outfit.ts` al leer los parámetros de URL en desarrollo. */
export function seedOutfitTuningDefaults(patch: Partial<OutfitTuning>): void {
  const next = { ...defaults };
  for (const key of KEYS) {
    const value = sanitize(patch[key], key);
    if (value !== undefined) next[key] = value;
  }
  defaults = next;
}

export function getOutfitTuning(id: string): OutfitTuning {
  return { ...(perCharacter.get(id) ?? defaults) };
}

/** Los campos `undefined` se ignoran: sirve para pasar solo lo que trae el JSON. */
export function setOutfitTuning(id: string, patch: Partial<OutfitTuning>): OutfitTuning {
  const current = perCharacter.get(id) ?? defaults;
  const next = { ...current };
  for (const key of KEYS) {
    const value = sanitize(patch[key], key);
    if (value !== undefined) next[key] = value;
  }
  perCharacter.set(id, next);
  return { ...next };
}

/** Si el JSON de la escena no trae ajustes, vuelve a los defaults (URL o constants). */
export function resetOutfitTuning(id: string): OutfitTuning {
  perCharacter.delete(id);
  return { ...defaults };
}
