import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  failure,
  plainTextOf,
  type Block,
  type ExtractInput,
  type ExtractionLimits,
  type ExtractionResult,
  type ExtractionWarning,
  type Extractor,
  type PageInfo,
} from '../model';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsPromise: Promise<PdfJs> | undefined;
const loadPdfJs = (): Promise<PdfJs> => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

const require_ = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require_.resolve('pdfjs-dist/package.json'));
const PDFJS_VERSION = (require_('pdfjs-dist/package.json') as { version: string }).version;

export const PDF_EXTRACTION_METHOD = `pdf-text@1.0.0+pdfjs-${PDFJS_VERSION}`;

interface PositionedLine {
  page: number;
  text: string;
  /** Baseline y in PDF space (origin bottom-left); larger = higher on the page. */
  y: number;
  /** Largest glyph height on the line, ≈ font size. */
  height: number;
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

const IMAGE_OP_NAMES = [
  'paintImageXObject',
  'paintImageXObjectRepeat',
  'paintInlineImageXObject',
  'paintInlineImageXObjectGroup',
  'paintImageMaskXObject',
  'paintImageMaskXObjectGroup',
  'paintImageMaskXObjectRepeat',
] as const;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

class Timeout extends Error {}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Rebuilds lines from pdf.js text items in content-stream order. Order is deliberately NOT re-sorted by
 * coordinates: most producers write text in reading order (including multi-column layouts), and sorting by y
 * would interleave columns. Layout-driven reordering is a known limitation (see docs).
 */
function buildLines(items: TextItemLike[], page: number): PositionedLine[] {
  const lines: PositionedLine[] = [];
  let current: { text: string; y: number; height: number; endX: number } | null = null;

  const close = () => {
    if (current && current.text.trim()) {
      lines.push({ page, text: current.text, y: current.y, height: current.height });
    }
    current = null;
  };

  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform[5] ?? 0;
    const x = item.transform[4] ?? 0;
    const height = item.height || Math.abs(item.transform[3] ?? 0) || 0;

    if (item.str === '') {
      if (item.hasEOL) close();
      continue;
    }
    if (current && Math.abs(y - current.y) > 0.5 * Math.max(height, current.height, 1)) close();

    if (!current) {
      current = { text: item.str, y, height, endX: x + item.width };
    } else {
      const gap = x - current.endX;
      const needsSpace = gap > 0.15 * Math.max(height, 1) && !current.text.endsWith(' ') && !item.str.startsWith(' ');
      current.text += (needsSpace ? ' ' : '') + item.str;
      current.height = Math.max(current.height, height);
      current.endX = x + item.width;
    }
    if (item.hasEOL) close();
  }
  close();
  return lines;
}

function cleanText(text: string, counter: { removed: number }): string {
  const cleaned = text.replace(CONTROL_CHARS, () => {
    counter.removed++;
    return '';
  });
  return cleaned.replace(/[ \t]+/g, ' ').trim();
}

/** Groups a page's lines into paragraphs using vertical gaps relative to that page's normal line pitch. */
function groupParagraphs(lines: PositionedLine[]): PositionedLine[][] {
  if (lines.length === 0) return [];
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) pitches.push(lines[i - 1]!.y - lines[i]!.y);
  const forward = pitches.filter((p) => p > 0);
  const medianPitch = forward.length >= 3 ? median(forward) : 0;

  const groups: PositionedLine[][] = [[lines[0]!]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!;
    const line = lines[i]!;
    const gap = prev.y - line.y;
    const threshold = Math.max(1.6 * Math.max(prev.height, line.height, 1), 1.45 * medianPitch);
    const newParagraph = gap > threshold || gap < 0 || Math.abs(line.height - prev.height) > 0.5;
    if (newParagraph) groups.push([line]);
    else groups[groups.length - 1]!.push(line);
  }
  return groups;
}

/** Most common line height weighted by characters ≈ body text size. */
function bodySize(allLines: PositionedLine[]): number {
  const weight = new Map<number, number>();
  for (const line of allLines) {
    const key = Math.round(line.height * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, w] of weight) {
    if (w > bestWeight || (w === bestWeight && size > best)) {
      best = size;
      bestWeight = w;
    }
  }
  return best;
}

