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

// ──────────────────────────────────────────── example ────────────────────────

/** A minimal built-in demo scene for the prototype. */
export const DEMO_SCENE: Scene = {
  version: 1,
  title: "Presentación",
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
    { kind: "beat", label: "pausa", durationS: 0.6 },
    {
      characterId: "aria",
      text: "El cuerpo es nuevo. La voz sigue siendo la misma.",
      posture: "gesturing",
    },
  ],
};
