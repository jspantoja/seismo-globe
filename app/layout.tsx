import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SeismoGlobe — Placas tectónicas y sismos en tiempo real',
  description:
    'Globo 3D interactivo con placas tectónicas, microplacas y actividad sísmica en tiempo real, con datos de USGS y fuentes públicas.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
