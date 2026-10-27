import '@/app/openmaic/fonts.css';
import '@/app/openmaic/editor-fonts';
import 'animate.css';
import 'katex/dist/katex.min.css';
import '@/app/openmaic/globals.css';
import { SlideExportClient } from './slide-export-client';

export const metadata = { title: 'Slide export', robots: { index: false, follow: false } };

/** Empty until the server's isolated browser supplies one page in memory. */
export default function SlideExportPage() {
  return <SlideExportClient />;
}
