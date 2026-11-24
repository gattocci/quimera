/**
 * Capa de pelo. Contrato reservado para el siguiente mensaje: aquí solo se define la interfaz y un
 * handle vacío para que `RigScene` monte todas las capas de la misma manera. El pelo NO se dibuja
 * todavía; la ropa es la primera capa implementada (ver `outfit.ts`).
 *
 * Cuando se implemente, usará `LAYER_UTILS_GLSL` y `makeLayerMesh()` de `common.ts`, con recorte en
 * `aRest` por encima del cuello y sin tocar nunca la cara ni la boca.
 */

import type * as THREE from "three";
import { layerHandle, type LayerHandle } from "./common.ts";

export interface HairSpec {
  variant?: "short" | "long";
  enabled?: boolean;
  color?: string;
  length?: number;
  density?: number;
  seed?: number;
}

/**
 * Devuelve un handle sin meshes: la capa está activa en el esquema pero aún no tiene renderer.
 */
export function createHairLayer(parent: THREE.Group, _spec: HairSpec | undefined): LayerHandle {
  return layerHandle(parent, [], []);
}