function describeFailure(error: unknown): { name: string; message: string } {
  const e = error as { name?: string; message?: string };
  return { name: e?.name ?? 'Error', message: String(e?.message ?? error).slice(0, 300) };
}

export const pdfExtractor: Extractor = {
  format: 'pdf',
  extractionMethod: PDF_EXTRACTION_METHOD,

  async extract(input: ExtractInput, limits: ExtractionLimits): Promise<ExtractionResult> {
    if (input.bytes.length > limits.maxBytes) {
      return failure('LIMIT_EXCEEDED', `File exceeds the ${limits.maxBytes}-byte limit.`, [], { maxBytes: limits.maxBytes });
    }
    const pdfjs = await loadPdfJs();

    // pdf.js takes ownership of the buffer it is given, so hand it a copy and keep the caller's bytes intact.
    const task = pdfjs.getDocument({
      data: new Uint8Array(input.bytes),
      // pdfjs-dist 6 no longer evaluates dynamic code (no `new Function`), so there is no isEvalSupported switch.
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
      cMapUrl: join(PDFJS_ROOT, 'cmaps') + '/',
      cMapPacked: true,
      standardFontDataUrl: join(PDFJS_ROOT, 'standard_fonts') + '/',
    });

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Timeout());
      }, limits.timeoutMs);
    });

    try {
      return await Promise.race([run(pdfjs, task, limits, () => timedOut), deadline]);
    } catch (error) {
      if (error instanceof Timeout) {
        return failure('EXTRACTION_TIMEOUT', `PDF extraction exceeded the ${limits.timeoutMs} ms limit.`, [], {
          timeoutMs: limits.timeoutMs,
        });
      }
      return classify(error);
    } finally {
      clearTimeout(timer);
      await task.destroy().catch(() => undefined);
    }
  },
};

function classify(error: unknown): ExtractionResult {
  const { name, message } = describeFailure(error);
  if (name === 'PasswordException') {
    return failure(
      'ENCRYPTED_PDF',
      'The PDF is password-protected. Narada does not attempt passwords; supply an unprotected copy.',
      [],
      { reason: (error as { code?: number }).code === 2 ? 'incorrect_password' : 'password_required' },
    );
  }
  if (['InvalidPDFException', 'MissingPDFException', 'FormatError', 'XRefParseException', 'UnexpectedResponseException'].includes(name)) {
    return failure('MALFORMED_DOCUMENT', `The PDF is malformed or truncated: ${message}`, [], { exception: name });
  }
  return failure('EXTRACTION_FAILED', `PDF extraction failed unexpectedly: ${message}`, [], { exception: name });
}

