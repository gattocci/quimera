# Arquitectura y alcance

## Intención

Quimera es una escena de personajes construida alrededor de CHIMERA, no un sintetizador nuevo.
CHIMERA conserva íntegra la voz y la cabeza que representa físicamente su producción:

- pronunciación, front ends de idioma, prosodia y planificación;
- estado articulatorio, geometría del tracto y telemetría;
- síntesis de audio y sincronización del movimiento de labios;
- la cabeza 3D de CHIMERA, con su lengua, dientes, labios, mandíbula y tracto.

Quimera los consume. No deriva, sustituye ni modifica esos elementos para ajustarlos a cuerpos o
escenas. La cabeza puede servir de ancla visual para cuerpos diferentes; cada nuevo diseño de
cuerpo/ropa/estilo vive fuera del submódulo. Solo en el futuro se podría proponer a upstream una
API reutilizable para la cabeza, preservando la misma anatomía y su lectura de articuladores.

## Lo que añade este repo

- una puesta en escena con uno o más personajes;
- el body rig de CHIMERA (`src/rig/`) usado como cuerpo del personaje; Quimera lo monta, no lo reimplementa;
- acciones corporales sencillas: respirar, cambiar el peso, mirar al interlocutor, asentir, hacer
  un gesto, entrar o salir;
- texto asignado a personajes y eventos de escena sincronizados con la voz (`src/scene.ts`);
- assets con licencias y atribuciones mantenidas por el proyecto compañero.

La expresión debe venir sobre todo de la escena: turnos, pausas, miradas, composición, música y
gestos discretos. No hace falta un esqueleto facial complejo para cada personaje. En NPCs de fondo
se puede simplificar el cuerpo y espaciar sus reacciones, pero el personaje que habla usa la cabeza
completa de CHIMERA.

## Estado actual (estudio de escenas, cuerpos y diálogo)

El prototipo incluye:

- **Estética aprobada por defecto** (`src/SceneApp.tsx`, `src/RigScene.tsx`): cabeza anatómica en
  modo `vocal` con cuerpo base `vocal`. La cabeza es un *corte* (contorno nítido, pocos elementos
  brillantes, mucho negro); el cuerpo habla ese mismo idioma con tres cosas: una silueta fina sin
  relleno, una línea media del torso (eje z lateral del rig en reposo, acotada por la profundidad x)
  con el acento rosa/rojo en el pecho, y pocas curvas verticales de contorno (perpendiculares a x y z)
  ancladas a coordenadas de reposo para que se lea al orbitar sin deslizarse con los gestos.
  Sin malla, sin anillos horizontales y sin relleno. Las líneas se miden en píxeles de pantalla, así que conservan
  el grosor fino con cualquier zoom. La piel de la cabeza vive en esa misma malla por encima del
  borde del cuello (y ≈ 67 cm), así que el shader se corta ahí y la cara queda limpia. `vocal` es
  además el look que articula los labios desde los articuladores del motor.
- **Cuerpo base + ropa** (`Character.layers` en `src/scene.ts`): todo es LUZ. El cuerpo base es un
  holograma de línea fina; la ropa (`outfit`, `src/layers/outfit.ts`) es vidrio tenue con borde
  luminoso, no plástico. Un relleno translúcido sobre negro se leía como gris plano, así que el
  vidrio gana profundidad con un revés: `BackSide` transparente, sin `depthWrite`, `renderOrder` -8,
  solo silueta, bordes, curvas y costuras (`uBackAlpha` = 0,25, con un susurro de relleno 0,05).
  Después vienen el prepass (`colorWrite: false`, `depthWrite: true`, `polygonOffset` 1/1,
  `renderOrder` -7), que oculta el cuerpo, y el vidrio visible (FrontSide, sin `depthWrite`,
  `depthFunc: LessEqual`, `renderOrder` 1). El prepass es `transparent: true` a propósito: Three.js
  dibuja primero la lista opaca y después la transparente, y `renderOrder` solo ordena dentro de
  cada lista, así que de otro modo el revés -8 se dibujaría después del prepass -7 y quedaría
  oculto por su profundidad. El mate opaco sigue disponible con
  `layers.outfit.material: "solid"` (`renderOrder` -5). Conversión a sRGB manual (`layerEncode`) en
  todos los casos. Remera `#aeb9c3`, pantalón `#66737f`, bordes `#d0d8df` con `uEdgeAlpha` = 0,85,
  halo azul del 30 % del azul de línea del cuerpo. Ajustes tenues: `uFill` 0,10, `uEdgeGain` 1,6,
  `uAlpha` 0,35, `uBackAlpha` 0,25, `uOffset` 1,1 cm. `uSolid` por defecto 0. Entre y = 14 y 34 cm
  remera y pantalón se solapan (228 vértices del rig con ambas máscaras en 1,00): los pases visibles
  del pantalón se descartan donde la remera cubre, para no sumar alpha; su prepass sigue activo.
  Cintura sin anillo; el puño es un anillo cerrado en `|z| = 30` alrededor del bíceps. La cobertura
  se amplía solo en la capa para cerrar hombro, pantorrilla, entrepierna, axila y cadera, sin tocar
  `CLOTH_REGION_GLSL` ni los umbrales. El recorte sigue anclado a `aRest` (x delantero, y vertical,
  z lateral); un guard en el cuello deja la cara y el lip-sync intactos. `detail` (0..1) controla
  curvas, costuras y pliegues; `seed` fija su fase. Los cinco ajustes se editan en el panel plegable
  del editor de personajes: `src/layers/outfitTuning.ts` es un store sin React, `RigScene` lee sus
  valores cada frame y escribe uniforms, por lo que no se rebuild la escena; `SceneApp` también los
  persiste en `layers.outfit` (`fill`, `edgeGain`, `lineAlpha`, `backAlpha`, `offset`) y
  `validateScene()` los valida con rangos. En DEV, los parámetros de URL `clothSolid`, `clothFill`,
  `clothEdgeGain`, `clothAlpha`, `clothBackAlpha`, `clothEdge`, `clothOffset`, `shirtColor` y
  `pantsColor` siembran esos defaults (hex de seis dígitos, con o sin `#`, con fallback). Los JSON
  sin `layers` siguen funcionando como antes.
