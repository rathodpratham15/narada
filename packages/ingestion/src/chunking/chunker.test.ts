import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTRACTION_LIMITS, plainTextOf, type Block, type ExtractedDocument, type OffsetBasis } from '../model';
import { markdownExtractor } from '../extractors/markdown';
import { txtExtractor } from '../extractors/txt';
import { chunkDocument, type ChunkContext } from './chunker';
import { CHUNKER_VERSION, validateChunkingConfig, type ChunkingConfig } from './config';
import { approxTokenCounter } from './tokens';

const ctx: ChunkContext = { sourceId: 'source-1', documentId: 'doc-1', documentVersionId: 'version-1' };
const config: ChunkingConfig = { targetTokens: 100, maxTokens: 140, overlapTokens: 30 };
const count = approxTokenCounter.count;

/** n unique words, so any repeated word in the output is provably overlap. */
const words = (n: number, prefix = 'w', from = 0) => Array.from({ length: n }, (_, i) => `${prefix}${from + i}`).join(' ');

function makeDoc(blocks: Block[], basis: OffsetBasis = 'document_text', method = 'test-method@1'): ExtractedDocument {
  return {
    format: 'txt',
    extractionMethod: method,
    offsetBasis: basis,
    metadata: { title: null, author: null, pageCount: null, encoding: null },
    pages: [],
    blocks,
    text: plainTextOf(blocks),
    warnings: [],
  };
}

/** Builds blocks with sequential, exact offsets (as a document_text extractor would). */
type Spec = Block extends infer B ? (B extends Block ? Omit<B, 'page' | 'offsets'> & { page?: number | null } : never) : never;
function sequential(specs: Spec[]): Block[] {
  let cursor = 0;
  return specs.map((spec) => {
    const text = (spec as { text: string }).text;
    const block = { ...spec, page: spec.page ?? null, offsets: { start: cursor, end: cursor + text.length } } as Block;
    cursor += text.length + 2;
    return block;
  });
}
const para = (text: string) => ({ kind: 'paragraph' as const, text });
const heading = (level: number, text: string) => ({ kind: 'heading' as const, level, text });

const chunk = (doc: ExtractedDocument, cfg = config) => chunkDocument(doc, ctx, cfg);

describe('structure and headings', () => {
  const doc = makeDoc(
    sequential([
      para('Preface before any heading.'),
      heading(1, 'Book'),
      para('Intro text.'),
      heading(2, 'Chapter 1'),
      para('Chapter one text.'),
      heading(3, 'Section 1.1'),
      para('Section text.'),
      heading(2, 'Chapter 2'),
      para('Chapter two text.'),
    ]),
  );

  it('attaches the full heading hierarchy and a section id to each chunk', () => {
    expect(chunk(doc).map((c) => [c.headingPath, c.sectionId, c.content])).toEqual([
      [[], null, 'Preface before any heading.'],
      [['Book'], '1', 'Intro text.'],
      [['Book', 'Chapter 1'], '1.1', 'Chapter one text.'],
      [['Book', 'Chapter 1', 'Section 1.1'], '1.1.1', 'Section text.'],
      [['Book', 'Chapter 2'], '1.2', 'Chapter two text.'],
    ]);
  });

  it('never lets a chunk cross a heading, even when everything would fit in one chunk', () => {
    const chunks = chunk(doc);
    expect(chunks).toHaveLength(5);
    for (const c of chunks) expect(c.content).not.toMatch(/Chapter \d text.*Section/s);
  });

  it('handles skipped heading levels and documents that start below H1', () => {
    const skipped = makeDoc(sequential([heading(2, 'Top'), para('a'), heading(4, 'Deep'), para('b'), heading(2, 'Next'), para('c')]));
    expect(chunk(skipped).map((c) => [c.headingPath, c.sectionId])).toEqual([
      [['Top'], '1'],
      [['Top', 'Deep'], '1.1'],
      [['Next'], '2'],
    ]);
  });

  it('produces no chunks for a document that is only headings', () => {
    expect(chunk(makeDoc(sequential([heading(1, 'A'), heading(2, 'B')])))).toEqual([]);
  });
});

