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
- **Cuerpo base + ropa** (`Character.layers` en `src/scene.ts`): el cuerpo base es LUZ (holograma
  de línea fina); la ropa (`outfit`, `src/layers/outfit.ts`) es MATERIA. Se dibuja en dos pases sobre
  la misma malla del rig: un relleno mate opaco (`transparent: false`, `depthWrite: true`,
  `renderOrder` -6/-5) que tapa al cuerpo holográfico solo en la sección cubierta, y un trazo
  transparente (`depthWrite: false`, 0,05 cm por encima, `renderOrder` 1/2) para bordes, curvas y
  costuras. El sombreado usa color base, difusa desde `normalize(vec3(-0.4,0.6,0.7))` en espacio de
  vista, ambiente 0,35, fresnel suave y un halo azul del 25 % del azul de línea del cuerpo; la
  conversión a sRGB es manual (`layerEncode`). Remera `#6c737a`, pantalón `#3c4249`, bordes
  `#b8c0c8` con `uEdgeAlpha` = 0,8. La cintura ya no se dibuja como anillo/cinturón. `uSolid`
  (por defecto 1) compara mate opaco con el antiguo vidrio (`uFill` = 0,18); en 0 el pase opaco se
  descarta y el trazo recupera ese relleno. La cobertura se amplía solo en la capa para cerrar
  entrepierna, axila y cadera, sin tocar `CLOTH_REGION_GLSL` ni `outfitCoverage()`. El recorte sigue
  anclado a `aRest` (x delantero, y vertical, z lateral), así que la ropa sigue `body.turn` y los
  gestos sin deslizarse; un guard en el cuello deja la cara y el lip-sync intactos. `detail` (0..1)
  controla curvas, costuras y pliegues; `seed` fija su fase. Solo en DEV, `clothSolid`, `clothFill`,
  `clothAlpha`, `clothEdge`, `clothOffset`, `shirtColor` y `pantsColor` (hex de seis dígitos, con o
  sin `#`, con fallback) sobrescriben esos valores para ajustar sin recompilar. El pelo
  (`src/layers/hair.ts`) queda como contrato de materia densa: hoy no dibuja nada. Los JSON sin
  `layers` siguen funcionando como antes.
- **Estilos de cuerpo apartados**: `head-only` (solo la cabeza, sin cuerpo) queda en el esquema para
  escenas avanzadas y no se ofrece en la barra principal. `anatomic`, `ethereal` y `mesh` están
  marcados como `@deprecated`: `validateScene()` (`src/scene.ts`) los normaliza a `vocal` al importar,
  así que un JSON antiguo no puede reactivar los anillos ni la malla completa que se rechazaron.
- **Estudio Creativo integrado** (`src/SceneApp.tsx`):
  - *Editor de personajes*: configuración de nombre, cuerpo de voz (`female`, `male`, `child`), tono base $f_0$, dialecto, posición X en el escenario, color de acento y ropa (`ninguna` / `remera + pantalón`) con su slider de detalle.
  - *Editor de guiones y sentimientos*: agregar, editar, reordenar y eliminar líneas y pausas; asignación de actitudes por réplica (*curioso, enfático, pensativo, acuerdo, atento, relajado, gesticulando*).
- **Atmósferas escénicas**: modos *Vacío* (negro profundo de alto contraste), *Rejilla* (cibernético) y *Foco* (iluminación cenital).
- **Cámara interactiva** (`OrbitControls`): rotación 360°, zoom hacia los órganos vocales y recentrado con un clic.
- **Dialectos y síntesis**: español con dialectos (neutro, rioplatense, castellano) y compatibilidad con inglés y turco.
- **Formato y serialización**: importación y exportación inmediata en formato JSON estándar.

### Reglas de las capas

- Cabeza y cuerpo son LUZ: líneas finas y translúcidas de grosor constante en píxeles (`fwidth`).
  Ropa y pelo son MATERIA: la tela es opaca, con difusa suave y halo azul tenue; sus líneas van en
  un pase aparte sobre la superficie. Sin anillos repetidos: las horizontales solo son bordes de
  prenda (cuello, puños, dobladillos, tobillo), curvas con la sección y nunca rectas.
- La cabeza manda: ninguna capa tapa la cara ni la boca; el lip-sync sigue siendo el resultado de
  los articuladores de CHIMERA, no una animación propia de Quimera.
- El código vive en `src/layers/`: `common.ts` (utilidades GLSL, regiones de recorte y ciclo de
  vida), `outfit.ts` (ropa) y `hair.ts` (contrato del hito siguiente). `RigScene.tsx` solo monta las
  capas, actualiza uniforms y libera materiales y meshes al desmontarse; la geometría es la del rig
  y la libera `RigView`.
- `validateScene()` valida por capa `enabled`, `color`, `density` y `seed`, además de `detail` en la
  ropa y `length` en el pelo, con mensajes de error en español.

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