async function run(
  pdfjs: PdfJs,
  task: ReturnType<PdfJs['getDocument']>,
  limits: ExtractionLimits,
  isTimedOut: () => boolean,
): Promise<ExtractionResult> {
  const doc = await task.promise;
  const warnings: ExtractionWarning[] = [];

  if (doc.numPages > limits.maxPages) {
    return failure('LIMIT_EXCEEDED', `The PDF has ${doc.numPages} pages; the limit is ${limits.maxPages}.`, [], {
      pages: doc.numPages,
      maxPages: limits.maxPages,
    });
  }

  let title: string | null = null;
  let author: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const info = (meta.info ?? {}) as { Title?: unknown; Author?: unknown };
    if (typeof info.Title === 'string' && info.Title.trim()) title = info.Title.trim();
    if (typeof info.Author === 'string' && info.Author.trim()) author = info.Author.trim();
  } catch {
    warnings.push({ code: 'PDF_METADATA_UNREADABLE', message: 'The PDF information dictionary could not be read; title and author are unknown.' });
  }

  const pageLines: PositionedLine[][] = [];
  const pageKinds: PageInfo[] = [];
  const control = { removed: 0 };
  let totalChars = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    if (isTimedOut()) throw new Timeout();
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = buildLines(content.items as unknown as TextItemLike[], pageNumber).map((l) => ({
      ...l,
      text: cleanText(l.text, control),
    }));
    const kept = lines.filter((l) => l.text.length > 0);
    const charCount = kept.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0);
    totalChars += charCount;
    if (totalChars > limits.maxTextChars) {
      page.cleanup();
      return failure('LIMIT_EXCEEDED', `Extracted text exceeds ${limits.maxTextChars} characters.`, [], {
        maxTextChars: limits.maxTextChars,
        atPage: pageNumber,
      });
    }

    let kind: PageInfo['kind'] = 'text';
    if (charCount === 0) {
      // No text: distinguish a genuinely blank page from a raster page that needs OCR.
      const ops = await page.getOperatorList();
      const imageOps = new Set<number>(IMAGE_OP_NAMES.map((name) => pdfjs.OPS[name]));
      kind = ops.fnArray.some((fn: number) => imageOps.has(fn)) ? 'image_only' : 'blank';
    }
    page.cleanup();
    pageLines.push(kept);
    pageKinds.push({ page: pageNumber, kind, charCount });
  }

  if (control.removed > 0) {
    warnings.push({
      code: 'CONTROL_CHARACTERS_REMOVED',
      message: `${control.removed} control character(s) were removed from the extracted text.`,
      details: { count: control.removed },
    });
  }

  const blankPages = pageKinds.filter((p) => p.kind === 'blank').map((p) => p.page);
  const imageOnlyPages = pageKinds.filter((p) => p.kind === 'image_only').map((p) => p.page);
  const textPages = pageKinds.length - blankPages.length - imageOnlyPages.length;
  if (blankPages.length) {
    warnings.push({ code: 'EMPTY_PAGES', message: `${blankPages.length} page(s) contain no text or images.`, pages: blankPages });
  }
  if (imageOnlyPages.length) {
    warnings.push({
      code: 'IMAGE_ONLY_PAGES',
      message: `${imageOnlyPages.length} page(s) contain only images; their text needs OCR and is NOT included.`,
      pages: imageOnlyPages,
    });
  }

  const summary = { totalPages: pageKinds.length, textPages, blankPages, imageOnlyPages };
  if (imageOnlyPages.length > 0 && imageOnlyPages.length / pageKinds.length >= limits.ocrRequiredPageRatio) {
    return failure(
      'OCR_REQUIRED',
      textPages === 0
        ? 'The PDF has no extractable text and its pages are images: it appears to be scanned. OCR is required and is not yet supported.'
        : `${imageOnlyPages.length} of ${pageKinds.length} pages are images without text. Indexing only the remainder would silently drop content; OCR is required and is not yet supported.`,
      warnings,
      summary,
    );
  }
  if (textPages === 0) {
    return failure('NO_EXTRACTABLE_TEXT', 'The PDF contains no extractable text.', warnings, summary);
  }

  // Heading levels: sizes clearly larger than body text, largest = level 1.
  const allLines = pageLines.flat();
  const body = bodySize(allLines);
  const headingSizes = [...new Set(allLines.filter((l) => body > 0 && l.height >= body * 1.15).map((l) => Math.round(l.height * 2) / 2))]
    .sort((a, b) => b - a)
    .slice(0, 6);

  const blocks: Block[] = [];
  const pages: PageInfo[] = pageKinds;
  for (const [index, lines] of pageLines.entries()) {
    const page = index + 1;
    let pageOffset = 0;
    for (const group of groupParagraphs(lines)) {
      const text = group.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const size = Math.round(Math.max(...group.map((l) => l.height)) * 2) / 2;
      const level = headingSizes.indexOf(size);
      const isHeading = level !== -1 && text.length <= 160;
      const start = pageOffset;
      const end = start + text.length;
      pageOffset = end + 2; // blocks on a page are joined with "\n\n" in the page's text
      blocks.push(
        isHeading
          ? { kind: 'heading', level: level + 1, text, page, offsets: { start, end } }
          : { kind: 'paragraph', text, page, offsets: { start, end } },
      );
    }
  }

  return {
    ok: true,
    document: {
      format: 'pdf',
      extractionMethod: PDF_EXTRACTION_METHOD,
      offsetBasis: 'page_text',
      metadata: { title, author, pageCount: doc.numPages, encoding: null },
      pages,
      blocks,
      text: plainTextOf(blocks),
      warnings,
    },
  };
}
