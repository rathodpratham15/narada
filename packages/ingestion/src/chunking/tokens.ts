/**
 * Token counting is an abstraction so the chunker can follow whichever embedding provider and tokenizer is in
 * use. Counts are estimates unless the implementation is the provider's own tokenizer.
 */
export interface TokenCounter {
  /** Stable identifier; part of the chunking configuration hash, so changing it changes chunk ids. */
  readonly name: string;
  count(text: string): number;
}

/**
 * Script-aware estimate. Character counts badly under-estimate tokens for Indic scripts (a Devanagari
 * character, including its combining marks, is often a token or more), so each script gets its own weight:
 *   ASCII letters/digits/punctuation ≈ 0.28 tokens/char (≈ 3.5 chars per token)
 *   Latin-1 / Latin Extended letters ≈ 0.35
 *   Indic scripts (U+0900–U+0DFF)    ≈ 0.85  (deliberately conservative)
 *   CJK, Hangul, kana                ≈ 1.0
 *   everything else                  ≈ 0.6
 * Whitespace is nearly free. Replace with a real tokenizer behind this interface when embeddings land.
 */
export const approxTokenCounter: TokenCounter = {
  name: 'approx-script-aware-v1',
  count(text: string): number {
    let total = 0;
    for (const char of text) {
      const cp = char.codePointAt(0)!;
      if (cp <= 0x20) total += 0.03;
      else if (cp < 0x7f) total += 0.28;
      else if (cp < 0x250) total += 0.35;
      else if (cp >= 0x0900 && cp <= 0x0dff) total += 0.85;
      else if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af)) total += 1;
      else total += 0.6;
    }
    return text.length === 0 ? 0 : Math.max(1, Math.ceil(total));
  },
};
