import type { Metadata } from 'next';
import EngineLab from '@/components/EngineLab';

export const metadata: Metadata = {
  title: 'Motor gráfico · laboratorio',
  robots: { index: false, follow: false },
};

export default function EngineLabPage() {
  return <EngineLab />;
}
