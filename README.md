# Quimera

Experimento compañero para construir escenas y personajes alrededor de CHIMERA. CHIMERA conserva
el motor de voz y su cabeza completa, incluido el tracto vocal animado y el lip-sync. Este proyecto
añade el escenario, el cuerpo sencillo y la orquestación visual.

La primera prueba es intencionadamente pequeña: un personaje, un cuerpo estilizado, texto leído
por CHIMERA y un gesto corporal sutil mientras habla. No cambia pronunciación, planificación,
articulación ni síntesis.

## Empezar

Requisitos: Git con soporte para submódulos, Bun, Rust con `wasm32-unknown-unknown` y una ventana
con WebGL habilitado.

```sh
git clone --recurse-submodules <URL-DE-ESTE-REPO> quimera
cd quimera
bun install
bun run dev
```

Si ya clonaste el repo sin traer el submódulo:

```sh
git submodule update --init --recursive
```

Abre la URL que imprime Vite y pulsa **Hablar** para iniciar el audio. El prototipo usa la cabeza
3D original de CHIMERA. El cuerpo es una capa visual independiente y provisional.

## Estructura

- `chimera/`: CHIMERA fork submodule, pinned at `de56981` for this version's Spanish support; switch to upstream after it lands there.
- `src/`: la escena y el cuerpo de Quimera.
- `docs/architecture.md`: límites del proyecto, decisiones y trabajo futuro.
- `AGENTS.md`: reglas para agentes que trabajen aquí y procedimiento completo para actualizar
  CHIMERA.

## Actualizar CHIMERA

No actualices el submódulo automáticamente al abrir o construir el proyecto. Revisa el cambio
primero y sigue [`AGENTS.md`](AGENTS.md), sección **Actualizar el submódulo CHIMERA**. El commit del
submódulo, registrado en el repositorio padre, es la versión con la que esta escena se desarrolló.

## Licencias

El código de CHIMERA mantiene su licencia MIT y sus avisos de terceros. Los modelos, texturas,
ropa, música y demás assets que se añadan a Quimera deben tener una licencia compatible documentada
junto al asset. No copiar aquí audio de terceros ni assets sin permiso.
