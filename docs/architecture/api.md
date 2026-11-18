# API contracts (v1)

All bodies are JSON unless noted. Every response carries an `x-request-id` header (client-supplied
value is honoured if it is a valid UUID or ≤ 64 safe characters, otherwise generated).

## Error envelope

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "requestId": "…", "details": {} } }
```

| HTTP | code examples |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_FILE_TYPE`, `CHECKSUM_MISMATCH` |
| 403 | `INDEXING_NOT_PERMITTED` |
| 404 | `SOURCE_NOT_FOUND`, `DOCUMENT_NOT_FOUND` |
| 409 | `SOURCE_ALREADY_EXISTS` (includes `existingSourceId`), `RETRY_NOT_ALLOWED` |
| 413 | `FILE_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` (no internals leaked) |
| 502 | `EMBEDDING_PROVIDER_ERROR` (search-time query embedding failure) |

## GET /health, GET /health/ready

`/health` → `200 {"status":"ok"}` (process alive). `/health/ready` → `200` or `503` with per-dependency
status for PostgreSQL and Redis.

## POST /v1/sources

```json
{
  "title": "Valmiki Ramayana, Book 1",          // required
  "author": "Valmiki",                          // optional, never defaulted
  "publisher": null,
  "sourceType": "scripture",                    // required
  "originalUrl": "https://example.org/…",       // optional
  "originalLanguage": "sa",                     // optional BCP-47
  "publicationDate": "1891",                    // optional YYYY | YYYY-MM | YYYY-MM-DD
  "edition": null,
  "license": { "kind": "public_domain", "url": null, "notes": "Translator died 1920." },
  "permissions": { "allowIndexing": true, "allowQuotation": true, "allowRedistribution": true },
  "contentChecksum": null                       // optional declared sha256
}
```

→ `201 { "source": { id, …all fields…, createdAt, updatedAt } }`. Duplicate → `409 SOURCE_ALREADY_EXISTS`.

## POST /v1/documents (multipart/form-data)

Fields: `sourceId` (required UUID), `title`, `language` (BCP-47), `documentId` (UUID; supply to add a new version to an
existing document of the same source), `file` (required, exactly one; `.pdf`, `.txt`, `.md`, `.markdown`; max `MAX_UPLOAD_BYTES`,
default 25 MiB). Unknown fields are rejected. Without `title`, the filename stem is used and `titleOrigin` is `filename`; if
there is neither, the request is rejected (nothing is invented).

The upload is validated by extension **and** content before anything is stored: PDFs must contain `%PDF-`; text files must be
valid text with no NUL bytes and no executable/archive/image signature; the declared Content-Type must be consistent.

- New content → `202 { document, version, job, deduplicated: false }`, job `PENDING`. Extraction happens asynchronously in the worker.
- Identical bytes already registered for this source → `200 { …, deduplicated: true }` with the existing rows and the job's current state. Nothing is created.
- `400 VALIDATION_ERROR` bad/missing fields, non-multipart body, wrong part name · `400 INVALID_FILE_TYPE` · `400 CHECKSUM_MISMATCH`
  (source declared a checksum) · `403 INDEXING_NOT_PERMITTED` · `404 SOURCE_NOT_FOUND` / `DOCUMENT_NOT_FOUND` · `413 FILE_TOO_LARGE`.

## GET /v1/documents/:id

```json
{
  "document": { "id", "sourceId", "title", "titleOrigin": "declared|extracted|filename", "originalLanguage", "createdAt", "updatedAt" },
  "latestVersion": {
    "id", "versionNumber", "contentSha256", "byteSize", "mimeType", "originalFilename",
    "pageCount", "extractedTitle", "detectedLanguage",
    "extraction": null | {
      "method": "pdf-text@1.0.0+pdfjs-6.5.438",
      "status": "ok" | "failed",
      "warnings": [ { "code": "EMPTY_PAGES", "message": "…", "pages": [2] } ],
      "pages": { "total": 3, "text": 2, "blank": [2], "imageOnly": [] } | null
    },
    "chunking": null | { "chunkerVersion": "structural-v1", "targetTokens": 350, "maxTokens": 500, "overlapTokens": 60, "tokenCounter": "approx-script-aware-v1" },
    "createdAt"
  },
  "latestJob": null | {
    "id", "documentVersionId", "retryOfJobId",
    "status": "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED",
    "stage": null | "extract" | "chunk" | "store",
    "attempt",
    "error": null | { "code", "message", "details" },
    "queuedAt", "startedAt", "finishedAt"
  },
  "chunkCount": 0,
  "versions": [ { "id", "versionNumber", "createdAt" } ]
}
```