- **Pelo sobre la cabeza** (`Character.layers.hair`, `src/layers/hair.ts`): mismo lenguaje de luz, sin malla, sin visemas y sin tocar la cabeza. El modelo anterior de cintas compactas se sustituyó por **guías + hijas**: 30–70 guías según `density` (70 con `guideCount` 70 y densidad 1) definen la caída y la onda; 600–3000 hijas con raíz repartida por quads del cuero cabelludo transportan su forma desde las 3 guías más cercanas (pesos por distancia inversa) y añaden onda, largo y brillo propios. `clump` acerca cada hija entre 30 % y 60 % a la guía dominante; `spread` (0,6–1,8 cm, default 1,0) separa las raíces con un mínimo de 0,6 cm medido con hash espacial: si no caben, se entregan menos hijas antes que acercarlas. Un solo `LineSegments` por personaje con buffers reservados a 70 guías y 3000 hijas; `density`, `guideCount` y el diagnóstico cambian alphas y `drawRange`, no reconstruyen la escena. Las raíces salen de la malla que `wearHead()` añade al rig (`y` 78..94 cm, `|atan2(z, x-5,4)| >= 0,75`, `frontLimit(y)` y tono atenuado del scalp). Con los tres presets hay 211/228/187 vértices de scalp y 182/198/159 quads válidos; el muestreo coloca 885/941/836 hijas con `density` 0,5. Cada frame se reconstruyen 8 puntos por hebra desde vértices skinneados y la rotación de `head`: cortina con 1–2 ondas de 0,5–1,5 cm de amplitud, ±12 % de largo y fade de alpha a 0 en el último 20 %. La colisión con torso/cuello/brazos se resuelve en las guías y se hereda vía delta+quaternion inverso, sin repetir cápsulas por hija. `frontLimit(y)` y el `backBias` de las cápsulas prohíben trazos por delante de cara, mandíbula y cuello (validado: 0 cruces en los tres presets). Mezcla aditiva, alpha de hebra 0,14, degradado `#cdb98a` → `#fff0c8` con brillo ±35 % por seed, contorno de 18 puntos con Catmull-Rom a `#f3e2b8` alpha 0,7 y núcleo de masa por guía con `uBodyAlpha` 0,03. Color base `#e6cf9a`, `mulberry32(seed + 7*hash(id) + 17)`, persistencia en `layers.hair` y validación de rangos en `validateScene()`. El botón «Diagnóstico» alterna todo / guías / hijas / contorno (no se persiste).
- **Estilos de cuerpo apartados**: `head-only` (solo la cabeza, sin cuerpo) queda en el esquema para
  escenas avanzadas y no se ofrece en la barra principal. `anatomic`, `ethereal` y `mesh` están
  marcados como `@deprecated`: `validateScene()` (`src/scene.ts`) los normaliza a `vocal` al importar,
  así que un JSON antiguo no puede reactivar los anillos ni la malla completa que se rechazaron.
