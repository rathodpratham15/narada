/**
 * Normalized document representation. Every extractor, whatever the input format, produces this, and the
 * chunker consumes only this. Adding a format means adding an extractor, nothing downstream changes.
 */

export type DocumentFormat = 'pdf' | 'txt' | 'markdown';

/**
 * What block offsets are relative to.
 * - `document_text`: UTF-16 code-unit indices into the decoded source text (BOM removed, newlines untouched).
 * - `page_text`: UTF-16 indices into that page's normalized text (blocks joined by "\n\n"), page-local.
 */
export type OffsetBasis = 'document_text' | 'page_text';

export interface Offsets {
  /** Inclusive start, exclusive end. UTF-16 code units. */
  start: number;
  end: number;
}

export interface Link {
  text: string;
  href: string;
}

interface BlockBase {
  /** 1-based page number when the format has pages (PDF), otherwise null. */
  page: number | null;
  /** Position of the whole block in the original; null when the format cannot provide one. */
  offsets: Offsets | null;
}

export interface HeadingBlock extends BlockBase {
  kind: 'heading';
  level: number;
  text: string;
  links?: Link[];
}

export interface ParagraphBlock extends BlockBase {
  kind: 'paragraph';
  text: string;
  links?: Link[];
}

export interface ListItem {
  text: string;
  /** 0 for top-level items. */
  depth: number;
  /** GFM task-list state, or null for ordinary items. */
  checked: boolean | null;
}

export interface ListBlock extends BlockBase {
  kind: 'list';
  ordered: boolean;
  items: ListItem[];
  /** Plain rendering of the whole list (one item per line, indented by depth). */
  text: string;
  links?: Link[];
}

export interface TableBlock extends BlockBase {
  kind: 'table';
  header: string[];
  rows: string[][];
  /** Plain rendering: cells joined by " | ", one row per line. */
  text: string;
  links?: Link[];
}

export interface CodeBlock extends BlockBase {
  kind: 'code';
  language: string | null;
  text: string;
}

export type Block = HeadingBlock | ParagraphBlock | ListBlock | TableBlock | CodeBlock;

export type PageKind = 'text' | 'blank' | 'image_only';

export interface PageInfo {
  page: number;
  kind: PageKind;
  /** Non-whitespace characters extracted from the page. */
  charCount: number;
}

export type ExtractionWarningCode =
  | 'EMPTY_PAGES'
  | 'IMAGE_ONLY_PAGES'
  | 'INVALID_ENCODING_REPLACED'
  | 'CONTROL_CHARACTERS_REMOVED'
  | 'FRONT_MATTER_SKIPPED'
  | 'HTML_PRESERVED_RAW'
  | 'UNSUPPORTED_MARKDOWN_NODE'
  | 'PDF_METADATA_UNREADABLE';

export interface ExtractionWarning {
  code: ExtractionWarningCode;
  message: string;
  /** Pages the warning applies to, when page-specific. */
  pages?: number[];
  details?: Record<string, unknown>;
}

export interface ExtractedDocument {
  format: DocumentFormat;
  /** e.g. `pdf-text@1.0.0+pdfjs-6.5.438`. Stored on every chunk as its extraction method. */
  extractionMethod: string;
  offsetBasis: OffsetBasis;
  metadata: {
    /** Only ever set from the document itself (PDF info dictionary, first Markdown H1); never guessed. */
    title: string | null;
    author: string | null;
    pageCount: number | null;
    /** Text encoding detected for TXT/Markdown. */
    encoding: string | null;
  };
  /** Per-page summary (PDF only; empty for other formats). */
  pages: PageInfo[];
  /** Ordered content blocks. */
  blocks: Block[];
  /** All block text joined by blank lines. */
  text: string;
  warnings: ExtractionWarning[];
}

export const EXTRACTION_ERROR_CODES = [
  'OCR_REQUIRED',
  'ENCRYPTED_PDF',
  'MALFORMED_DOCUMENT',
  'NO_EXTRACTABLE_TEXT',
  'INVALID_ENCODING',
  'LIMIT_EXCEEDED',
  'EXTRACTION_TIMEOUT',
  'EXTRACTION_FAILED',
] as const;

export type ExtractionErrorCode = (typeof EXTRACTION_ERROR_CODES)[number];

export interface ExtractionError {
  code: ExtractionErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ExtractionResult =
  | { ok: true; document: ExtractedDocument }
  | { ok: false; error: ExtractionError; warnings: ExtractionWarning[] };

export interface ExtractionLimits {
  maxBytes: number;
  maxPages: number;
  /** Upper bound on extracted characters, guarding against decompression-bomb style inputs. */
  maxTextChars: number;
  timeoutMs: number;
  /**
   * PDFs where at least this fraction of pages are image-only fail with OCR_REQUIRED instead of
   * silently indexing the minority that has text.
   */
  ocrRequiredPageRatio: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxPages: 2000,
  maxTextChars: 20_000_000,
  timeoutMs: 60_000,
  ocrRequiredPageRatio: 0.5,
};

export interface ExtractInput {
  bytes: Uint8Array;
  filename: string | null;
}

/** Contract every format implements. OCR will be a further extractor or a fallback inside the PDF one. */
export interface Extractor {
  readonly format: DocumentFormat;
  readonly extractionMethod: string;
  extract(input: ExtractInput, limits: ExtractionLimits): Promise<ExtractionResult>;
}

export function failure(
  code: ExtractionErrorCode,
  message: string,
  warnings: ExtractionWarning[] = [],
  details?: Record<string, unknown>,
): ExtractionResult {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) }, warnings };
}

export function plainTextOf(blocks: Block[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}
