# SeismoGlobe

Globo 3D con sismos en tiempo real, placas tectónicas, países y sus divisiones, estadísticas por
país o placa y alertas configurables. Gratis, sin claves de API, desplegado en Vercel.

> **No es un sistema oficial de alerta temprana.** Los datos son preliminares y pueden tener
> retrasos o errores. Ante un sismo, siga las indicaciones de su autoridad local.

## Fuentes de datos

| Fuente | Uso | Términos |
| --- | --- | --- |
| USGS Earthquake Hazards Program | Sismos del mundo y estadísticas históricas | Dominio público |
| SGC Colombia (**no oficial**, opcional) | Sismos de Colombia, últimos 5 días | Feed público no documentado; autorización de republicación pendiente |
| EMSC, testimonios «¿lo sentiste?» (opcional) | Reportes ciudadanos | CC BY 4.0, cite: EMSC |
| EMSC, catálogo sísmico | Respaldo automático si el USGS no responde | Cite: EMSC |
| Bird (2003), modelo PB2002 | Placas tectónicas | Ver github.com/fraxen/tectonicplates |
| Natural Earth (world-atlas) | Países y divisiones | Dominio público |

Cada sismo muestra su fuente en el globo, en el detalle y en las notificaciones.

## Desarrollo

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck    # tipos de la app y de las pruebas
npm test             # pruebas unitarias (lectores de datos, respaldo, caché, fusión de reportes)
npm run build        # compilación de producción (incluye el paso prebuild)
```

`scripts/fetch-assets.mjs` (se ejecuta solo antes de `next build`) copia a `public/data` los mapas
que necesita el globo, verificados contra un SHA-256 fijo. Si algo no se puede descargar, no
rompe la compilación: la app pide ese archivo a una CDN pública.

## A qué país pertenece un sismo

Un sismo cuenta para el país en cuyo territorio ocurre; si ocurre en el mar, para el país más
cercano siempre que su costa esté a 200 km o menos; más lejos (alta mar, dorsales) no pertenece a
ningún país. Así cada sismo tiene como máximo un país y los totales suman con el resto del mundo.
La regla vive en `lib/countryAttribution.ts` y la usan igual la lista del globo y las estadísticas.
Fronteras: Natural Earth 1:50m (`world-atlas`), simplificadas, con un margen de unos kilómetros.

## Alertas

Se configuran en el navegador y se guardan solo ahí (`localStorage`); nada va al servidor. Se puede
elegir una magnitud mínima global, un umbral propio por país (que reemplaza al global, para más o
menos sensibilidad) y un horario sin avisos con hora del dispositivo, que puede cruzar la medianoche
y admite una excepción: «avisar igual si es M6 o más». Los países vigilados se asignan con la misma
regla que las estadísticas (territorio, o costa a 200 km o menos). Si llegan varios sismos a la vez
se avisa del de mayor magnitud. Un sismo sin magnitud publicada solo avisa si el umbral es «todas».
Los ajustes guardados por versiones anteriores se migran sin perder nada (`parseAlertSettings` en
`lib/alerts.ts`). Las alertas funcionan solo mientras la pestaña esté abierta: no hay envío en segundo plano.

## El motor gráfico

El globo se dibuja con un motor propio en WebGL2 y TypeScript (`engine/`), sin three.js ni
`react-globe.gl`: la cámara, los controles táctiles y de teclado, la triangulación de países, los
rellenos y líneas sobre la superficie, los sismos, los anillos pulsantes y los marcadores HTML son
código del proyecto, con pruebas propias (`npm test`) y un banco de pruebas en `/engine-lab`.

- **Pocas llamadas de dibujo.** Los países, las placas y las divisiones son capas de superficie
  (una llamada por capa) y todos los sismos son una sola malla instanciada. Con un mes de datos
  (~10 000 sismos) son ~6 llamadas por fotograma; la versión con three.js hacía ~1 700.
- **Dibuja solo cuando hace falta.** Sin movimiento ni animaciones el motor no dibuja nada; con
  solo anillos activos se limita a 30 fps, y la resolución se limita a 2× de densidad de píxeles.
- **Precisión al hacer zoom.** Las posiciones se envían como pares (alto, bajo) en coma flotante
  relativos al ojo, para que los límites no tiemblen a pocos kilómetros de altura.
- **Hover y clic sin trazado de rayos.** Se proyecta cada sismo a pantalla y gana el más cercano
  al puntero entre los que miran a la cámara (~0,5 ms para 20 000 sismos).
- **Pérdida de contexto.** Si el navegador descarta el contexto WebGL, las capas se reconstruyen solas.

Peso del JavaScript de la aplicación (producción, gzip): ~226 KB frente a ~779 KB con three.js.

## Enlaces compartibles

La dirección de la página refleja la vista, así que copiar el enlace comparte lo que se ve:
`?periodo=week&mag=4.5&pais=170&lista=1` (`placa=SA` en lugar de `pais=` para una placa;
`sgc=1` y `emsc=1` activan esas fuentes). `?sismo=<id>` abre el detalle de un sismo. Todo lo que
llega por la dirección se valida (`lib/urlState.ts`) y lo inesperado se ignora.

## Despliegue

Cada push a `main` se compila y se publica en Vercel. GitHub Actions (`.github/workflows/ci.yml`)
corre tipos, pruebas y compilación en cada push y pull request.

## Límites conocidos

- La frontera de cada país es la de Natural Earth 1:50m: simplificada, y los islotes muy pequeños pueden faltar.
- Un sismo en el mar justo equidistante de dos países se asigna a uno de ellos sin criterio especial.
- Las alertas no llegan con la pestaña cerrada (no hay notificaciones push desde un servidor).
- PB2002 es un modelo de 2003.
- El USGS es completo desde M4.5 fuera de EE. UU.
- La copia del servidor vive en memoria de cada instancia; se pierde al reiniciarse.
- El globo necesita WebGL2 (todos los navegadores actuales); sin él se muestra un aviso en lugar del globo.
- Al elegir un país, triangular su frontera detallada (1:50m) ocupa unos 200 ms del hilo principal.
- Medidas de rendimiento hechas con GL por software (sin GPU): sirven para llamadas de dibujo y coste de JavaScript, no para fotogramas por segundo.