- **Estudio Creativo integrado** (`src/SceneApp.tsx`):
  - *Editor de personajes*: configuración de nombre, cuerpo de voz (`female`, `male`, `child`), tono base $f_0$, dialecto, posición X en el escenario, color de acento, ropa (`ninguna` / `remera + pantalón`) con su slider de detalle y el panel plegable «Vidrio · ajustes» (relleno, borde, líneas, revés, offset y botón «Restablecer»), y pelo (`ninguno` / `corto` / `largo`) con el panel «Pelo · ajustes» (densidad, largo, barrido, separación, agrupamiento, guías, alpha de hebra/contorno/masa, balanceo, color, «Restablecer» y botón de diagnóstico todo/guías/hijas/contorno).
  - *Editor de guiones y sentimientos*: agregar, editar, reordenar y eliminar líneas y pausas; asignación de actitudes por réplica (*curioso, enfático, pensativo, acuerdo, atento, relajado, gesticulando*).
- **Atmósferas escénicas**: modos *Vacío* (negro profundo de alto contraste), *Rejilla* (cibernético) y *Foco* (iluminación cenital).
- **Cámara interactiva** (`OrbitControls`): rotación 360°, zoom hacia los órganos vocales y recentrado con un clic.
- **Dialectos y síntesis**: español con dialectos (neutro, rioplatense, castellano) y compatibilidad con inglés y turco.
- **Formato y serialización**: importación y exportación inmediata en formato JSON estándar.

### Reglas de las capas

- Cabeza, cuerpo, ropa y pelo son LUZ: líneas finas y translúcidas de grosor constante en píxeles
  (`fwidth`). La ropa es vidrio tenue: un revés muy tenue da profundidad y un prepass oculta el
  cuerpo; el mate opaco es una opción por capa, no el default. Sin anillos repetidos: las
  horizontales solo son bordes de prenda (cuello, puños, dobladillos, tobillo), curvas con la
  sección y nunca rectas.
- La cabeza manda: ninguna capa tapa la cara ni la boca; el lip-sync sigue siendo el resultado de
  los articuladores de CHIMERA, no una animación propia de Quimera.
- El código vive en `src/layers/`: `common.ts` (utilidades GLSL, regiones de recorte y ciclo de
  vida), `outfit.ts` (ropa), `outfitTuning.ts` (store ligero del panel, compartido con `scene.ts`
  para los rangos) y `hair.ts` + `hairTuning.ts` (pelo y su store ligero). `RigScene.tsx` solo monta
  las capas, actualiza uniforms y libera materiales y meshes al desmontarse; la geometría del cuerpo
  es la del rig y la libera `RigView`, mientras que el pelo posee su propio `LineSegments`. El efecto
  de montaje depende de una clave estructural que excluye los ajustes del vidrio y del pelo, así que
  mover un slider no reconstruye la escena.
- `validateScene()` valida por capa `enabled`, `color`, `material`, `density` y `seed`, además de
  `detail` y los cinco ajustes del vidrio (`fill`, `edgeGain`, `lineAlpha`, `backAlpha`, `offset`)
  en la ropa y, en el pelo, `variant` (`short`/`long`) junto con `density`, `length`, `sweep`,
  `strandAlpha`, `contourAlpha`, `bodyAlpha`, `sway`, `spread`, `clump` y `guideCount` según
  `HAIR_TUNING_RANGES`, con mensajes de error en español.

### Coste medido del pelo y pendientes

Benchmark sintético del bucle de actualización (Bun 1.2.16, rig real de `female` con la cabeza puesta, 20 bloques de 100 frames, mediana; sin render GPU): creación de la capa ≈ 0,5 s por personaje (120.000 muestras de raíz), actualización **3,8 ms/frame/personaje** con `density` 0 (30 guías, 600 hijas, 9.376 vértices), **5,7 ms** con 0,5 (50 guías, 887 hijas, 13.954 vértices) y **5,6 ms** con 1 (70 guías, 887 hijas, 14.514 vértices). Dos personajes ≈ 7,6–11,4 ms/frame solo de CPU. El conteo máximo real de hijas queda en 836–941 según el preset, muy por debajo del teórico de 3000: la separación mínima de 0,6 cm y el área de scalp (~443–497 cm²; capacidad hexagonal estimada ~1566–1759) imponen ese techo y se prefiere menos hijas antes que acercarlas. El diagnóstico omite el cálculo de lo que oculta, así que «solo contorno» y «solo guías» también abaratan el frame.

La versión anterior de 40–90 mechones × 8–40 hebras costaba 0,38–0,87 ms pero se veía como bloques opacos. El transporte desde 3 guías, la onda por recurrencia trigonométrica (4 llamadas trigonométricas por hija en vez de 1 por punto), 8 puntos por hebra, la colisión movida a las guías y los alias locales de buffers redujeron el nuevo bucle de ~10 ms a las cifras anteriores.

