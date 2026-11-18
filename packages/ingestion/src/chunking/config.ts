import { sha256Hex } from '@narada/shared';
import type { TokenCounter } from './tokens';

/** Bump when chunking behaviour changes in a way that alters output for the same input and config. */
export const CHUNKER_VERSION = 'structural-v1';

export interface ChunkingConfig {
  /** Soft size: a chunk is closed before a block would push it past this. */
  targetTokens: number;
  /** Hard cap: blocks larger than this are split deterministically. */
  maxTokens: number;
  /** Tail of the previous chunk repeated at the start of the next one (same section only). */
  overlapTokens: number;
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = { targetTokens: 350, maxTokens: 500, overlapTokens: 60 };

export function validateChunkingConfig(config: ChunkingConfig): ChunkingConfig {
  const { targetTokens, maxTokens, overlapTokens } = config;
  const ints = [targetTokens, maxTokens, overlapTokens].every((n) => Number.isInteger(n));
  if (!ints) throw new Error('Chunking configuration values must be integers.');
  if (targetTokens < 20) throw new Error('targetTokens must be at least 20.');
  if (maxTokens < targetTokens) throw new Error('maxTokens must be >= targetTokens.');
  if (overlapTokens < 0 || overlapTokens >= targetTokens) throw new Error('overlapTokens must be >= 0 and < targetTokens.');
  return config;
}

/** The exact settings that produced a chunk set, stored on the document version for reproducibility. */
export function describeChunking(config: ChunkingConfig, counter: TokenCounter) {
  return { chunkerVersion: CHUNKER_VERSION, ...config, tokenCounter: counter.name };
}

export function chunkingConfigHash(config: ChunkingConfig, counter: TokenCounter): string {
  return sha256Hex(JSON.stringify(describeChunking(config, counter))).slice(0, 16);
}
