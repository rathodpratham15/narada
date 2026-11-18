import { deterministicUuid, sha256Hex } from '@narada/shared';
import type { ChunkLocator } from '@narada/database';
import type { Block, ExtractedDocument, Offsets, OffsetBasis } from '../model';
import {
  CHUNKER_VERSION,
  DEFAULT_CHUNKING_CONFIG,
  chunkingConfigHash,
  validateChunkingConfig,
  type ChunkingConfig,
} from './config';
import { splitOversized, tailWithin, type Level } from './splitting';
import { approxTokenCounter, type TokenCounter } from './tokens';

export interface ChunkContext {
  sourceId: string;
  documentId: string;
  documentVersionId: string;
}

/** A chunk ready to persist. Everything needed to cite it later is carried here. */
export interface ChunkDraft {
  id: string;
  sourceId: string;
  documentId: string;
  documentVersionId: string;
  chunkIndex: number;
  content: string;
  contentSha256: string;
  tokenEstimate: number;
  headingPath: string[];
  sectionId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number | null;
  charEnd: number | null;
  offsetBasis: OffsetBasis | null;
  locator: ChunkLocator;
  extractionMethod: string;
  chunkerVersion: string;
  chunkingConfigHash: string;
}

interface Unit {
  text: string;
  tokens: number;
  kind: Block['kind'];
  page: number | null;
  offsets: Offsets | null;
  /** True for the 2nd+ pieces of a block that had to be split. */
  continuation: boolean;
}

interface Section {
  headingPath: string[];
  sectionId: string | null;
  units: Unit[];
}

interface Overlap {
  text: string;
  tokens: number;
  from: Unit;
}

interface Draft {
  units: Unit[];
  overlap: Overlap | null;
  tokens: number;
}

/** Cost of the blank line that joins two blocks. */
const JOIN_TOKENS = 1;

function cleanPiece(text: string): string {
  return text.replace(/^\n+/, '').trimEnd();
}

function startLevel(kind: Block['kind']): Level {
  return kind === 'paragraph' || kind === 'heading' ? 'sentences' : 'lines';
}

function unitsForBlock(block: Block, config: ChunkingConfig, counter: TokenCounter): Unit[] {
  const whole = counter.count(block.text);
  const base = { kind: block.kind, page: block.page, offsets: block.offsets };
  if (whole <= config.maxTokens) return [{ ...base, text: block.text, tokens: whole, continuation: false }];

  let pieces = splitOversized(block.text, startLevel(block.kind), config.targetTokens, config.maxTokens, counter)
    .map(cleanPiece)
    .filter((piece) => piece.length > 0);

  if (block.kind === 'table') {
    // Keep the header with every part so each chunk is self-describing, when it fits.
    const header = block.header.join(' | ');
    const headerTokens = counter.count(header);
    pieces = pieces.map((piece, i) =>
      i > 0 && piece !== header && headerTokens + counter.count(piece) <= config.maxTokens ? `${header}\n${piece}` : piece,
    );
  }
  return pieces.map((text, i) => ({ ...base, text, tokens: counter.count(text), continuation: i > 0 }));
}

function buildSections(blocks: Block[], config: ChunkingConfig, counter: TokenCounter): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let ordinals: number[] = [];
  let current: Section = { headingPath: [], sectionId: null, units: [] };

  const commit = () => {
    if (current.units.length > 0) sections.push(current);
  };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      commit();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= block.level) stack.pop();
      stack.push({ level: block.level, text: block.text });
      const depth = stack.length - 1;
      ordinals = ordinals.slice(0, depth + 1);
      while (ordinals.length < depth) ordinals.push(1);
      ordinals[depth] = (ordinals[depth] ?? 0) + 1;
      current = { headingPath: stack.map((h) => h.text), sectionId: ordinals.join('.'), units: [] };
      continue;
    }
    current.units.push(...unitsForBlock(block, config, counter));
  }
  commit();
  return sections;
}

function overlapFrom(draft: Draft, config: ChunkingConfig, counter: TokenCounter): Overlap | null {
  if (config.overlapTokens === 0) return null;
  const last = draft.units[draft.units.length - 1];
  // Code and tables are never overlapped: repeating half a table or function misleads more than it helps.
  if (!last || (last.kind !== 'paragraph' && last.kind !== 'list')) return null;
  const text = tailWithin(last.text, config.overlapTokens, counter);
  return text ? { text, tokens: counter.count(text), from: last } : null;
}

function joinBefore(unit: Unit): string {
  if (!unit.continuation) return '\n\n';
  return unit.kind === 'paragraph' ? ' ' : '\n';
}

