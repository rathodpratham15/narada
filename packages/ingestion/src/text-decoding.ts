import type { ExtractionWarning } from './model';

export type TextEncodingName = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

export type DecodeResult =
  | { ok: true; text: string; encoding: TextEncodingName; warnings: ExtractionWarning[] }
  | { ok: false; message: string; details: Record<string, unknown> };

/** If more than this share of characters had to be replaced, the input is not text in this encoding. */
const MAX_REPLACEMENT_RATIO = 0.1;

/**
 * Decodes TXT/Markdown bytes. Never silently loses data:
 * - BOMs select the encoding (UTF-8, UTF-16 LE/BE) and are removed from the text.
 * - Strict UTF-8 is tried first. If the bytes are not valid UTF-8, invalid sequences become U+FFFD and
 *   the count is reported as a warning; the untouched original stays in the blob store.
 * - Input that is mostly undecodable, or contains NUL bytes without a UTF-16 BOM, is rejected as binary.
 * No Unicode normalization is applied, so Devanagari and other scripts are preserved exactly.
 */
export function decodeText(bytes: Uint8Array): DecodeResult {
  let encoding: TextEncodingName = 'utf-8';
  let body = bytes;

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8-bom';
    body = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    body = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    body = bytes.subarray(2);
  }

  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(body);
      return { ok: true, text, encoding, warnings: [] };
    } catch {
      return {
        ok: false,
        message: `The file has a ${encoding.toUpperCase()} byte-order mark but is not valid ${encoding.toUpperCase()}.`,
        details: { encoding },
      };
    }
  }

  const nulIndex = body.indexOf(0);
  if (nulIndex !== -1) {
    return {
      ok: false,
      message: 'The file contains NUL bytes, so it is binary data rather than UTF-8 text.',
      details: { firstNulByteOffset: nulIndex + (encoding === 'utf-8-bom' ? 3 : 0) },
    };
  }

  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding, warnings: [] };
  } catch {
    // Not valid UTF-8: decode leniently and account for every replacement.
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
  let replaced = 0;
  let firstIndex = -1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) {
      replaced++;
      if (firstIndex === -1) firstIndex = i;
    }
  }
  if (replaced / Math.max(text.length, 1) > MAX_REPLACEMENT_RATIO) {
    return {
      ok: false,
      message: 'The file is not valid UTF-8 and most of it cannot be decoded; it may be binary or use another encoding.',
      details: { replacedCharacters: replaced, totalCharacters: text.length },
    };
  }
  return {
    ok: true,
    text,
    encoding,
    warnings: [
      {
        code: 'INVALID_ENCODING_REPLACED',
        message: `${replaced} invalid UTF-8 byte sequence(s) were replaced with U+FFFD. The original bytes are preserved in storage.`,
        details: { replacedCharacters: replaced, firstReplacementOffset: firstIndex },
      },
    ],
  };
}
