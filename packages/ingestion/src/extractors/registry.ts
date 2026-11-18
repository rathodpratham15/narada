import type { DocumentFormat, Extractor } from '../model';
import { markdownExtractor } from './markdown';
import { pdfExtractor } from './pdf';
import { txtExtractor } from './txt';

const extractors: Record<DocumentFormat, Extractor> = {
  pdf: pdfExtractor,
  txt: txtExtractor,
  markdown: markdownExtractor,
};

export const FORMAT_MIME: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  markdown: 'text/markdown',
};

export function extractorFor(format: DocumentFormat): Extractor {
  return extractors[format];
}

export function formatFromMime(mimeType: string): DocumentFormat | null {
  const entry = (Object.entries(FORMAT_MIME) as Array<[DocumentFormat, string]>).find(([, mime]) => mime === mimeType);
  return entry ? entry[0] : null;
}