describe('overlap', () => {
  const longSection = makeDoc(sequential(Array.from({ length: 12 }, (_, i) => para(words(50, `p${i}_`)))));

  function longestOverlap(prev: string, next: string): number {
    for (let len = Math.min(prev.length, next.length); len > 0; len--) if (prev.endsWith(next.slice(0, len))) return len;
    return 0;
  }

  it('starts each chunk with the tail of the previous one, within the token budget', () => {
    const chunks = chunk(longSection);
    expect(chunks.length).toBeGreaterThan(3);
    for (let i = 1; i < chunks.length; i++) {
      const len = longestOverlap(chunks[i - 1]!.content, chunks[i]!.content);
      expect(len, `chunk ${i} should repeat the end of chunk ${i - 1}`).toBeGreaterThan(0);
      expect(count(chunks[i]!.content.slice(0, len))).toBeLessThanOrEqual(config.overlapTokens);
    }
  });

  it('overlaps on whole-sentence boundaries when sentences exist', () => {
    const sentences = (tag: string) => Array.from({ length: 6 }, (_, i) => `${tag} sentence number ${i} is here.`).join(' ');
    const doc = makeDoc(sequential([para(sentences('A')), para(sentences('B')), para(sentences('C'))]));
    const chunks = chunk(doc, { targetTokens: 60, maxTokens: 120, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const len = longestOverlap(chunks[i - 1]!.content, chunks[i]!.content);
      const overlap = chunks[i]!.content.slice(0, len);
      // starts at a sentence start and ends at a sentence end: one or more whole sentences
      expect(overlap).toMatch(/^(?:[A-C] sentence number \d is here\.\s?)+$/);
    }
  });

  it('does no overlap when overlapTokens is 0: no word appears in two chunks', () => {
    const chunks = chunk(longSection, { ...config, overlapTokens: 0 });
    const seen = new Set<string>();
    for (const c of chunks) {
      for (const w of c.content.split(/\s+/)) {
        expect(seen.has(w), `${w} repeated`).toBe(false);
        seen.add(w);
      }
    }
    expect(seen.size).toBe(12 * 50);
  });

  it('never overlaps across a section boundary', () => {
    const doc = makeDoc(
      sequential([heading(1, 'One'), ...Array.from({ length: 6 }, (_, i) => para(words(50, `a${i}_`))), heading(1, 'Two'), ...Array.from({ length: 6 }, (_, i) => para(words(50, `b${i}_`)))]),
    );
    const chunks = chunk(doc);
    const firstOfTwo = chunks.find((c) => c.headingPath[0] === 'Two')!;
    expect(firstOfTwo.content).not.toMatch(/\ba\d_/);
  });

  it('does not overlap code or tables', () => {
    const code = sequential([{ kind: 'code' as const, language: 'js', text: Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n') }]);
    const chunks = chunk(makeDoc(code));
    expect(chunks.length).toBeGreaterThan(1);
    const lines = chunks.flatMap((c) => c.content.split('\n'));
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe('oversized blocks are split deterministically and losslessly', () => {
  it('splits a huge paragraph so every chunk is within maxTokens and nothing is lost', () => {
    const text = words(1500);
    const chunks = chunk(makeDoc(sequential([para(text)])), { ...config, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(count(c.content)).toBeLessThanOrEqual(config.maxTokens);
    expect(chunks.map((c) => c.content).join(' ')).toBe(text);
  });

  it('keeps chunks within maxTokens even when overlap is on', () => {
    const chunks = chunk(makeDoc(sequential([para(words(1500))])));
    for (const c of chunks) expect(count(c.content)).toBeLessThanOrEqual(config.maxTokens);
    const all = new Set(chunks.flatMap((c) => c.content.split(' ')));
    expect(all.size).toBe(1500);
  });

  it('splits a huge code block on line boundaries and keeps every line intact', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} = value_${i}`);
    const chunks = chunk(makeDoc(sequential([{ kind: 'code' as const, language: null, text: lines.join('\n') }])));
    expect(chunks.flatMap((c) => c.content.split('\n'))).toEqual(lines);
    for (const c of chunks) expect(count(c.content)).toBeLessThanOrEqual(config.maxTokens);
  });

  it('repeats the table header on every part of a split table', () => {
    const header = ['Name', 'Value'];
    const rows = Array.from({ length: 200 }, (_, i) => [`row${i}`, `val${i}`]);
    const text = [header, ...rows].map((r) => r.join(' | ')).join('\n');
    const chunks = chunk(makeDoc(sequential([{ kind: 'table' as const, header, rows, text }])));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.content.startsWith('Name | Value')).toBe(true);
    const bodyRows = chunks.flatMap((c) => c.content.split('\n').filter((l) => l.startsWith('row')));
    expect(bodyRows).toEqual(rows.map((r) => r.join(' | ')));
  });

  it('keeps small structured blocks whole', () => {
    const table = { kind: 'table' as const, header: ['a', 'b'], rows: [['1', '2'], ['3', '4']], text: 'a | b\n1 | 2\n3 | 4' };
    const list = { kind: 'list' as const, ordered: false, items: [], text: '- one\n- two\n- three' };
    const chunks = chunk(makeDoc(sequential([para('Intro.'), table, list])));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('a | b\n1 | 2\n3 | 4');
    expect(chunks[0]!.content).toContain('- one\n- two\n- three');
  });

  it('produces identical splits on repeated runs', () => {
    const doc = makeDoc(sequential([para(words(900))]));
    expect(chunk(doc).map((c) => c.content)).toEqual(chunk(doc).map((c) => c.content));
  });
});

describe('multilingual text is never damaged', () => {
  const combining = /^[ऀ-ःऺ-ॏ॑-ॗॢॣ‍]/;

  it('splits long Devanagari text only at sentence boundaries (danda), preserving every character', () => {
    // Sentences of deliberately uneven length, so chunk boundaries cannot line up with sentence ends by luck:
    // only genuinely sentence-aware splitting can make every chunk end on a danda.
    const sentences = [
      'रामो विग्रहवान् धर्मः सत्यं वद धर्मं चर।',
      'सत्यमेव जयते।',
      'धर्मक्षेत्रे कुरुक्षेत्रे समवेता युयुत्सवः मामकाः पाण्डवाश्चैव किमकुर्वत सञ्जय॥',
      'अहिंसा परमो धर्मः।',
    ];
    const text = Array.from({ length: 120 }, (_, i) => sentences[(i * 7) % sentences.length]!).join(' ');
    const chunks = chunk(makeDoc(sequential([para(text)])), { ...config, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(/[।॥]$/.test(c.content), `chunk ends mid-sentence: …${c.content.slice(-20)}`).toBe(true);
      expect(c.content).not.toContain('�');
      expect(count(c.content)).toBeLessThanOrEqual(config.maxTokens);
    }
    expect(chunks.map((c) => c.content).join(' ')).toBe(text);
  });

  it('estimates more tokens per character for Devanagari than for English', () => {
    expect(count('धर्मक्षेत्रे')).toBeGreaterThan(count('abcdefghijk'));
    expect(count('')).toBe(0);
    expect(count('a')).toBe(1);
  });

  it('hard-splits unbroken text at grapheme boundaries: conjuncts and matras stay attached', () => {
    const text = 'क्षत्रियः'.repeat(700);
    const chunks = chunk(makeDoc(sequential([para(text)])), { ...config, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(combining.test(c.content), `chunk starts with a combining mark: ${[...c.content.slice(0, 3)].map((ch) => ch.codePointAt(0)!.toString(16))}`).toBe(false);
      expect(c.content).not.toContain('�');
    }
    expect(chunks.map((c) => c.content).join('')).toBe(text);
  });

  it('never splits an emoji ZWJ sequence or a surrogate pair', () => {
    const family = '👨‍👩‍👧‍👦';
    const chunks = chunk(makeDoc(sequential([para(family.repeat(600))])), { ...config, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.content).toBe(family.repeat(c.content.length / family.length));
      expect(c.content).not.toContain('�');
    }
  });

  it('splits CJK text without spaces and loses nothing', () => {
    const text = '日本語のテキストです。'.repeat(150).replace(/。/g, '');
    const chunks = chunk(makeDoc(sequential([para(text)])), { ...config, overlapTokens: 0 });
    expect(chunks.map((c) => c.content).join('')).toBe(text);
    for (const c of chunks) expect(count(c.content)).toBeLessThanOrEqual(config.maxTokens);
  });
});

describe('determinism and identity', () => {
  const doc = makeDoc(sequential([heading(1, 'H'), para(words(400))]));

  it('returns identical chunks and ids for identical input and configuration', () => {
    expect(chunk(doc)).toEqual(chunk(doc));
  });

  it('gives each chunk a unique, stable id and a gapless sequence number', () => {
    const chunks = chunk(doc);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
    for (const c of chunks) expect(c.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('isolates versions: another document version yields different ids for the same content', () => {
    const a = chunkDocument(doc, ctx, config);
    const b = chunkDocument(doc, { ...ctx, documentVersionId: 'version-2' }, config);
    expect(a.map((c) => c.content)).toEqual(b.map((c) => c.content));
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id));
    expect(new Set([...a, ...b].map((c) => c.id)).size).toBe(a.length + b.length);
  });

  it('changes ids and the config hash when the configuration changes', () => {
    const a = chunk(doc);
    const b = chunk(doc, { ...config, targetTokens: 110 });
    expect(a[0]!.chunkingConfigHash).not.toBe(b[0]!.chunkingConfigHash);
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id));
  });

  it('carries complete provenance on every chunk', () => {
    for (const c of chunk(doc)) {
      expect(c).toMatchObject({
        sourceId: 'source-1',
        documentId: 'doc-1',
        documentVersionId: 'version-1',
        extractionMethod: 'test-method@1',
        chunkerVersion: CHUNKER_VERSION,
      });
      expect(c.chunkingConfigHash).toMatch(/^[0-9a-f]{16}$/);
      expect(c.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(c.tokenEstimate).toBeGreaterThan(0);
      expect(c.headingPath).toEqual(['H']);
    }
  });
});

describe('source locations', () => {
  it('reports page ranges and page-relative offsets for paged documents', () => {
    const blocks: Block[] = [
      { kind: 'paragraph', text: 'Page one text.', page: 1, offsets: { start: 0, end: 14 } },
      { kind: 'paragraph', text: 'More on page one.', page: 1, offsets: { start: 16, end: 33 } },
      { kind: 'paragraph', text: 'Page three text.', page: 3, offsets: { start: 0, end: 16 } },
    ];
    const [only] = chunk(makeDoc(blocks, 'page_text'));
    expect(only).toMatchObject({ pageStart: 1, pageEnd: 3, charStart: 0, charEnd: 16, offsetBasis: 'page_text' });
    expect(only!.locator).toEqual({ kind: 'page_range', pageStart: 1, pageEnd: 3 });
  });

  it('reports a cross-page chunk whose end offset is smaller than its start offset (page-relative offsets)', () => {
    const blocks: Block[] = [
      { kind: 'paragraph', text: words(75, 'big'), page: 1, offsets: { start: 0, end: 4000 } },
      { kind: 'paragraph', text: 'Late on page one.', page: 1, offsets: { start: 4002, end: 4019 } },
      { kind: 'paragraph', text: 'Early on page two.', page: 2, offsets: { start: 0, end: 18 } },
    ];
    const chunks = chunk(makeDoc(blocks, 'page_text'), { targetTokens: 100, maxTokens: 140, overlapTokens: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({ pageStart: 1, pageEnd: 2, charStart: 4002, charEnd: 18, offsetBasis: 'page_text' });
  });

  it('gives single-page chunks a single-page locator, and keeps pages in order across chunks', () => {
    const blocks: Block[] = [1, 2, 3].map((page) => ({
      kind: 'paragraph' as const,
      text: words(70, `pg${page}_`),
      page,
      offsets: { start: 0, end: words(70, `pg${page}_`).length },
    }));
    const chunks = chunk(makeDoc(blocks, 'page_text'), { targetTokens: 100, maxTokens: 140, overlapTokens: 0 });
    expect(chunks.map((c) => [c.pageStart, c.pageEnd])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(chunks.map((c) => c.locator)).toEqual([{ kind: 'page', page: 1 }, { kind: 'page', page: 2 }, { kind: 'page', page: 3 }]);
  });

  it('widens the page range to include the page an overlap came from', () => {
    const blocks: Block[] = [1, 2].map((page) => ({
      kind: 'paragraph' as const,
      text: words(40, `pg${page}_`),
      page,
      offsets: { start: 0, end: 10 },
    }));
    const chunks = chunk(makeDoc(blocks, 'page_text'));
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.content).toMatch(/^pg1_\d+/); // begins with the overlap taken from page 1
    expect(chunks[1]!.pageStart).toBe(1);
    expect(chunks[1]!.pageEnd).toBe(2);
  });

  it('drops the overlap rather than exceed maxTokens', () => {
    const blocks: Block[] = [1, 2].map((page) => ({
      kind: 'paragraph' as const,
      text: words(70, `pg${page}_`),
      page,
      offsets: { start: 0, end: 10 },
    }));
    const chunks = chunk(makeDoc(blocks, 'page_text'));
    expect(chunks[1]!.content.startsWith('pg2_')).toBe(true);
    expect(chunks[1]!.pageStart).toBe(2);
  });

  it('points text and Markdown chunks back into the original text', async () => {
    const source = Array.from({ length: 8 }, (_, i) => words(45, `para${i}_`)).join('\n\n');
    const result = await txtExtractor.extract({ bytes: new TextEncoder().encode(source), filename: null }, DEFAULT_EXTRACTION_LIMITS);
    if (!result.ok) throw new Error('extract failed');
    const chunks = chunk(result.document, { ...config, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.offsetBasis).toBe('document_text');
      expect(c.locator).toEqual({ kind: 'text_range', start: c.charStart, end: c.charEnd });
      const region = source.slice(c.charStart!, c.charEnd!);
      expect(region.replace(/\n\n/g, ' ')).toBe(c.content);
    }
    expect(chunks.map((c) => c.charStart)).toEqual([...chunks.map((c) => c.charStart!)].sort((a, b) => a - b));
  });

  it('chunks a real Markdown document with headings, a table, a list and code', async () => {
    const md = `# Guide\n\nIntro paragraph.\n\n## Install\n\n- step one\n- step two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\`\`\`sh\nnpm i\n\`\`\`\n\n## Usage\n\nRun it.\n`;
    const result = await markdownExtractor.extract({ bytes: new TextEncoder().encode(md), filename: null }, DEFAULT_EXTRACTION_LIMITS);
    if (!result.ok) throw new Error('extract failed');
    const chunks = chunk(result.document);
    expect(chunks.map((c) => c.headingPath)).toEqual([['Guide'], ['Guide', 'Install'], ['Guide', 'Usage']]);
    expect(chunks[1]!.content).toContain('- step one');
    expect(chunks[1]!.content).toContain('a | b');
    expect(chunks[1]!.content).toContain('npm i');
    for (const c of chunks) expect(md.slice(c.charStart!, c.charEnd!).length).toBeGreaterThan(0);
  });
});

describe('configuration', () => {
  it('rejects inconsistent configurations', () => {
    expect(() => validateChunkingConfig({ targetTokens: 10, maxTokens: 50, overlapTokens: 0 })).toThrow(/targetTokens/);
    expect(() => validateChunkingConfig({ targetTokens: 100, maxTokens: 50, overlapTokens: 0 })).toThrow(/maxTokens/);
    expect(() => validateChunkingConfig({ targetTokens: 100, maxTokens: 150, overlapTokens: 100 })).toThrow(/overlapTokens/);
    expect(() => validateChunkingConfig({ targetTokens: 100.5, maxTokens: 150, overlapTokens: 0 })).toThrow(/integers/);
  });

  it('accepts a custom token counter, so chunking can follow a provider tokenizer', () => {
    const everyCharIsAToken = { name: 'chars', count: (t: string) => t.length };
    const doc = makeDoc(sequential([para('x'.repeat(1000))]));
    const chunks = chunkDocument(doc, ctx, { targetTokens: 200, maxTokens: 250, overlapTokens: 0 }, everyCharIsAToken);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(250);
  });
});