`extraction` is `null` until a worker has attempted the version. `COMPLETED` is only reported after the chunks are stored.
`400` for a malformed id, `404 DOCUMENT_NOT_FOUND` for an unknown one.

### Job error codes

| Code | Meaning | Typical recovery |
|---|---|---|
| `OCR_REQUIRED` | Scanned PDF (image-only pages ≥ 50 %). `details` lists the pages | Provide a text PDF; OCR is not supported |
| `ENCRYPTED_PDF` | Password required | Provide an unprotected copy |
| `MALFORMED_DOCUMENT` | Truncated or corrupt PDF / unparseable Markdown | Re-upload a valid file |
| `NO_EXTRACTABLE_TEXT` | Blank document | — |
| `INVALID_ENCODING` | Binary or mostly undecodable text | Re-save as UTF-8 |
| `LIMIT_EXCEEDED` / `EXTRACTION_TIMEOUT` | Page, size, text or time limit | Raise the limit or split the file |
| `NO_CHUNKS` | Only headings, no body text | — |
| `BLOB_MISSING` / `BLOB_INTEGRITY_ERROR` | Stored original missing or altered | Restore the blob, then retry |
| `CHUNK_PERSISTENCE_FAILED` | Storing chunks failed (message names the database error, never SQL or content) | Retry |
| `WORKER_LOST` | Worker died and attempts ran out | Retry |
| `INTERNAL_ERROR` | Unexpected | Retry; inspect worker logs |

## POST /v1/documents/:id/retry

Allowed only when the latest job is `FAILED`. Creates a **new** job linked by `retryOfJobId`; the failed job stays as history.
→ `202 { job }`. `409 RETRY_NOT_ALLOWED` if the latest job is `PENDING`, `PROCESSING` or `COMPLETED`, or a retry is already queued;
`404 DOCUMENT_NOT_FOUND`.

## POST /v1/search

```json
{
  "query": "Why did Rama accept exile?",         // 1–2000 chars
  "mode": "hybrid",                              // "semantic" | "keyword" | "hybrid" (default)
  "limit": 10,                                   // 1–50
  "filters": { "sourceIds": ["…"], "documentIds": ["…"], "language": "en" }
}
```

```json
{
  "query": "…", "mode": "hybrid",
  "embeddingModel": { "provider": "openai", "model": "text-embedding-3-small", "dimensions": 1536 },
  "results": [{
    "chunkId": "…", "documentId": "…", "documentVersionId": "…",
    "sourceId": "…", "sourceTitle": "…", "sourceAuthor": null, "edition": null,
    "originalUrl": null, "license": "public_domain",
    "passage": "…", "passageWithheld": false,
    "location": { "pageStart": 12, "pageEnd": 12, "headingPath": ["Chapter 2"], "locator": { "kind": "page", "page": 12 } },
    "score": 0.83,
    "scores": { "semantic": 0.83, "keyword": null, "fused": null },
    "contentRole": "retrieved_passage"
  }],
  "timingMs": 41
}
```

Semantic `score` = cosine similarity (1 − cosine distance). Keyword = `ts_rank_cd`. Hybrid = reciprocal-rank
fusion score (not comparable across modes; each mode reports its own raw scores under `scores`).
Only the latest COMPLETED version of each document is searched. When `allowQuotation` is false,
`passage` is `null` and `passageWithheld` is `true`; the citation is still returned.
`contentRole: "retrieved_passage"` marks the text as untrusted data for any downstream consumer.
