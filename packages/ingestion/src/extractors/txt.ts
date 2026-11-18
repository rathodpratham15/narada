import { decodeText } from '../text-decoding';
import {
  failure,
  plainTextOf,
  type Block,
  type ExtractInput,
  type ExtractionLimits,
  type ExtractionResult,
  type Extractor,
} from '../model';

export const TXT_EXTRACTION_METHOD = 'txt-paragraphs@1.0.0';

const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * Splits text into paragraphs (runs of non-blank lines) and records each paragraph's exact position in the
 * decoded text. Paragraph text is the exact source slice except that line endings are normalised to "\n".
 * Single line breaks inside a paragraph are kept, because they are meaningful in verse and addresses.
 */
export function splitParagraphs(text: string): Array<{ text: string; start: number; end: number }> {
  const paragraphs: Array<{ text: string; start: number; end: number }> = [];
  let start = -1;
  let end = -1;

  const flush = () => {
    if (start === -1) return;
    paragraphs.push({ text: text.slice(start, end).replace(/\r\n|\r/g, '\n'), start, end });
    start = -1;
    end = -1;
  };

  let lineStart = 0;
  const visit = (lineEnd: number, nextStart: number) => {
    if (text.slice(lineStart, lineEnd).trim() === '') {
      flush();
    } else {
      if (start === -1) start = lineStart;
      end = lineEnd;
    }
    lineStart = nextStart;
  };

  for (const match of text.matchAll(LINE_BREAK)) {
    visit(match.index, match.index + match[0].length);
  }
  visit(text.length, text.length);
  flush();
  return paragraphs;
}

export const txtExtractor: Extractor = {
  format: 'txt',
  extractionMethod: TXT_EXTRACTION_METHOD,

  async extract(input: ExtractInput, limits: ExtractionLimits): Promise<ExtractionResult> {
    if (input.bytes.length > limits.maxBytes) {
      return failure('LIMIT_EXCEEDED', `File exceeds the ${limits.maxBytes}-byte limit.`, [], { maxBytes: limits.maxBytes });
    }
    const decoded = decodeText(input.bytes);
    if (!decoded.ok) return failure('INVALID_ENCODING', decoded.message, [], decoded.details);

    const blocks: Block[] = splitParagraphs(decoded.text).map((p) => ({
      kind: 'paragraph',
      text: p.text,
      page: null,
      offsets: { start: p.start, end: p.end },
    }));
    if (blocks.length === 0) {
      return failure('NO_EXTRACTABLE_TEXT', 'The file contains no text.', decoded.warnings);
    }
    return {
      ok: true,
      document: {
        format: 'txt',
        extractionMethod: TXT_EXTRACTION_METHOD,
        offsetBasis: 'document_text',
        metadata: { title: null, author: null, pageCount: null, encoding: decoded.encoding },
        pages: [],
        blocks,
        text: plainTextOf(blocks),
        warnings: decoded.warnings,
      },
    };
  },
};
