import type { TokenCounter } from './tokens';

/**
 * Deterministic splitting of text that is too large for one chunk. Every splitter returns fragments whose
 * concatenation is exactly the input (whitespace is kept), so no content can be lost or altered.
 * Sentence detection is a plain regex (not ICU) so output does not vary with the Node/ICU version.
 */

export type Level = 'sentences' | 'lines' | 'words';

/** Sentence terminators: ASCII, ellipsis, Devanagari danda (।) and double danda (॥). */
const SENTENCE = /[\s\S]*?(?:[.!?…।॥]+["'”’)\]]*\s+|$)/gu;

function fragmentsBy(text: string, level: Level): string[] {
  const pattern = level === 'sentences' ? SENTENCE : level === 'lines' ? /[^\n]*(?:\n+|$)/g : /\S*\s*/g;
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length > 0) out.push(match[0]);
  }
  return out;
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

function graphemeFragments(text: string): string[] {
  return Array.from(graphemes.segment(text), (s) => s.segment);
}

const NEXT_LEVEL: Record<Level | 'graphemes', Level | 'graphemes'> = {
  sentences: 'lines',
  lines: 'words',
  words: 'graphemes',
  graphemes: 'graphemes',
};

/**
 * Packs fragments into pieces of roughly `target` tokens. A fragment larger than `max` is split with the next
 * finer level (sentences → lines → words → grapheme clusters), so combining marks are never separated.
 */
function pack(
  fragments: string[],
  level: Level | 'graphemes',
  target: number,
  max: number,
  counter: TokenCounter,
): string[] {
  const pieces: string[] = [];
  let current = '';
  let currentTokens = 0;
  const flush = () => {
    if (current) pieces.push(current);
    current = '';
    currentTokens = 0;
  };

  for (const fragment of fragments) {
    const tokens = counter.count(fragment);
    if (tokens > max && level !== 'graphemes') {
      flush();
      pieces.push(...splitAt(fragment, NEXT_LEVEL[level], target, max, counter));
      continue;
    }
    if (current && currentTokens + tokens > target) flush();
    current += fragment;
    currentTokens += tokens;
  }
  flush();
  return pieces;
}

function splitAt(text: string, level: Level | 'graphemes', target: number, max: number, counter: TokenCounter): string[] {
  if (counter.count(text) <= max) return [text];
  const fragments = level === 'graphemes' ? graphemeFragments(text) : fragmentsBy(text, level);
  if (fragments.length <= 1 && level !== 'graphemes') return splitAt(text, NEXT_LEVEL[level], target, max, counter);
  return pack(fragments, level, target, max, counter);
}

/**
 * Splits `text` into pieces of ≈ `target` tokens, each at most `max` (an indivisible grapheme cluster aside).
 * `levels` picks where to start: prose starts at sentences; code and tables start at lines.
 */
export function splitOversized(
  text: string,
  start: Level,
  target: number,
  max: number,
  counter: TokenCounter,
): string[] {
  return splitAt(text, start, target, max, counter);
}

/** Longest suffix of `text` of at most `maxTokens`, cut at a sentence (or, failing that, word) boundary. */
export function tailWithin(text: string, maxTokens: number, counter: TokenCounter): string {
  for (const level of ['sentences', 'words'] as const) {
    const fragments = fragmentsBy(text, level);
    let tail = '';
    for (let i = fragments.length - 1; i >= 0; i--) {
      const candidate = fragments[i]! + tail;
      if (counter.count(candidate) > maxTokens) break;
      tail = candidate;
    }
    // A tail equal to the whole text would make the overlap a full duplicate of its source block.
    if (tail.trim() && tail.length < text.length) return tail.trim();
  }
  return '';
}
