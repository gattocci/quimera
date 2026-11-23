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
- cuerpos estilizados, ropa y siluetas que no pretenden reproducir anatomía exacta;
- acciones corporales sencillas: respirar, cambiar el peso, mirar al interlocutor, asentir, hacer
  un gesto, entrar o salir;
- texto asignado a personajes y eventos de escena sincronizados con la voz;
- assets con licencias y atribuciones mantenidas por el proyecto compañero.

La expresión debe venir sobre todo de la escena: turnos, pausas, miradas, composición, música y
gestos discretos. No hace falta un esqueleto facial complejo para cada personaje. En NPCs de fondo
se puede simplificar el cuerpo y espaciar sus reacciones, pero el personaje que habla usa la cabeza
completa de CHIMERA.

## Dependencia fijada

`chimera/` es el fork de CHIMERA incorporado como Git submodule. El padre guarda un gitlink a un SHA específico; dos clones del mismo commit de Quimera obtienen la misma versión de CHIMERA. El pin actual (`03bb115`, PR #81 head) incluye el soporte de español con dialectos (seseo, rioplatense, castellano) y la API de body rig (`src/rig/`). Al actualizar, confirma primero que español y la API de la cabeza siguen presentes. No apuntes a `main` como dependencia sin fijar un commit y revisar el cambio. La inicialización, actualización normal, prueba de PR y resolución de conflictos están en [`../AGENTS.md`](../AGENTS.md).

El submódulo permite consumir hoy el código de UI que aún no se publica como biblioteca. La
integración usa módulos internos de CHIMERA, así que puede requerir ajustes cuando cambie upstream.
Ese acoplamiento está aceptado para el prototipo y debe quedar detrás de la capa de escena de
Quimera. No proliferar imports del submódulo por todos los componentes.

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

## Primer hito

La primera prueba ejecutable contiene un personaje, un preset corporal, texto leído por CHIMERA,
la cabeza 3D original y una animación corporal simple mientras habla. Es para comprobar que escena,
audio y cabeza comparten pantalla y tiempo. No es todavía un formato de escenas persistente ni un
editor de personajes.

## Opciones futuras

1. Guardar líneas, cuerpos, decorado y acciones como datos serializables de escena.
2. Añadir unas pocas acciones de personaje y reacciones para el reparto.
3. Si se necesita más variedad, diseñar presets de cuerpo y vestuario intercambiable.
4. Añadir modelos GLB/animaciones de Blender solo si las siluetas simples dejan de ser suficientes;
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
- [Moppet Choir](https://github.com/jessenaiman/moppets): ejemplo de proyecto compañero que fija
  CHIMERA como submódulo y agrega sus propios personajes, escena y clips de gesto.
- [Cargo: dependencias Git fijadas](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html):
  referencia si una parte Rust necesita usar el crate del motor directamente.
- [Git: submódulos](https://git-scm.com/book/en/v2/Git-Tools-Submodules): inicialización y modelo de
  versión fijada por commit.
- [Three.js GLTFLoader](https://threejs.org/docs/#examples/en/loaders/GLTFLoader) y
  [Blender glTF](https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html):
  opciones futuras para cuerpos modelados, no requisito para el primer hito.
