import { buildPdf, truncatePdf, type PdfPageSpec } from '@narada/test-utils';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTRACTION_LIMITS, type ExtractedDocument } from '../model';
import { pdfExtractor } from './pdf';

const run = (bytes: Uint8Array, limits = DEFAULT_EXTRACTION_LIMITS) => pdfExtractor.extract({ bytes, filename: 'a.pdf' }, limits);

async function ok(bytes: Uint8Array): Promise<ExtractedDocument> {
  const result = await run(bytes);
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.document;
}

const textPage = (...lines: string[]): PdfPageSpec => ({ lines: lines.map((text) => ({ text })) });

describe('PDF extraction', () => {
  it('extracts page by page and attributes every block to its page', async () => {
    const doc = await ok(
      buildPdf([
        { lines: [{ text: 'Chapter One', size: 20 }, { text: 'Rama accepted exile.' }, { text: 'He honoured his father.' }, { text: 'A second paragraph.', gapBefore: 14 }] },
        textPage('Page two content here.'),
        textPage('Page three: café résumé naïve.'),
      ]),
    );
    expect(doc.metadata.pageCount).toBe(3);
    expect(doc.pages.map((p) => p.kind)).toEqual(['text', 'text', 'text']);
    expect(doc.blocks.map((b) => [b.page, b.kind, b.text])).toEqual([
      [1, 'heading', 'Chapter One'],
      [1, 'paragraph', 'Rama accepted exile. He honoured his father.'],
      [1, 'paragraph', 'A second paragraph.'],
      [2, 'paragraph', 'Page two content here.'],
      [3, 'paragraph', 'Page three: café résumé naïve.'],
    ]);
    expect(doc.offsetBasis).toBe('page_text');
  });

  it('detects headings by relative font size and ranks their levels', async () => {
    const doc = await ok(
      buildPdf([
        { lines: [{ text: 'Big Title', size: 24 }, { text: 'Subtitle here', size: 16 }, { text: 'Body text goes here in normal size.' }, { text: 'More body text on the next line.' }] },
      ]),
    );
    const headings = doc.blocks.filter((b) => b.kind === 'heading');
    expect(headings.map((h) => [h.text, (h as { level: number }).level])).toEqual([['Big Title', 1], ['Subtitle here', 2]]);
  });

  it('gives page-relative offsets that point back at the block text', async () => {
    const doc = await ok(buildPdf([textPage('First line of page one.'), { lines: [{ text: 'Alpha para.' }, { text: 'Beta para after gap.', gapBefore: 20 }] }]));
    for (const page of [1, 2]) {
      const blocks = doc.blocks.filter((b) => b.page === page);
      const pageText = blocks.map((b) => b.text).join('\n\n');
      for (const block of blocks) expect(pageText.slice(block.offsets!.start, block.offsets!.end)).toBe(block.text);
    }
  });

  it('reads title metadata only when the document has one', async () => {
    expect((await ok(buildPdf([textPage('hello')], { title: 'A Real Title' }))).metadata.title).toBe('A Real Title');
    expect((await ok(buildPdf([textPage('hello')]))).metadata.title).toBeNull();
  });

  it('records empty pages as a warning and still extracts the rest', async () => {
    const doc = await ok(buildPdf([textPage('before'), { lines: [] }, { lines: [] }, textPage('after')]));
    expect(doc.pages.map((p) => p.kind)).toEqual(['text', 'blank', 'blank', 'text']);
    const warning = doc.warnings.find((w) => w.code === 'EMPTY_PAGES');
    expect(warning?.pages).toEqual([2, 3]);
    expect(doc.blocks.map((b) => b.page)).toEqual([1, 4]);
  });

  it('fails a fully scanned (image-only) PDF with OCR_REQUIRED instead of reporting success', async () => {
    const result = await run(buildPdf([{ image: true }, { image: true }, { image: true }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('OCR_REQUIRED');
    expect(result.error.details).toMatchObject({ totalPages: 3, textPages: 0, imageOnlyPages: [1, 2, 3] });
    expect(result.warnings.map((w) => w.code)).toContain('IMAGE_ONLY_PAGES');
  });

  it('fails when most pages are scans, rather than silently indexing the few that have text', async () => {
    const result = await run(buildPdf([textPage('one real page'), { image: true }, { image: true }]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('OCR_REQUIRED');
      expect(result.error.details).toMatchObject({ textPages: 1, imageOnlyPages: [2, 3] });
    }
  });

  it('accepts a minority of scanned pages but lists them in a warning', async () => {
    const doc = await ok(buildPdf([textPage('a'), textPage('b'), textPage('c'), { image: true }]));
    expect(doc.warnings.find((w) => w.code === 'IMAGE_ONLY_PAGES')?.pages).toEqual([4]);
    expect(doc.pages[3]!.kind).toBe('image_only');
  });

  it('distinguishes a blank document from a scanned one', async () => {
    const result = await run(buildPdf([{ lines: [] }, { lines: [] }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_EXTRACTABLE_TEXT');
  });

  it('rejects truncated and garbage PDFs as MALFORMED_DOCUMENT', async () => {
    const pdf = buildPdf([textPage('some text')]);
    for (const bytes of [truncatePdf(pdf, 0.3), new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf')]) {
      const result = await run(bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('MALFORMED_DOCUMENT');
    }
  });

  it('refuses password-protected PDFs safely, without trying passwords', async () => {
    const result = await run(buildPdf([textPage('secret')], { userPassword: 'hunter2' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ENCRYPTED_PDF');
      expect(result.error.details).toMatchObject({ reason: 'password_required' });
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  it('enforces the page limit before extracting', async () => {
    const result = await run(buildPdf(Array.from({ length: 5 }, (_, i) => textPage(`p${i}`))), { ...DEFAULT_EXTRACTION_LIMITS, maxPages: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { pages: 5, maxPages: 3 } });
  });

  it('enforces the byte limit and the extracted-text limit', async () => {
    const pdf = buildPdf([textPage('x'.repeat(200))]);
    const bytes = await run(pdf, { ...DEFAULT_EXTRACTION_LIMITS, maxBytes: 100 });
    expect(!bytes.ok && bytes.error.code).toBe('LIMIT_EXCEEDED');
    const text = await run(pdf, { ...DEFAULT_EXTRACTION_LIMITS, maxTextChars: 50 });
    expect(!text.ok && text.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('times out instead of hanging', async () => {
    const pdf = buildPdf(Array.from({ length: 40 }, (_, i) => textPage(`page ${i} text`)));
    const result = await run(pdf, { ...DEFAULT_EXTRACTION_LIMITS, timeoutMs: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EXTRACTION_TIMEOUT');
  });

  it('leaves the caller’s buffer intact (pdf.js would otherwise detach it)', async () => {
    const pdf = buildPdf([textPage('hello')]);
    const before = pdf.length;
    await run(pdf);
    expect(pdf.length).toBe(before);
    expect(await run(pdf)).toMatchObject({ ok: true });
  });
});
