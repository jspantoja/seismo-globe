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
- PB2002 es un modelo de 2003.
- El USGS es completo desde M4.5 fuera de EE. UU.
- La copia del servidor vive en memoria de cada instancia; se pierde al reiniciarse.
