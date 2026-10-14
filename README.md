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

## Despliegue

Cada push a `main` se compila y se publica en Vercel. GitHub Actions (`.github/workflows/ci.yml`)
corre tipos, pruebas y compilación en cada push y pull request.

## Límites conocidos

- Las estadísticas por país usan el rectángulo que envuelve al país, no su frontera exacta.
- PB2002 es un modelo de 2003.
- El USGS es completo desde M4.5 fuera de EE. UU.
- La copia del servidor vive en memoria de cada instancia; se pierde al reiniciarse.
