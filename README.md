# Quimera

Experimento compañero para construir escenas y personajes alrededor de CHIMERA. CHIMERA conserva
el motor de voz y su cabeza completa, incluido el tracto vocal animado y el lip-sync. Este proyecto
añade el escenario, el body rig posable y la orquestación de escenas.

El prototipo actual incluye:
- Escena compartida con uno o dos personajes en 3D con body rig posable de CHIMERA.
- Miradas mutuas e interpolación de posturas (atento, relajado, gesticulando) entre turnos de habla.
- Selector de dialecto español (neutro / rioplatense / castellano).
- Formato de escena serializable con importación/exportación de archivos JSON.
- Dos modos de UI: Escena & Diálogo (guiones con turnos y pausas) y Voz Libre (control manual).
No cambia pronunciación, planificación, articulación ni síntesis.

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

Abre la URL que imprime Vite y pulsa **Hablar** (modo Libre) o **Reproducir escena** (modo Escena)
para iniciar el audio. El prototipo muestra el body rig de CHIMERA con la cabeza 3D original encima.

## Estructura

- `chimera/`: CHIMERA fork submodule, pinned at `03bb115` (PR #81 head); includes Spanish front end with Dialect support (seseo, rioplatense, castellano) and body rig API.
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