Supuestos y pendientes: las raíces y la pared frontal se validaron en reposo con los tres presets del rig real (0 NaN, 0 cruces por delante de `frontLimit`), pero **no se ha probado visualmente en navegador ni con voz**. No se puede afirmar todavía que el trazo de 1 px no titila a la cámara por defecto, que no penetran hombros/cuello en gestos extremos ni que el lip-sync queda despejado en movimiento. Si el titilado aparece, la alternativa prevista es `LineSegments2` o quads orientados a cámara de 1–1,5 px; aún no se ha implementado. Tampoco se ha aplicado un prepass de profundidad opcional para el pelo.

## Dependencia fijada

`chimera/` es el fork de CHIMERA incorporado como Git submodule. El padre guarda un gitlink a un
SHA específico; dos clones del mismo commit de Quimera obtienen la misma versión de CHIMERA. El pin
actual (`03bb115`, PR #81 head) incluye el soporte de español con dialectos (seseo, rioplatense,
castellano) y la API de body rig (`src/rig/`). Al actualizar, confirma primero que español y la API
de la cabeza siguen presentes. No apuntes a `main` como dependencia sin fijar un commit y revisar el
cambio. La inicialización, actualización normal, prueba de PR y resolución de conflictos están en
[`../AGENTS.md`](../AGENTS.md).

El submódulo permite consumir hoy el código de UI que aún no se publica como biblioteca. La
integración usa módulos internos de CHIMERA, así que puede requerir ajustes cuando cambie upstream.
Ese acoplamiento está aceptado para el prototipo y debe quedar detrás de la capa de escena de
Quimera. No proliferar imports del submódulo por todos los componentes; el punto de entrada del rig
es `src/RigScene.tsx` y el de la escena es `src/scene.ts`.

## Reloj y movimiento

El motor conoce articuladores durante la voz. La cabeza de CHIMERA representa ese estado a su ritmo
de render. El cuerpo no necesita reproducir todos esos valores: respira suavemente mientras habla,
realiza un asentimiento en una marca de tiempo o dirige la mirada cuando cambia el turno.

Las órdenes de cuerpo deben estar en tiempo de escena o relativas a una línea: por ejemplo,
`personaje-2 mira-a personaje-1 al empezar la frase` o `personaje-1 asiente 0,4 s después`. No
calcular la duración de la voz a partir del número de caracteres. Para una reproducción exacta, usar
los tiempos de la voz/planner o el reloj de reproducción de CHIMERA.

Mantener los tipos de CHIMERA detrás de un adaptador cuando se pueda. Así se evita que el esquema de
escena quede atado a detalles de telemetría que solo necesita la cabeza.

## Opciones siguientes

1. Añadir un segundo personaje a la escena y coordinar los turnos de habla.
2. Añadir acciones de personaje con marca de tiempo: `nod`, `look-at`, `enter`, `exit`.
3. Permitir cargar una `Scene` externa (JSON) desde el panel de controles.
4. Añadir modelos GLB/animaciones de Blender solo si el body rig de CHIMERA no basta;
   comprobar la licencia de cada modelo, textura, ropa y clip.
5. Medir coste con varios personajes antes de plantear muchas voces simultáneas; una cabeza 3D por
   voz también consume contextos WebGL y telemetría.
6. Si el uso real demuestra acoplamiento excesivo, proponer upstream una extracción del componente
   de cabeza sin cambiar su anatomía vocal. La extracción no debe mover escenas, cuerpos o ropa a
   CHIMERA.

## Una escena no altera el habla

Los idiomas y el texto siguen entrando a CHIMERA por su API existente. El código de escena elige
qué personaje habla y cuándo; no sustituye ni transforma la transcripción fonética. El lip-sync de
la cabeza continúa siendo el resultado de los articuladores de CHIMERA, no una animación calculada
por Quimera.

## Referencias

- [CHIMERA upstream](https://github.com/jamesondh/chimera-vocal-synth): motor, cabeza y evolución
  del contrato público.
- [PR #81](https://github.com/jamesondh/chimera-vocal-synth/pull/81): Spanish front end (pin actual
  de Quimera: `03bb115`).
- [Moppet Choir](https://github.com/jessenaiman/moppets): ejemplo de proyecto compañero que fija
  CHIMERA como submódulo y agrega sus propios personajes, escena y clips de gesto.
- [Cargo: dependencias Git fijadas](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html):
  referencia si una parte Rust necesita usar el crate del motor directamente.
- [Git: submódulos](https://git-scm.com/book/en/v2/Git-Tools-Submodules): inicialización y modelo de
  versión fijada por commit.
- [Three.js GLTFLoader](https://threejs.org/docs/#examples/en/loaders/GLTFLoader) y
  [Blender glTF](https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html):
  opciones futuras para cuerpos modelados adicionales, no requisito para el hito actual.