# Quimera

Experimento compañero para construir escenas y personajes alrededor de CHIMERA. CHIMERA conserva
el motor de voz y su cabeza completa, incluido el tracto vocal animado y el lip-sync. Este proyecto
añade el escenario, el body rig posable y la orquestación de escenas.

El prototipo actual incluye:
- **Estética aprobada por defecto**: cabeza anatómica limpia en modo `vocal` con un cuerpo base "fantasma": silueta fina, una línea media con acento rosa/rojo en el pecho (el equivalente al corte por el entrecejo de la cabeza) y pocas curvas verticales de contorno que dan volumen al orbitar la cámara. Sin malla, anillos ni relleno; cortado en el cuello para que la cara no tenga franjas. `head-only` queda como opción avanzada; `anatomic`, `ethereal` y `mesh` son legacy y se normalizan a `vocal` al importar un JSON.
- **Ropa sobre el cuerpo** (`Character.layers.outfit`): todo es LUZ. La ropa es **vidrio tenue por defecto** (`material: "glass"`): un revés muy tenue (`BackSide`, `renderOrder` -8) da profundidad, un prepass (`renderOrder` -7) oculta el cuerpo holográfico y el pase visible (FrontSide, sin `depthWrite`, `LessEqual`) dibuja el cristal. El mate opaco sigue disponible con `material: "solid"`. Remera `#aeb9c3`, pantalón `#66737f`, bordes `#d0d8df` con alpha 0.85, halo azul 0.30. Ajustes tenues: relleno `0.10`, ganancia del fresnel `1.6`, líneas `0.35`, revés `0.25`, offset `1.1` cm; se editan en vivo en el panel plegable «Vidrio · ajustes» del editor de personajes (sin reconstruir la escena) y se persisten en `layers.outfit` como `fill`, `edgeGain`, `lineAlpha`, `backAlpha` y `offset`, validados por `validateScene()`. En el solape y = 14..34 cm el pantalón no dibuja para no sumar alpha con la remera; el cuerpo sigue oculto. Puño cerrado alrededor del bíceps; cintura sin anillo; hombros, pantorrilla, entrepierna y axila sin huecos. `detail` (0 a 1) añade curvas, costuras y pliegues; `seed` fija su fase. Alternativa DEV: `?clothSolid=0&clothFill=0.10&clothEdgeGain=1.6&clothAlpha=0.35&clothBackAlpha=0.25&clothEdge=0.85&clothOffset=1.1&shirtColor=aeb9c3&pantsColor=66737f`.
- **Pelo sobre la cabeza** (`Character.layers.hair`): pelo corto o largo hecho de LUZ, sin malla ni visemas. Guías (30–70) e hijas (600–3000 según lo que quepa en el scalp) forman un único `LineSegments` por personaje con blending aditivo, alpha de hebra 0,14, degradado `#cdb98a` → `#fff0c8`, brillo ±35 % por seed y punta desvanecida. Las hijas reparten su raíz por el cuero cabelludo permitido con separación mínima de 0,6 cm (`spread` 0,6–1,8 cm, default 1,0), transportan la forma desde las 3 guías más cercanas y se agrupan parcialmente (`clump` 0..1, default 0,5). Onda suave de 1–2 ciclos y 0,5–1,5 cm, ±12 % de largo y contornos spline de 18 puntos. La pared `frontLimit(y)` y la colisión con empuje hacia atrás mantienen el pelo fuera de cara, mandíbula y cuello para proteger el lip-sync; la colisión se calcula solo en las guías y la heredan las hijas. Raíces y determinismo desde la malla de CHIMERA (`mulberry32(seed + hash del id)`), sin tocar la cabeza. Se elige en «Pelo: ninguno / corto / largo» y se ajusta en vivo en «Pelo · ajustes» (densidad, largo, barrido, separación, agrupamiento, guías, alphas, balanceo y color, «Restablecer» y diagnóstico todo/guías/hijas/contorno), sin reconstruir la escena; los valores persisten en `layers.hair` y `validateScene()` valida sus rangos. Coste medido (Bun, sin GPU): ≈ 5,7 ms/frame/personaje con los defaults; el diagnóstico y los pendientes visuales se detallan en `docs/architecture.md`.
- **Estudio Creativo interactivo**: creador de personajes (voz, tono f0, dialecto, posición X, color, ropa `ninguna / remera + pantalón` y su slider de detalle, pelo `ninguno / corto / largo` y su panel de ajustes) y editor de diálogo en tiempo real.
- **Sentimientos y posturas**: réplicas con intención corporal (*curioso, enfático, pensativo, acuerdo, atento, relajado, gesticulando*).
- **Cámara 3D libre**: órbita 360°, zoom hacia los órganos vocales y recentrado automático.
- **Atmósferas escénicas**: modos de iluminación (*Vacío, Rejilla, Foco cenital*).
- **Formato de escena serializable**: importación y exportación instantánea en JSON.
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
para iniciar el audio. El prototipo muestra la cabeza 3D original de CHIMERA con la cara limpia, un cuerpo base tenue con su misma línea y, en el diálogo incluido, la remera y el pantalón sobre ese cuerpo.

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