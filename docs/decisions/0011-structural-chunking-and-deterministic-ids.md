# 0011 — Structural chunking and deterministic chunk ids

Status: accepted

**Decision.**
- A chunk **never crosses a heading**, so each chunk belongs to exactly one section and carries its heading path and an
  ordinal `section_id`. Page boundaries are **not** hard breaks (a paragraph often continues over a page); a chunk records
  its page range instead.
- Blocks stay whole when they fit. Only blocks over `maxTokens` are split, deterministically: sentences → lines → words →
  grapheme clusters, so combining marks, conjuncts and emoji sequences are never separated. Tables repeat their header on each
  part; code splits on lines.
- Overlap repeats the tail of the previous chunk at sentence (else word) boundaries, within the same section only, never for
  code or tables, and is dropped rather than letting a chunk exceed `maxTokens`.
- Sentence detection is a plain regex (ASCII terminators, ellipsis, danda `।` and double danda `॥`), not ICU, so output does
  not drift with the runtime.
- Token counting is behind `TokenCounter`. The default is a script-aware estimate; Indic scripts are weighted conservatively.
- Chunk id = deterministic UUID of `(documentVersionId, chunkerVersion, configHash, chunkIndex, contentSha256)`. Identical
  input and configuration give identical ids, versions never share ids, and `replaceChunks` leaves identical sets untouched, so
  retries create no duplicates and preserve anything later attached (embeddings).
- Offsets have **block granularity**. They bound the blocks a chunk draws from; they do not claim character precision.

**Consequences.** Very short sections become very small chunks (no merging across headings). Changing any chunking setting
changes the config hash and therefore all ids for new ingestions.