function assemble(draft: Draft): string {
  let content = draft.overlap?.text ?? '';
  draft.units.forEach((unit, i) => {
    const separator = i === 0 && !draft.overlap ? '' : joinBefore(unit);
    content += separator + unit.text;
  });
  return content.trim();
}

function chunkSection(section: Section, config: ChunkingConfig, counter: TokenCounter): Draft[] {
  const drafts: Draft[] = [];
  let state: Draft = { units: [], overlap: null, tokens: 0 };

  for (const unit of section.units) {
    const cost = unit.tokens + (state.units.length > 0 || state.overlap ? JOIN_TOKENS : 0);
    if (state.units.length > 0 && state.tokens + cost > config.targetTokens) {
      drafts.push(state);
      let overlap = overlapFrom(state, config, counter);
      if (overlap && overlap.tokens + JOIN_TOKENS + unit.tokens > config.maxTokens) overlap = null;
      state = { units: [], overlap, tokens: overlap?.tokens ?? 0 };
    }
    state.tokens += unit.tokens + (state.units.length > 0 || state.overlap ? JOIN_TOKENS : 0);
    state.units.push(unit);
  }
  if (state.units.length > 0) drafts.push(state);
  return drafts;
}

function locate(draft: Draft, basis: OffsetBasis) {
  const covered = [...(draft.overlap ? [draft.overlap.from] : []), ...draft.units];
  const pages = covered.map((u) => u.page).filter((p): p is number => p !== null);
  const pageStart = pages.length ? Math.min(...pages) : null;
  const pageEnd = pages.length ? Math.max(...pages) : null;

  const withOffsets = covered.filter((u): u is Unit & { offsets: Offsets } => u.offsets !== null);
  if (withOffsets.length !== covered.length || withOffsets.length === 0) {
    return { pageStart, pageEnd, charStart: null, charEnd: null, offsetBasis: null };
  }
  const first = basis === 'page_text' ? withOffsets.filter((u) => u.page === pageStart) : withOffsets;
  const last = basis === 'page_text' ? withOffsets.filter((u) => u.page === pageEnd) : withOffsets;
  return {
    pageStart,
    pageEnd,
    charStart: Math.min(...first.map((u) => u.offsets.start)),
    charEnd: Math.max(...last.map((u) => u.offsets.end)),
    offsetBasis: basis,
  };
}

/**
 * Structure-aware chunking. Rules:
 * - A chunk never crosses a heading, so every chunk belongs to exactly one section and carries its heading path.
 * - Blocks stay whole whenever they fit; paragraphs, lists, tables and code are only split when over `maxTokens`.
 * - Overlap repeats the tail of the previous chunk, inside the same section only, and never for code or tables.
 * - Pure function: the same document, context and configuration always yield identical chunks and ids.
 * Offsets have block granularity: they bound the blocks a chunk draws from, not the exact characters.
 */
export function chunkDocument(
  document: ExtractedDocument,
  context: ChunkContext,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG,
  counter: TokenCounter = approxTokenCounter,
): ChunkDraft[] {
  validateChunkingConfig(config);
  const configHash = chunkingConfigHash(config, counter);
  const chunks: ChunkDraft[] = [];

  for (const section of buildSections(document.blocks, config, counter)) {
    for (const draft of chunkSection(section, config, counter)) {
      const content = assemble(draft);
      if (!content) continue;
      const position = locate(draft, document.offsetBasis);
      const chunkIndex = chunks.length;
      const contentSha256 = sha256Hex(content);

      let locator: ChunkLocator;
      if (position.pageStart !== null && position.pageEnd !== null) {
        locator =
          position.pageStart === position.pageEnd
            ? { kind: 'page', page: position.pageStart }
            : { kind: 'page_range', pageStart: position.pageStart, pageEnd: position.pageEnd };
      } else if (position.charStart !== null && position.charEnd !== null) {
        locator = { kind: 'text_range', start: position.charStart, end: position.charEnd };
      } else {
        locator = { kind: 'section', headingPath: section.headingPath };
      }

      chunks.push({
        id: deterministicUuid(context.documentVersionId, CHUNKER_VERSION, configHash, String(chunkIndex), contentSha256),
        ...context,
        chunkIndex,
        content,
        contentSha256,
        tokenEstimate: Math.max(1, counter.count(content)),
        headingPath: section.headingPath,
        sectionId: section.sectionId,
        ...position,
        locator,
        extractionMethod: document.extractionMethod,
        chunkerVersion: CHUNKER_VERSION,
        chunkingConfigHash: configHash,
      });
    }
  }
  return chunks;
}
