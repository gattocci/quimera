# Instrucciones para agentes de Quimera

## Propósito

Quimera es un proyecto compañero para escenas con personajes que hablan y cantan usando CHIMERA.
La voz, la pronunciación, el plan articulatorio, el tracto vocal y la cabeza 3D pertenecen a CHIMERA.
Este repo aporta cuerpos sencillos, ropa, escena, gestos corporales y guiones. La cabeza existente
se consume tal como es. No reimplementar ni retocar su boca para que parezca más genérica.

Lee primero [`docs/architecture.md`](docs/architecture.md). Si el trabajo requiere cambiar una
API interna de CHIMERA, revisa el flujo de contribución de abajo antes de tocar el submódulo.

## Límites

- No cambies G2P, IPA, reglas de idioma, pronunciación, prosodia, planes, articuladores, gesto
  vocal, fuente de voz, audio ni telemetría para resolver una necesidad propia de una escena.
- No edites archivos dentro de `chimera/` en una tarea de Quimera. Es un submódulo fijado, no una
  copia donde desarrollar features de escenas.
- La cabeza de CHIMERA ya incluye el tracto animado. No reemplazarla con visemas genéricos ni con
  un avatar que mueva la boca desde amplitud de audio.
- Los cuerpos, la ropa, los decorados, el guion y la cronología de escena viven en este repositorio.
- Evita introducir dependencias remotas de ejecución. La escena y el audio deben correr localmente
  en el navegador.
- No incluir archivos con copyright dudoso. Cada asset externo debe tener procedencia, licencia y
  atribución documentadas.
- Conserva el prototipo opcional y pequeño. Una escena persistente, editor general, importador de
  assets o sistema completo de animación son propuestas de alcance, no supuestos.

## Construir y ejecutar

```sh
git submodule update --init --recursive
bun install
bun run dev
```

El script `bun run wasm` construye el WASM desde el commit fijado del submódulo. `bun run build`
además revisa tipos y crea la distribución web. Ejecuta estas comprobaciones cuando cambies el
código de Quimera. No recompiles el WASM editando código de CHIMERA dentro del submódulo.

## Actualizar el submódulo CHIMERA

La versión usada no se define por el nombre de una rama: el repositorio padre guarda un gitlink al
SHA exacto de `chimera/`. `bun.lock` fija dependencias JavaScript; `Cargo.lock` del submódulo fija
dependencias Rust.

### Actualización normal a upstream/main

En un clon nuevo, configura el remoto oficial una sola vez (`origin` apunta al fork):

```sh
git -C chimera remote add upstream https://github.com/jamesondh/chimera-vocal-synth.git
```

Si `upstream` ya existe, verifica su URL en vez de volver a añadirlo.

El pin actual es `03bb1155ee99592f2bd1fbaf646c728e4f03b9e2`, head del PR #81 de upstream (`Spanish: add rule-based speech and singing front end`). Se eligió porque contiene el soporte de español (con dialectos seseo, rioplatense y castellano) y la integración del body rig que consume Quimera. No muevas el pin a `upstream/main` hasta comprobar que ese PR ya esté integrado en main y que la pronunciación y el body rig sigan funcionando.

1. Asegúrate de que el árbol de Quimera esté limpio (`git status --short --branch`). Si hay trabajo
   sin guardar, consérvalo antes de cambiar el pin.
2. Obtén la referencia del repositorio oficial y revisa el candidato:

   ```sh
   git -C chimera fetch upstream main
   git -C chimera log --oneline --decorate HEAD..upstream/main
   git -C chimera diff --stat HEAD..upstream/main
   ```

3. Mueve el submódulo al commit nuevo de forma explícita:

   ```sh
   git -C chimera checkout --detach upstream/main
   git -C chimera rev-parse HEAD
   git diff --submodule=log -- chimera
   ```

4. Reconstruye y revisa la escena:

   ```sh
   bun run build
   ```

   Prueba también en el navegador la cabeza 3D, una frase hablada y la transición de vuelta al
   reposo. El proceso de audio debe arrancar desde un gesto del usuario.

5. Si todo está bien, registra **el cambio del gitlink** en el padre. No hagas commit dentro de
   `chimera/` ni edites su historial:

   ```sh
   git add chimera
   git commit -m "Update pinned CHIMERA revision"
   ```

   El commit padre es el que hace reproducible la actualización para quien clone Quimera.

### Probar temporalmente una rama o PR de CHIMERA

Para probar un cambio upstream antes de que llegue a `main`, trae la rama o el ref del PR dentro
del repositorio del submódulo y fija un SHA, no el nombre móvil de la rama:

```sh
git -C chimera fetch upstream pull/<NUMERO>/head
git -C chimera checkout --detach FETCH_HEAD
git -C chimera rev-parse HEAD
git diff --submodule=log -- chimera
```

Construye y prueba como arriba. Si el PR no se acepta o no sirve, vuelve al pin anterior con
`git checkout <SHA-PREVIO>` dentro de `chimera/`, sin borrar el trabajo del padre. Al integrarse el
PR, cambia el submódulo al SHA de upstream/main que lo contiene y prueba nuevamente.

### Resolver conflictos de submódulo

Si el merge marca `chimera` como conflicto, no lo resuelvas escogiendo a ciegas "ours" o "theirs".
Consulta los dos SHA del conflicto con `git ls-files -u chimera`, compara sus logs y elige el commit
que la escena haya probado. Deja el submódulo en ese commit, luego usa `git add chimera`.

### Qué significa que el submódulo esté modificado

Si `git status` dentro de `chimera/` muestra archivos modificados, detente. Esos cambios no se
guardan al hacer commit en Quimera. Descarta únicamente cambios generados conocidos (por ejemplo el
WASM ignorado) y no uses `git submodule update --force` si pudiera borrar trabajo humano. No añadas
assets ni commits propios al submódulo.

## Proponer cambios a upstream

Si un siguiente uso necesita una API estable para consumir la cabeza, una telemetría más clara o un
callback que beneficie a otras interfaces CHIMERA, abre primero una tarea pequeña que describa el
caso general. Desarrolla ese cambio en un fork de CHIMERA y abre un PR a
[jamesondh/chimera-vocal-synth](https://github.com/jamesondh/chimera-vocal-synth). Mientras se
revisa, Quimera puede fijarse temporalmente al SHA de ese PR. No metas el cuerpo, ropa o escenas en
ese PR. Al integrarse, vuelve a fijar el submódulo a un SHA de upstream.

Una extracción de cabeza solo debería hacerse si esta integración interna resulta frágil. Debe
mantener la anatomía, el tracto y el lip-sync originales y sacar del componente dependencias de UI
globales; no convertirlo en un avatar vocal independiente.

## Reportar cambios

Al terminar, indica los archivos modificados, el SHA de CHIMERA si cambió, qué comprobaciones se
ejecutaron y cuáles no. No afirmes que la escena funciona en navegador si no se probó de verdad.
