import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTRACTION_LIMITS, type ExtractedDocument } from '../model';
import { decodeText } from '../text-decoding';
import { txtExtractor } from './txt';

const enc = (s: string) => new TextEncoder().encode(s);
const run = (bytes: Uint8Array) => txtExtractor.extract({ bytes, filename: 'a.txt' }, DEFAULT_EXTRACTION_LIMITS);

async function ok(bytes: Uint8Array): Promise<ExtractedDocument> {
  const result = await run(bytes);
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.document;
}

describe('TXT extraction', () => {
  it('splits paragraphs on blank lines and keeps single line breaks (verse survives)', async () => {
    const doc = await ok(enc('line one\nline two\n\n\n\nsecond paragraph\n'));
    expect(doc.blocks.map((b) => b.text)).toEqual(['line one\nline two', 'second paragraph']);
    expect(doc.blocks.every((b) => b.kind === 'paragraph' && b.page === null)).toBe(true);
    expect(doc.offsetBasis).toBe('document_text');
  });

  it('normalises CRLF and CR to LF without altering content', async () => {
    const doc = await ok(enc('a\r\nb\r\n\r\nc\rd\r\r\re'));
    expect(doc.blocks.map((b) => b.text)).toEqual(['a\nb', 'c\nd', 'e']);
    expect(doc.blocks.some((b) => b.text.includes('\r'))).toBe(false);
  });

  it('records exact offsets into the decoded original, even with CRLF', async () => {
    const source = 'Alpha\r\nBeta\r\n\r\nGamma  with   spaces\r\n';
    const doc = await ok(enc(source));
    for (const block of doc.blocks) {
      const { start, end } = block.offsets!;
      expect(source.slice(start, end).replace(/\r\n|\r/g, '\n')).toBe(block.text);
    }
  });

  it('preserves Devanagari exactly, with no normalization or replacement', async () => {
    const text = 'रामो विग्रहवान् धर्मः।\nसत्यं वद, धर्मं चर॥';
    const doc = await ok(enc(text));
    expect(doc.blocks[0]!.text).toBe(text);
    expect(doc.text).not.toContain('�');
  });

  it('preserves other scripts and astral characters', async () => {
    const text = 'Ελληνικά — 日本語のテキスト — العربية — தமிழ் — 👨‍👩‍👧‍👦 𝒳';
    const doc = await ok(enc(text));
    expect(doc.blocks[0]!.text).toBe(text);
  });

  it('strips a UTF-8 BOM and reports the encoding; offsets exclude the BOM', async () => {
    const doc = await ok(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('hello\n\nworld')]));
    expect(doc.metadata.encoding).toBe('utf-8-bom');
    expect(doc.blocks[0]!.text).toBe('hello');
    expect(doc.blocks[0]!.offsets).toEqual({ start: 0, end: 5 });
  });

  it('decodes UTF-16 text that carries a BOM', async () => {
    const body = Buffer.from('सत्यमेव जयते', 'utf16le');
    const doc = await ok(new Uint8Array([0xff, 0xfe, ...body]));
    expect(doc.metadata.encoding).toBe('utf-16le');
    expect(doc.blocks[0]!.text).toBe('सत्यमेव जयते');
  });

  it('keeps invalid UTF-8 usable but reports every replacement as a warning', async () => {
    const bytes = new Uint8Array([...enc('good text '), 0xff, 0xfe, 0x80, ...enc(' more good text, long enough to dominate')]);
    const result = await run(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.document.warnings.find((w) => w.code === 'INVALID_ENCODING_REPLACED');
    expect(warning).toBeDefined();
    expect((warning!.details as { replacedCharacters: number }).replacedCharacters).toBeGreaterThan(0);
    expect(result.document.text).toContain('�');
  });

  it('rejects mostly-undecodable input instead of indexing garbage', async () => {
    const garbage = new Uint8Array(200).map((_, i) => 0x80 + (i % 64));
    const result = await run(garbage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ENCODING');
  });

  it('rejects binary data containing NUL bytes', async () => {
    const result = await run(new Uint8Array([0x68, 0x69, 0x00, 0x01, 0x02]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ENCODING');
      expect(result.error.details).toMatchObject({ firstNulByteOffset: 2 });
    }
  });

  it('fails explicitly on empty or whitespace-only files', async () => {
    for (const bytes of [new Uint8Array(0), enc('  \n\n \t\r\n')]) {
      const result = await run(bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NO_EXTRACTABLE_TEXT');
    }
  });

  it('enforces the byte limit', async () => {
    const result = await txtExtractor.extract({ bytes: enc('x'.repeat(100)), filename: null }, { ...DEFAULT_EXTRACTION_LIMITS, maxBytes: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('LIMIT_EXCEEDED');
  });
});

describe('decodeText', () => {
  it('does not mutate the input buffer', () => {
    const bytes = enc('abc');
    decodeText(bytes);
    expect(Array.from(bytes)).toEqual([97, 98, 99]);
  });
});
