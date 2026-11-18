# 0010 — Normalized document model and extraction policy

Status: accepted

**Decision.** Every extractor implements `Extractor` and returns an `ExtractedDocument`: ordered blocks (`heading`,
`paragraph`, `list`, `table`, `code`), each with an optional page number and exact offsets, plus document metadata, a
per-page summary, and structured warnings. Failures are values, not exceptions: `{ ok: false, error: { code, message,
details }, warnings }`. The chunker and the pipeline see only this model.

**Policies.**
- *Never succeed silently on missing content.* Image-only pages are detected (blank vs image from the PDF operator list). If at
  least `ocrRequiredPageRatio` (0.5) of pages are image-only the PDF fails with `OCR_REQUIRED`; all-blank PDFs fail with
  `NO_EXTRACTABLE_TEXT`; smaller numbers of such pages are listed in warnings.
- *Never invent metadata.* A title comes only from the PDF information dictionary or the first Markdown H1; otherwise it is
  `null` and the document keeps its filename-derived title, marked `titleOrigin = filename`.
- *Never alter text silently.* No Unicode normalization. Invalid UTF-8 is replaced with U+FFFD **and counted in a warning**; mostly
  undecodable or NUL-containing input is rejected. Markdown raw HTML is kept as literal text and flagged.
- *Safe PDF handling.* pdfjs-dist 6 (no dynamic code evaluation exists in this version), a private copy of the buffer
  (pdf.js detaches the one it is given), password-protected files are refused with `ENCRYPTED_PDF` and no password is ever tried,
  and page-count, byte, extracted-text and time limits apply.
- *Reading order.* PDF text stays in content-stream order. Re-sorting by coordinates would interleave columns.
- *OCR later.* It will be another extractor, or a fallback inside the PDF extractor for pages classified `image_only`.

**Offsets.** TXT/Markdown: UTF-16 indices into the decoded text (BOM removed, original line endings untouched). PDF:
page-relative, into that page's blocks joined by blank lines.

**Rejected.** Dehyphenation (ambiguous), column detection (out of scope), converting Markdown to HTML first (loses structure).
