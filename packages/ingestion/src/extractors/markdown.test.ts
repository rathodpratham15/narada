import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTRACTION_LIMITS, type Block, type ExtractedDocument } from '../model';
import { markdownExtractor } from './markdown';

const enc = (s: string) => new TextEncoder().encode(s);

async function ok(source: string): Promise<ExtractedDocument> {
  const result = await markdownExtractor.extract({ bytes: enc(source), filename: 'a.md' }, DEFAULT_EXTRACTION_LIMITS);
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.document;
}
const of = <K extends Block['kind']>(doc: ExtractedDocument, kind: K) =>
  doc.blocks.filter((b): b is Extract<Block, { kind: K }> => b.kind === kind);

describe('Markdown extraction', () => {
  it('keeps heading levels in document order (nested hierarchy)', async () => {
    const doc = await ok('# Book\n\n## Chapter 1\n\n### Section 1.1\n\ntext\n\n## Chapter 2\n\nmore\n');
    expect(of(doc, 'heading').map((h) => [h.level, h.text])).toEqual([
      [1, 'Book'],
      [2, 'Chapter 1'],
      [3, 'Section 1.1'],
      [2, 'Chapter 2'],
    ]);
    expect(doc.metadata.title).toBe('Book');
  });

  it('does not invent a title when there is no H1', async () => {
    expect((await ok('## Only a subsection\n\ntext')).metadata.title).toBeNull();
  });

  it('extracts ordered, unordered, nested and task lists as structured items', async () => {
    const doc = await ok('- apple\n  - green\n  - red\n- pear\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n');
    const [bullets, ordered, tasks] = of(doc, 'list');
    expect(bullets!.items.map((i) => [i.depth, i.text])).toEqual([[0, 'apple'], [1, 'green'], [1, 'red'], [0, 'pear']]);
    expect(bullets!.text).toBe('- apple\n  - green\n  - red\n- pear');
    expect(ordered!.ordered).toBe(true);
    expect(ordered!.text).toBe('1. first\n2. second');
    expect(tasks!.items.map((i) => i.checked)).toEqual([true, false]);
    expect(tasks!.text).toBe('- [x] done\n- [ ] todo');
  });

  it('extracts GFM tables with header and rows', async () => {
    const doc = await ok('| Name | Role |\n|------|------|\n| Rama | King |\n| Sita | Queen |\n');
    const [table] = of(doc, 'table');
    expect(table!.header).toEqual(['Name', 'Role']);
    expect(table!.rows).toEqual([['Rama', 'King'], ['Sita', 'Queen']]);
    expect(table!.text).toBe('Name | Role\nRama | King\nSita | Queen');
  });

  it('keeps code fences verbatim with their language', async () => {
    const doc = await ok('```python\ndef f():\n    return "# not a heading"\n```\n\n```\nplain\n```\n');
    const [py, plain] = of(doc, 'code');
    expect(py).toMatchObject({ language: 'python', text: 'def f():\n    return "# not a heading"' });
    expect(plain).toMatchObject({ language: null, text: 'plain' });
    expect(of(doc, 'heading')).toHaveLength(0);
  });

  it('captures inline links (inline and reference style) and keeps inline code', async () => {
    const doc = await ok('See [the docs](https://example.org/docs) and [ref link][r] with `code()` and **bold**.\n\n[r]: https://example.org/ref\n');
    const [p] = of(doc, 'paragraph');
    expect(p!.text).toBe('See the docs and ref link with `code()` and bold.');
    expect(p!.links).toEqual([
      { text: 'the docs', href: 'https://example.org/docs' },
      { text: 'ref link', href: 'https://example.org/ref' },
    ]);
  });

  it('keeps Devanagari and emoji intact in headings, paragraphs and tables', async () => {
    const doc = await ok('# रामायण 📖\n\nरामो विग्रहवान् धर्मः।\n\n| शब्द | अर्थ |\n|---|---|\n| धर्मः | duty |\n');
    expect(doc.blocks[0]!.text).toBe('रामायण 📖');
    expect(of(doc, 'paragraph')[0]!.text).toBe('रामो विग्रहवान् धर्मः।');
    expect(of(doc, 'table')[0]!.rows[0]).toEqual(['धर्मः', 'duty']);
    expect(doc.text).not.toContain('�');
  });

  it('reports offsets that point at the block in the original source', async () => {
    const source = '﻿# Title\n\nFirst paragraph.\n\n## Part\n\n- a\n- b\n\n```js\ncode\n```\n';
    const doc = await ok(source);
    const decoded = source.slice(1); // BOM removed, as documented
    for (const block of doc.blocks) {
      const slice = decoded.slice(block.offsets!.start, block.offsets!.end);
      const needle = block.kind === 'list' ? '- a' : block.text.split('\n')[0]!;
      expect(slice, `${block.kind}: ${block.text}`).toContain(needle);
    }
  });

  it('skips front matter but says so', async () => {
    const result = await markdownExtractor.extract({ bytes: enc('---\ntitle: Secret\n---\n\n# Real\n\nbody'), filename: null }, DEFAULT_EXTRACTION_LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.text).not.toContain('Secret');
    expect(result.document.warnings.map((w) => w.code)).toContain('FRONT_MATTER_SKIPPED');
    expect(result.document.metadata.title).toBe('Real');
  });

  it('keeps raw HTML as literal text and flags it', async () => {
    const doc = await ok('<div class="note">Raw html</div>\n\nafter');
    expect(doc.blocks[0]!.text).toContain('Raw html');
    expect(doc.warnings.map((w) => w.code)).toContain('HTML_PRESERVED_RAW');
  });

  it('fails explicitly when there is no content', async () => {
    for (const source of ['', '   \n', '---\n']) {
      const result = await markdownExtractor.extract({ bytes: enc(source), filename: null }, DEFAULT_EXTRACTION_LIMITS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NO_EXTRACTABLE_TEXT');
    }
  });

  it('does not flatten the document into one string: block kinds stay distinct', async () => {
    const doc = await ok('# H\n\npara\n\n- li\n\n| a |\n|---|\n| b |\n\n```\nc\n```\n');
    expect(doc.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'table', 'code']);
  });
});
